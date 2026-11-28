import type { BookMeta } from "../../core/types";
import type { FileStore } from "../../core/storage/FileStore";
import type { MetaStore } from "../../core/storage/MetaStore";
import { TRASH_DAYS, originalKey, type LibraryService } from "../../core/storage/LibraryService";
import { coldCandidates, findDuplicates } from "../../core/storage/cleanup";
import { formatBytes, type LibraryUsage } from "../../core/storage/StorageReport";
import { h } from "../dom";
import { confirmDialog, toast } from "../feedback";
import { freezeFlow, thawFlow } from "./cold";

/*
 * Stage 3 · v2.3 — "Dọn dẹp": the trash (30 days), cold storage, duplicates
 * and data the app can make again. Nothing here removes anything without
 * asking first.
 */

export interface CleanupDeps {
  meta: MetaStore;
  files: FileStore;
  library: LibraryService;
  clearIndex: () => Promise<void>;
  beforeFreeze: (id: string) => Promise<void>;
  /** Re-measure the page after a change. */
  changed: () => Promise<void>;
}

const day = (t: number) => new Date(t).toLocaleDateString("vi-VN");
const SHOW = 8;

export class CleanupCard {
  readonly trashEl = h("section", { class: "st-card", "data-testid": "st-trash" });
  readonly coldEl = h("section", { class: "st-card", "data-testid": "st-cold" });
  readonly dupEl = h("section", { class: "st-card", "data-testid": "st-dups" });
  private showAllCandidates = false;

  constructor(private readonly deps: CleanupDeps) {}

  async render(usage: LibraryUsage | null): Promise<void> {
    const all = await this.deps.library.listAll();
    const size = new Map(usage?.books.map((b) => [b.id, b]) ?? []);
    this.renderTrash(all.filter((b) => b.trashedAt).sort((a, b) => b.trashedAt! - a.trashedAt!), size);
    this.renderCold(all, size);
    this.renderDups(all, usage);
  }

  private row(title: string, meta: string, ...actions: HTMLElement[]): HTMLElement {
    return h("li", { class: "st-item" }, h("div", { class: "st-item-text" }, h("b", {}, title), h("span", { class: "muted small" }, meta)), h("div", { class: "st-item-actions" }, ...actions));
  }

  private btn(label: string, testid: string, run: () => Promise<unknown>, cls = ""): HTMLButtonElement {
    const b = h("button", { class: `btn btn-small ${cls}`, type: "button", "data-testid": testid }, label) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  // ---------------------------------------------------------------- trash

  private renderTrash(trash: BookMeta[], size: Map<string, { total: number }>): void {
    const total = trash.reduce((n, b) => n + (size.get(b.id)?.total ?? 0), 0);
    const left = (b: BookMeta) => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - b.trashedAt!) / 86_400_000));
    const items = trash.map((b) =>
      this.row(
        `${b.kind === "notebook" ? "📓 " : ""}${b.title}`,
        `xóa ngày ${day(b.trashedAt!)} · ${formatBytes(size.get(b.id)?.total ?? 0)} · tự xóa hẳn sau ${left(b)} ngày`,
        this.btn("Lấy lại", "trash-restore", async () => {
          await this.deps.library.untrash(b.id);
          toast(`Đã đưa “${b.title}” về kệ cũ.`);
          await this.deps.changed();
        }),
        this.btn(
          "Xóa hẳn",
          "trash-purge",
          async () => {
            if (!(await confirmDialog("Xóa hẳn?", `“${b.title}” cùng mọi ghi chú của nó sẽ mất hẳn, không lấy lại được (trừ khi có trong một bản sao lưu).`, "Xóa hẳn", true))) return;
            await this.deps.library.purge(b.id);
            await this.deps.changed();
          },
          "btn-quiet",
        ),
      ),
    );
    const empty = this.btn(
      "Dọn sạch thùng rác",
      "trash-empty",
      async () => {
        if (!(await confirmDialog("Dọn sạch thùng rác?", `${trash.length} mục (${formatBytes(total)}) cùng ghi chú của chúng sẽ mất hẳn.`, "Dọn sạch", true))) return;
        await this.deps.library.purgeTrash(0);
        toast("Đã dọn sạch thùng rác.");
        await this.deps.changed();
      },
      "btn-danger-outline",
    );
    this.trashEl.replaceChildren(
      h("h2", {}, "Thùng rác"),
      trash.length
        ? h("p", { class: "muted small" }, `Sách, vở bị xóa nằm đây ${TRASH_DAYS} ngày, kèm mọi ghi chú, rồi mới mất hẳn. Đang giữ ${trash.length} mục · ${formatBytes(total)}.`)
        : h("p", { class: "muted", "data-testid": "trash-none" }, `Trống. Sách, vở bị xóa sẽ nằm đây ${TRASH_DAYS} ngày trước khi mất hẳn.`),
      trash.length ? h("ul", { class: "st-list", "data-testid": "trash-list" }, ...items) : "",
      trash.length ? h("div", { class: "st-actions" }, empty) : "",
    );
  }

  // ---------------------------------------------------------------- cold storage

  private renderCold(all: BookMeta[], size: Map<string, { file: number; original: number }>): void {
    const live = all.filter((b) => !b.trashedAt);
    const cold = live.filter((b) => b.cold).sort((a, b) => b.cold!.at - a.cold!.at);
    const cands = coldCandidates(live);
    const shown = this.showAllCandidates ? cands : cands.slice(0, SHOW);
    const freed = cold.reduce((n, b) => n + b.size, 0);
    const freeze = (b: BookMeta) =>
      this.btn("Cất kho lạnh", "cold-freeze", async () => {
        const u = size.get(b.id);
        await this.deps.beforeFreeze(b.id);
        const file = u?.file ?? (await this.deps.files.read(b.id).then((f) => f.size, () => 0));
        const orig = u?.original ?? (b.source ? await this.deps.files.read(originalKey(b.id)).then((f) => f.size, () => 0) : 0);
        if (await freezeFlow(b, this.deps.library, this.deps.meta, file, orig)) {
          toast(`Đã cất “${b.title}”: lấy lại ${formatBytes(file + orig)}.`);
          await this.deps.changed();
        }
      });
    this.coldEl.replaceChildren(
      h("h2", {}, "❄ Kho lạnh"),
      h(
        "p",
        { class: "muted small" },
        "Gỡ file của sách ít đọc khỏi máy để lấy chỗ; ghi chú, bìa, chỗ trên kệ, tiến độ và chữ tìm kiếm vẫn giữ. Khi mở lại, app hỏi file gốc hoặc bản sao lưu chứa nó. Nên sao lưu trước khi cất.",
      ),
      cold.length
        ? h(
            "div",
            {},
            h("h3", {}, `Đang cất ${cold.length} cuốn (đã lấy lại ~${formatBytes(freed)})`),
            h(
              "ul",
              { class: "st-list", "data-testid": "cold-list" },
              ...cold.map((b) =>
                this.row(
                  `❄ ${b.title}`,
                  `cất ngày ${day(b.cold!.at)}${b.cold!.backup ? ` · trong “${b.cold!.backup}”` : " · cần file gốc"}`,
                  this.btn("Đưa lại", "cold-thaw", async () => {
                    if (await thawFlow(b, this.deps.library)) await this.deps.changed();
                  }),
                ),
              ),
            ),
          )
        : "",
      h("h3", {}, cands.length ? "Gợi ý: sách lớn, chưa mở từ 60 ngày trở lên" : "Chưa có sách nào để lâu chưa mở (60 ngày)."),
      cands.length
        ? h(
            "ul",
            { class: "st-list", "data-testid": "cold-candidates" },
            ...shown.map((b) => this.row(b.title, `${formatBytes(b.size)} · mở lần cuối ${b.lastOpenedAt ? day(b.lastOpenedAt) : "chưa mở"}`, freeze(b))),
          )
        : "",
      cands.length > SHOW && !this.showAllCandidates
        ? this.btn(`Xem cả ${cands.length} cuốn`, "cold-more", async () => {
            this.showAllCandidates = true;
            this.renderCold(all, size);
          }, "btn-quiet")
        : "",
    );
  }

  // ---------------------------------------------------------------- duplicates & regenerable

  private renderDups(all: BookMeta[], usage: LibraryUsage | null): void {
    const groups = findDuplicates(all);
    const text = usage?.books.reduce((n, b) => n + b.text, 0) ?? 0;
    const clear = this.btn(
      "Xóa chỉ mục tìm kiếm",
      "regen-index",
      async () => {
        const ok = await confirmDialog(
          "Xóa chỉ mục tìm kiếm?",
          `Lấy lại khoảng ${formatBytes(text)}. App sẽ tự lập lại chỉ mục ngầm khi rảnh; với sách scan phải nhận dạng chữ (OCR) lại, việc này có thể mất nhiều giờ, trong lúc đó tìm kiếm chưa đủ. Chỉ nên dùng khi tìm kiếm bị sai hoặc thật sự cần chỗ.`,
          "Xóa và lập lại",
          true,
        );
        if (!ok) return;
        await this.deps.clearIndex();
        toast("Đã xóa chỉ mục, đang lập lại ngầm.");
        await this.deps.changed();
      },
      "btn-quiet",
    );
    this.dupEl.replaceChildren(
      h("h2", {}, "Bản trùng & dữ liệu tạo lại được"),
      groups.length
        ? h(
            "ul",
            { class: "st-list", "data-testid": "dup-list" },
            ...groups.flatMap((g) =>
              g.books.slice(1).map((b) =>
                this.row(
                  b.title,
                  `${g.reason === "same" ? "giống hệt" : "rất có thể trùng (cùng dung lượng và số trang)"} “${g.books[0].title}” (nhập ${day(g.books[0].addedAt)}) · ${formatBytes(b.size)}`,
                  this.btn("Chuyển vào thùng rác", "dup-trash", async () => {
                    await this.deps.library.delete(b.id);
                    toast(`Đã chuyển “${b.title}” vào thùng rác (còn lấy lại được ${TRASH_DAYS} ngày).`);
                    await this.deps.changed();
                  }),
                ),
              ),
            ),
          )
        : h("p", { class: "st-ok", "data-testid": "dup-none" }, "✓ Không có sách trùng."),
      h(
        "p",
        { class: "muted small" },
        `Chỉ mục tìm kiếm (chữ của từng trang, kể cả OCR) chiếm ${formatBytes(text)} và có thể tạo lại từ file sách. Bìa cũng tạo lại được nhưng rất nhỏ, không đáng xóa.`,
      ),
      h("div", { class: "st-actions" }, clear),
    );
  }
}
