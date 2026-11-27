import type { FileStore } from "../../core/storage/FileStore";
import type { MetaStore } from "../../core/storage/MetaStore";
import { formatBytes } from "../../core/storage/StorageReport";
import { BACKUP_LOG_KEY, applyRestore, makeBackup, pendingSinceLastBackup, planRestore, type BackupKind, type BackupLog } from "../../core/backup/backup";
import { BackupError, needsPassword, openBackup, verifyBackup, type OpenedBackup } from "../../core/backup/container";
import { h } from "../dom";
import { confirmDialog, modal, toast } from "../feedback";

/*
 * Stage 3 · v2.1 — "Sao lưu & khôi phục" on the storage page.
 * A backup is a file downloaded to the device (Downloads); restoring is
 * picking one or more of those files. Locked backups need their password.
 */

declare const __APP_VERSION__: string;
const TMP_DIR = "backup-tmp";
const KIND_NAME: Record<BackupKind, string> = { full: "toàn bộ", new: "phần mới", notes: "ghi chú & kế hoạch" };

const when = (t: number) =>
  new Date(t).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const stamp = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Encrypted frames go to a scratch file on disk, not memory (a 10 GB backup would not fit). */
async function diskOut(id: string): Promise<{ write(b: Uint8Array): Promise<void>; close(): Promise<Blob> } | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(TMP_DIR, { create: true });
    const fh = await dir.getFileHandle(`${id}.vlbak`, { create: true });
    const w = await fh.createWritable();
    return {
      write: (b) => w.write(b as BufferSource),
      close: async () => {
        await w.close();
        return fh.getFile();
      },
    };
  } catch {
    return null;
  }
}

/** Scratch files from earlier backups (their downloads are long finished). */
export async function clearBackupScratch(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(TMP_DIR, { recursive: true });
  } catch {
    /* none */
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Password for a new backup: two fields, or none at all. */
async function askNewPassword(kind: BackupKind): Promise<{ password: string } | null> {
  const r = await modal((close) => {
    const p1 = h("input", { class: "text-input", type: "password", autocomplete: "new-password", "data-testid": "bk-pass" });
    const p2 = h("input", { class: "text-input", type: "password", autocomplete: "new-password", "data-testid": "bk-pass2" });
    const err = h("p", { class: "st-bad small", "data-testid": "bk-pass-error" });
    const form = h(
      "form",
      { class: "modal bk-dialog", role: "dialog", "aria-modal": "true", "data-testid": "bk-dialog" },
      h("h2", {}, `Sao lưu ${KIND_NAME[kind]}`),
      h("p", {}, "Khóa bằng mật khẩu (nên dùng cho tài liệu chuyên ngành): không có mật khẩu thì không ai mở được file sao lưu – kể cả app."),
      h("label", { class: "field" }, "Mật khẩu (để trống nếu không khóa)", p1),
      h("label", { class: "field" }, "Nhập lại mật khẩu", p2),
      h("p", { class: "muted small" }, "⚠ Quên mật khẩu là mất bản sao lưu đó: không có cách lấy lại. Hãy ghi mật khẩu ở chỗ an toàn."),
      err,
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
        h("button", { class: "btn btn-primary", type: "submit", "data-testid": "bk-go" }, "Tạo bản sao lưu"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) return void (err.textContent = "Hai mật khẩu không giống nhau.");
      if (p1.value && p1.value.length < 6) return void (err.textContent = "Mật khẩu cần ít nhất 6 ký tự.");
      close({ password: p1.value });
    });
    setTimeout(() => p1.focus(), 0);
    return form;
  });
  return (r as { password: string } | null) ?? null;
}

async function askPassword(fileName: string, wrong: boolean): Promise<string | null> {
  const r = await modal((close) => {
    const p = h("input", { class: "text-input", type: "password", autocomplete: "off", "data-testid": "bk-open-pass" });
    const form = h(
      "form",
      { class: "modal bk-dialog", role: "dialog", "aria-modal": "true" },
      h("h2", {}, "Bản sao lưu có khóa"),
      h("p", {}, `Nhập mật khẩu của “${fileName}”.`),
      wrong ? h("p", { class: "st-bad small", "data-testid": "bk-wrong" }, "Sai mật khẩu, thử lại.") : null,
      p,
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
        h("button", { class: "btn btn-primary", type: "submit", "data-testid": "bk-open-go" }, "Mở"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      close(p.value);
    });
    setTimeout(() => p.focus(), 0);
    return form;
  });
  return typeof r === "string" ? r : null;
}

export class BackupCard {
  readonly el: HTMLElement;
  private log: BackupLog = { last: null, files: {} };
  private job: AbortController | null = null;

  constructor(
    private readonly meta: MetaStore,
    private readonly files: FileStore,
    private readonly onRestored: () => void = () => location.reload(),
  ) {
    this.el = h("section", { class: "st-card", "data-testid": "st-backup" });
  }

  async render(): Promise<void> {
    this.log = await this.meta.getSetting<BackupLog>(BACKUP_LOG_KEY, { last: null, files: {} });
    const last = this.log.last;
    const pending = last ? await pendingSinceLastBackup(this.files, this.log) : null;
    const days = last ? Math.floor((Date.now() - last.at) / 86_400_000) : null;
    const status = last
      ? h(
          "div",
          { class: days! > 14 ? "st-warn" : "st-ok", "data-testid": "bk-last" },
          `${days! > 14 ? "⚠" : "✓"} Lần sao lưu gần nhất: ${when(last.at)} · ${KIND_NAME[last.kind]} · ${formatBytes(last.size)}${last.locked ? " · có khóa" : ""}.`,
          pending && pending.files ? ` Từ đó đến nay có ${pending.files} file mới (${formatBytes(pending.bytes)}).` : " Không có sách mới từ lần đó.",
        )
      : h("div", { class: "st-warn", "data-testid": "bk-last" }, "⚠ Chưa sao lưu lần nào. Nếu máy hỏng hoặc dữ liệu trình duyệt bị xóa, thư viện sẽ mất hẳn.");

    const btn = (kind: BackupKind, label: string, primary = false, disabled = false) => {
      const b = h("button", { class: `btn ${primary ? "btn-primary" : ""}`, type: "button", "data-testid": `bk-${kind}` }, label) as HTMLButtonElement;
      b.disabled = disabled;
      b.addEventListener("click", () => void this.backup(kind));
      return b;
    };
    const input = h("input", { type: "file", accept: ".vlbak", multiple: true, style: "display:none", "data-testid": "bk-restore-input" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const list = [...(input.files ?? [])];
      input.value = "";
      if (list.length) void this.restore(list);
    });
    const restore = h("button", { class: "btn", type: "button", "data-testid": "bk-restore" }, "Khôi phục từ file sao lưu…");
    restore.addEventListener("click", () => input.click());

    this.el.replaceChildren(
      h("h2", {}, "Sao lưu & khôi phục"),
      status,
      h(
        "div",
        { class: "st-actions" },
        btn("full", "Sao lưu toàn bộ", true),
        btn("new", "Sao lưu phần mới", false, !last || !pending?.files),
        btn("notes", "Chỉ ghi chú & kế hoạch"),
      ),
      h(
        "p",
        { class: "muted small" },
        "File sao lưu (.vlbak) được tải về thư mục Tải xuống. Hãy chép nó sang chỗ khác (máy tính, USB, ổ đám mây) – để trên cùng máy thì máy hỏng vẫn mất. “Phần mới” chỉ chứa sách thêm sau lần sao lưu trước cùng toàn bộ ghi chú; khi khôi phục, chọn cùng lúc bản toàn bộ và các bản phần mới.",
      ),
      h("div", { class: "st-actions" }, restore, input),
      h("div", { class: "bk-progress", "data-testid": "bk-progress", hidden: true }),
    );
  }

  private progress(text: string, frac: number | null, canStop = true): void {
    const box = this.el.querySelector<HTMLElement>(".bk-progress")!;
    box.hidden = false;
    const stop = h("button", { class: "btn btn-small", type: "button", "data-testid": "bk-stop" }, "Dừng");
    stop.addEventListener("click", () => this.job?.abort());
    const bar = h("progress", { max: "1" }) as HTMLProgressElement;
    if (frac != null) bar.value = frac;
    box.replaceChildren(h("span", { "data-testid": "bk-progress-text" }, text), bar, this.job && canStop ? stop : "");
  }

  private setBusy(on: boolean): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>(".st-actions button")) b.disabled = on || (b.dataset.testid === "bk-new" && !this.log.last);
  }

  private async backup(kind: BackupKind): Promise<void> {
    if (this.job) return;
    const ask = await askNewPassword(kind);
    if (!ask) return;
    this.job = new AbortController();
    this.setBusy(true);
    const id = crypto.randomUUID();
    try {
      const out = ask.password ? await diskOut(id) : null;
      const { blob, log } = await makeBackup({
        kind,
        files: this.files,
        log: this.log,
        app: `Visual Library ${__APP_VERSION__}`,
        password: ask.password || undefined,
        cipherOut: out ? () => out : undefined,
        signal: this.job.signal,
        onProgress: (p) =>
          this.progress(
            p.phase === "db" ? "Đang gom ghi chú, kế hoạch, kệ sách…" : p.phase === "files" ? `Đang chép sách: ${formatBytes(p.done)} / ${formatBytes(p.total)}` : "Đang hoàn tất…",
            p.phase === "files" && p.total ? p.done / p.total : null,
          ),
      });
      // check the file before handing it over
      this.progress("Đang kiểm tra bản sao lưu…", null);
      const opened = await openBackup(blob, ask.password || undefined);
      const bad = await verifyBackup(opened, undefined, this.job.signal);
      if (bad.length) throw new BackupError(`Bản sao lưu vừa tạo không khớp (${bad.length} mục). Hãy thử lại.`);
      const name = `visual-library-${stamp(Date.now())}-${kind}${ask.password ? "-khoa" : ""}.vlbak`;
      download(blob, name);
      await this.meta.setSetting(BACKUP_LOG_KEY, log);
      (window as unknown as { __lastBackup?: { blob: Blob; name: string } }).__lastBackup = { blob, name };
      toast(`Đã tạo “${name}” (${formatBytes(blob.size)}). Nhớ chép file này sang chỗ khác.`, "info", 8000);
    } catch (e) {
      toast(this.job.signal.aborted ? "Đã dừng sao lưu." : e instanceof Error ? e.message : "Sao lưu thất bại.", "error", 7000);
    } finally {
      this.job = null;
      await this.render();
    }
  }

  private async restore(list: File[]): Promise<void> {
    if (this.job) return;
    this.job = new AbortController();
    this.setBusy(true);
    try {
      const opened: OpenedBackup[] = [];
      for (const f of list) {
        let wrong = false;
        for (;;) {
          let password: string | undefined;
          if (await needsPassword(f)) {
            const p = await askPassword(f.name, wrong);
            if (p == null) return;
            password = p;
          }
          try {
            this.progress(`Đang mở “${f.name}”…`, null);
            opened.push(await openBackup(f, password));
            break;
          } catch (e) {
            if (password && e instanceof BackupError && /Sai mật khẩu/.test(e.message)) {
              wrong = true;
              continue;
            }
            throw e;
          }
        }
      }
      const total = opened.reduce((s, b) => s + b.manifest.entries.reduce((n, e) => n + e.size, 0), 0);
      let done = 0;
      for (const b of opened) {
        const bad = await verifyBackup(b, (n) => this.progress(`Đang kiểm tra: ${formatBytes((done += n))} / ${formatBytes(total)}`, total ? done / total : null), this.job.signal);
        if (bad.length) throw new BackupError(`Bản sao lưu bị hỏng (${bad.length} mục không khớp). Không khôi phục gì cả.`);
      }
      const local: Record<string, number> = {};
      for (const n of await this.files.list()) local[n] = (await this.files.read(n)).size;
      const plan = planRestore(opened, local);
      if (plan.missing.length) {
        throw new BackupError(
          `Thiếu ${plan.missing.length} file sách mà các bản đã chọn không có. Hãy chọn cùng lúc bản sao lưu toàn bộ và mọi bản “phần mới” sau nó.`,
        );
      }
      this.el.querySelector<HTMLElement>(".bk-progress")!.hidden = true;
      const ok = await confirmDialog(
        "Thay thư viện bằng bản sao lưu?",
        `Bản sao lưu lúc ${when(plan.createdAt)}: ${plan.books} sách, ${plan.notebooks} vở. Toàn bộ thư viện hiện tại trên máy này (sách, vở, ghi chú, kế hoạch) sẽ được thay bằng bản này. Nếu còn thứ gì mới chưa sao lưu, hãy Hủy và sao lưu trước.`,
        "Khôi phục",
        true,
      );
      if (!ok) return;
      const log = await applyRestore(plan, this.files, (d, t) => this.progress(`Đang khôi phục, đừng tắt app: ${formatBytes(d)} / ${formatBytes(t)}`, t ? d / t : null, false));
      await this.meta.setSetting(BACKUP_LOG_KEY, log);
      toast("Đã khôi phục. Đang mở lại thư viện…", "info", 4000);
      this.onRestored();
    } catch (e) {
      toast(this.job.signal.aborted ? "Đã dừng. Thư viện chưa bị thay đổi." : e instanceof Error ? e.message : "Khôi phục thất bại.", "error", 8000);
    } finally {
      this.job = null;
      await this.render();
    }
  }
}
