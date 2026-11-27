import type { Category } from "../../core/types";
import type { FileStore } from "../../core/storage/FileStore";
import type { MetaStore } from "../../core/storage/MetaStore";
import { checkIntegrity, formatBytes, integrityProblems, measureLibrary, type IntegrityReport, type LibraryUsage } from "../../core/storage/StorageReport";
import { checkMarker, deviceInfo, diskTest, placeMarker, requestPersist, type DeviceInfo, type Marker } from "../../app/Diagnostics";
import { h, icon, iconButton } from "../dom";
import { toast } from "../feedback";
import { BackupCard, clearBackupScratch } from "./BackupCard";

/*
 * Stage 3 · v2.0 — "Kho lưu trữ": what the library takes, whether the
 * browser will keep it, whether anything is inconsistent, and what this
 * device can do. Read-only, except the disk test's own scratch file and the
 * restart marker.
 */

export interface StorageViewDeps {
  meta: MetaStore;
  files: FileStore;
  onBack: () => void;
}

const MARKER_KEY = "diagMarker";

export class StorageView {
  readonly el: HTMLElement;
  private overview: HTMLElement;
  private usageBox: HTMLElement;
  private integrityBox: HTMLElement;
  private deviceBox: HTMLElement;
  private backupCard: BackupCard;
  private info: DeviceInfo | null = null;
  private usage: LibraryUsage | null = null;
  private busy = new AbortController();

  constructor(private readonly deps: StorageViewDeps) {
    this.overview = h("section", { class: "st-card", "data-testid": "st-overview" });
    this.usageBox = h("section", { class: "st-card", "data-testid": "st-usage" });
    this.integrityBox = h("section", { class: "st-card", "data-testid": "st-integrity" });
    this.deviceBox = h("section", { class: "st-card", "data-testid": "st-device" });
    this.backupCard = new BackupCard(deps.meta, deps.files);
    this.el = h(
      "div",
      { class: "planner storage", "data-testid": "storage" },
      h(
        "header",
        { class: "lib-header" },
        iconButton("back", "Quay lại", () => deps.onBack(), "st-back"),
        h("div", { class: "brand" }, h("span", { class: "brand-mark", html: icon("inbox", 24) }), h("h1", {}, "Kho lưu trữ")),
      ),
      h("main", { class: "plan-main st-main" }, this.overview, this.backupCard.el, this.usageBox, this.integrityBox, this.deviceBox),
    );
  }

  async refresh(): Promise<void> {
    this.info = await deviceInfo();
    this.renderOverview();
    this.renderIntegrity(null);
    void this.renderDevice();
    void clearBackupScratch().then(() => this.backupCard.render());
    this.usageBox.replaceChildren(h("h2", {}, "Dung lượng"), h("p", { class: "muted" }, "Đang đo…"));
    this.usage = await measureLibrary(this.deps.meta, this.deps.files);
    this.renderOverview();
    await this.renderUsage();
  }

  destroy(): void {
    this.busy.abort();
  }

  // ---------------------------------------------------------------- overview

  private renderOverview(): void {
    const i = this.info;
    const u = this.usage;
    const kept =
      i?.persisted === true
        ? h("div", { class: "st-ok", "data-testid": "st-persisted" }, "✓ Đã bật lưu bền: trình duyệt sẽ không tự dọn thư viện khi máy sắp đầy. Chỉ mất nếu chính bạn xóa dữ liệu trang web trong cài đặt trình duyệt.")
        : h(
            "div",
            { class: "st-warn", "data-testid": "st-persisted" },
            h("p", {}, "⚠ Chưa bật lưu bền: khi máy sắp đầy, trình duyệt có thể tự xóa dữ liệu của trang ít dùng nhất – kể cả thư viện này."),
            this.persistButton(),
          );
    this.overview.replaceChildren(
      h("h2", {}, "Tổng quan"),
      h(
        "div",
        { class: "st-big" },
        h("div", {}, h("b", { "data-testid": "st-total" }, u ? formatBytes(u.total) : "…"), h("span", {}, "thư viện đang dùng")),
        h("div", {}, h("b", {}, u ? String(u.books.length) : "…"), h("span", {}, "sách và vở")),
        h("div", {}, h("b", {}, i?.usage != null ? formatBytes(i.usage) : "–"), h("span", {}, "trình duyệt báo đang dùng")),
      ),
      kept,
      h(
        "p",
        { class: "muted small" },
        "Giới hạn thật là chỗ trống còn lại trên máy. Con số “hạn mức” trình duyệt báo không phải chỗ trống (Chrome mới luôn báo “đang dùng + 10 GB”), nên app không dùng nó để cảnh báo.",
      ),
    );
  }

  private persistButton(): HTMLElement {
    const b = h("button", { class: "btn btn-primary", type: "button", "data-testid": "st-persist" }, "Bật lưu bền");
    b.addEventListener("click", async () => {
      const ok = await requestPersist();
      this.info = await deviceInfo();
      this.renderOverview();
      toast(ok ? "Đã bật lưu bền." : "Trình duyệt chưa đồng ý. Cài app ra màn hình chính rồi thử lại thường sẽ được.", ok ? "info" : "error", 6000);
    });
    return b;
  }

  // ---------------------------------------------------------------- usage

  private async renderUsage(): Promise<void> {
    const u = this.usage!;
    const cats: Category[] = await this.deps.meta.listCategories();
    const byId = new Map(cats.map((c) => [c.id, c]));
    const rootName = (id: string | null) => {
      let c = id ? byId.get(id) : undefined;
      while (c?.parentId && byId.get(c.parentId)) c = byId.get(c.parentId)!;
      return c?.name ?? "Chưa xếp kệ";
    };
    const perStack = new Map<string, number>();
    for (const b of u.books) perStack.set(rootName(b.categoryId), (perStack.get(rootName(b.categoryId)) ?? 0) + b.total);
    const stacks = [...perStack.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...stacks.map((s) => s[1]));
    const sum = (k: "file" | "original" | "cover" | "notes" | "text") => u.books.reduce((n, b) => n + b[k], 0);
    const parts: [string, number][] = [
      ["File sách", sum("file")],
      ["Bản gốc Word (.docx)", sum("original")],
      ["Ghi chú, nét bút, hình cắt", sum("notes")],
      ["Chữ tìm kiếm / OCR", sum("text")],
      ["Bìa sách", sum("cover")],
      ["Ảnh treo tường", u.pictures],
      ["Kế hoạch, tiến độ, cài đặt", u.other],
    ];
    if (u.orphans) parts.push(["Dữ liệu mồ côi (của sách đã xóa)", u.orphans]);
    const row = (cells: (string | HTMLElement)[], cls = "") => h("tr", { class: cls }, ...cells.map((c) => h("td", {}, c)));
    this.usageBox.replaceChildren(
      h("h2", {}, "Dung lượng"),
      h("table", { class: "st-table st-parts" }, h("tbody", {}, ...parts.filter((p) => p[1] > 0).map(([k, v]) => row([k, formatBytes(v)])))),
      h("h3", {}, "Theo tủ"),
      h(
        "div",
        { class: "st-bars", "data-testid": "st-stacks" },
        ...stacks.map(([name, n]) => h("div", { class: "st-bar" }, h("span", { class: "st-bar-name" }, name), h("span", { class: "st-bar-track" }, h("i", { style: `width:${((n / max) * 100).toFixed(1)}%` })), h("span", { class: "st-bar-val" }, formatBytes(n)))),
      ),
      h("h3", {}, "Theo từng cuốn (nặng nhất trước)"),
      h(
        "div",
        { class: "st-scroll" },
        h(
          "table",
          { class: "st-table", "data-testid": "st-books" },
          h("thead", {}, h("tr", {}, ...["Sách / vở", "File", "Ghi chú", "Chữ tìm kiếm", "Tổng"].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            ...u.books.map((b) =>
              row(
                [
                  h("span", {}, b.kind === "notebook" ? "📓 " : "", b.title, b.missing ? h("b", { class: "st-bad" }, " · mất file") : ""),
                  formatBytes(b.file + b.original),
                  formatBytes(b.notes),
                  formatBytes(b.text),
                  h("b", {}, formatBytes(b.total)),
                ],
                b.missing ? "missing" : "",
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- integrity

  private renderIntegrity(r: IntegrityReport | null, progress?: string): void {
    const quick = h("button", { class: "btn", type: "button", "data-testid": "st-check" }, "Kiểm tra nhanh");
    const deep = h("button", { class: "btn", type: "button", "data-testid": "st-check-deep" }, "Kiểm tra kỹ");
    quick.addEventListener("click", () => void this.runCheck(false));
    deep.addEventListener("click", () => void this.runCheck(true));
    const body: (HTMLElement | null)[] = [
      h("h2", {}, "Kiểm tra toàn vẹn"),
      h("p", { class: "muted small" }, "Chỉ xem và báo cáo, không sửa hay xóa gì. “Kiểm tra kỹ” đọc lại phần đầu và cuối của mọi file để so với lúc nhập (với thư viện lớn có thể mất vài phút)."),
      h("div", { class: "st-row" }, quick, deep),
    ];
    if (progress) body.push(h("p", { class: "muted", "data-testid": "st-check-progress" }, progress));
    if (r) {
      const n = integrityProblems(r);
      if (!n) body.push(h("div", { class: "st-ok", "data-testid": "st-check-result" }, `✓ Không thấy vấn đề nào ở ${r.books} sách và vở${r.deep ? " (đã đọc lại đầu/cuối mọi file)" : ""}.`));
      else {
        const items: HTMLElement[] = [];
        for (const b of r.missingFiles) items.push(h("li", {}, `“${b.title}”: mất file sách – không mở được.`));
        for (const b of r.missingOriginals) items.push(h("li", {}, `“${b.title}”: mất bản gốc .docx (vẫn đọc được bản chuyển đổi).`));
        for (const b of r.damaged) items.push(h("li", {}, `“${b.title}”: ${b.reason}.`));
        if (r.orphanFiles.length) items.push(h("li", {}, `${r.orphanFiles.length} file không thuộc sách nào (${formatBytes(r.orphanFiles.reduce((s, f) => s + f.size, 0))}).`));
        for (const o of r.orphanRecords) items.push(h("li", {}, `${o.store}: ${o.count} mục của sách đã xóa (${formatBytes(o.bytes)}).`));
        body.push(
          h("div", { class: "st-warn", "data-testid": "st-check-result" }, h("p", {}, `Thấy ${n} vấn đề:`), h("ul", {}, ...items), h("p", { class: "small" }, "Chưa có gì bị sửa. Công cụ dọn dẹp và khôi phục có ở các mốc v2.1 (sao lưu) và v2.3 (dọn dẹp).")),
        );
      }
    }
    this.integrityBox.replaceChildren(...body.filter((x): x is HTMLElement => !!x));
  }

  private async runCheck(deep: boolean): Promise<void> {
    this.renderIntegrity(null, "Đang kiểm tra…");
    const r = await checkIntegrity(this.deps.meta, this.deps.files, {
      deep,
      signal: this.busy.signal,
      onProgress: (d, t) => {
        const p = this.integrityBox.querySelector('[data-testid="st-check-progress"]');
        if (p) p.textContent = `Đang kiểm tra ${d}/${t}…`;
      },
    });
    this.renderIntegrity(r);
  }

  // ---------------------------------------------------------------- device

  private async renderDevice(extra?: HTMLElement): Promise<void> {
    const i = this.info!;
    const yes = (v: boolean | null) => (v ? "có" : v === false ? "không" : "không rõ");
    const marker = await checkMarker(() => this.deps.meta.getSetting<Marker | null>(MARKER_KEY, null));
    const when = (t: number) => new Date(t).toLocaleString("vi-VN");
    const markerText =
      marker.kind === "none"
        ? "Chưa đặt dấu. Đặt dấu, khởi động lại máy (hoặc để vài ngày), rồi mở lại trang này để xem dữ liệu có còn nguyên."
        : marker.kind === "intact"
          ? `✓ Dấu đặt lúc ${when(marker.marker.at)} vẫn còn nguyên ở cả hai nơi lưu (file và cơ sở dữ liệu).`
          : marker.kind === "file-lost"
            ? `⚠ Dấu đặt lúc ${when(marker.marker.at)}: phần file đã mất, phần cơ sở dữ liệu còn. Trình duyệt đã dọn vùng file.`
            : "⚠ Dấu trong cơ sở dữ liệu đã mất. Trình duyệt đã xóa dữ liệu của trang.";
    const place = h("button", { class: "btn", type: "button", "data-testid": "st-marker" }, marker.kind === "none" ? "Đặt dấu kiểm tra" : "Đặt lại dấu");
    place.addEventListener("click", async () => {
      await placeMarker(i.browser, (m) => this.deps.meta.setSetting(MARKER_KEY, m));
      toast("Đã đặt dấu. Khởi động lại máy rồi mở lại trang này.");
      void this.renderDevice();
    });
    const test = h("button", { class: "btn btn-primary", type: "button", "data-testid": "st-disktest" }, "Thử ghi/đọc 200 MB");
    test.addEventListener("click", () => void this.runDiskTest());
    const rows: [string, string][] = [
      ["Trình duyệt", i.browser],
      ["Chạy như app cài đặt (không có thanh trình duyệt)", yes(i.standalone)],
      ["Lưu bền", yes(i.persisted)],
      ["Vùng file riêng (nơi chứa sách)", yes(i.opfs)],
      ["Chọn thư mục trên máy (cho mốc v2.2)", yes(i.folderPicker)],
      ["Toàn màn hình", yes(i.fullscreen)],
      ["RAM / nhân CPU", `${i.memoryGB ? `≥ ${i.memoryGB} GB` : "không rõ"} · ${i.cores ?? "?"} nhân`],
    ];
    this.deviceBox.replaceChildren(
      h("h2", {}, "Chẩn đoán thiết bị"),
      h("table", { class: "st-table", "data-testid": "st-device-table" }, h("tbody", {}, ...rows.map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, h("b", {}, v)))))),
      h("h3", {}, "Ghi/đọc thử"),
      h("p", { class: "muted small" }, "Ghi 200 MB vào một file tạm riêng, đọc lại so từng byte, đo tốc độ rồi xóa file tạm. Không đụng tới sách."),
      h("div", { class: "st-row" }, test),
      extra ?? h("div", { "data-testid": "st-disk-result" }),
      h("h3", {}, "Dấu kiểm tra qua khởi động lại"),
      h("p", { "data-testid": "st-marker-state" }, markerText),
      h("div", { class: "st-row" }, place),
    );
  }

  private async runDiskTest(): Promise<void> {
    const out = h("div", { "data-testid": "st-disk-result" }, h("p", { class: "muted" }, "Đang ghi…"));
    await this.renderDevice(out);
    const mb = Number((window as unknown as { __diskTestMB?: number }).__diskTestMB ?? 200); // tests use less
    const r = await diskTest(
      mb,
      (phase, f) => {
        out.replaceChildren(h("p", { class: "muted" }, `${phase === "write" ? "Đang ghi" : "Đang đọc lại và so"} … ${Math.round(f * 100)}%`));
      },
      this.busy.signal,
    );
    out.replaceChildren(
      r.ok
        ? h("div", { class: "st-ok" }, `✓ ${r.mb} MB ghi rồi đọc lại khớp từng byte. Ghi ${r.writeMBps.toFixed(0)} MB/s · đọc ${r.readMBps.toFixed(0)} MB/s.`)
        : h("div", { class: "st-warn" }, `⚠ ${r.error ?? (r.badAtMB != null ? `Dữ liệu đọc lại khác ở MB thứ ${r.badAtMB}.` : "Không thành công.")}`),
    );
  }
}
