import type { InkModel } from "../../core/annotations/InkModel";
import type { Margins } from "../../core/annotations/types";
import { buildExportJobs, exportFileName, inkExtent, runExportWorker, type ExportOptions } from "../../core/export/ExportService";
import type { PagedDocument } from "../../core/pdf/PagedDocument";
import { formatBytes, h, icon } from "../dom";
import { modal } from "../feedback";

export interface ExportDeps {
  doc: PagedDocument;
  ink: InkModel;
  margins: Margins;
  title: string;
  getFile: () => Promise<File>;
}

/** "Xuất bản có ghi chú": options -> progress -> save / share. */
export async function openExportDialog(d: ExportDeps): Promise<void> {
  await d.ink.flush();
  const inked = d.ink.pagesWithInk();
  const hasMarginInk = inked.some((p) => {
    const ext = inkExtent(d.ink.strokes(p));
    return !!ext && (ext.minX < 0 || ext.maxX > d.doc.pageSize(p).width);
  });
  const bookHasMargin = d.margins.left > 0 || d.margins.right > 0;
  const fileName = exportFileName(d.title);

  await modal((close) => {
    const body = h("div", { class: "export-body" });
    const box = h(
      "div",
      { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "data-testid": "export-dialog" },
      h("h2", {}, "Xuất bản có ghi chú"),
      body,
    );

    if (!inked.length) {
      body.append(
        h("p", {}, "Tài liệu này chưa có ghi chú nào. Viết, highlight hoặc gạch chân trước rồi xuất."),
        h("div", { class: "modal-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => close(null) }, "Đóng")),
      );
      return box;
    }

    const opts: ExportOptions = { scope: "all", marginPages: "noted" };
    const radio = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K], label: string, hint?: string) => {
      const input = h("input", { type: "radio", name: key, value: String(value), checked: opts[key] === value });
      input.addEventListener("change", () => (opts[key] = value));
      return h("label", { class: "radio" }, input, h("span", {}, label, hint ? h("small", {}, hint) : null));
    };

    const start = h("button", { class: "btn btn-primary", type: "button", "data-testid": "export-start", html: `${icon("exportPdf", 19)}<span>Tạo file</span>` });
    const parts: (HTMLElement | null)[] = [
      h(
        "p",
        {},
        `Có ghi chú ở ${inked.length} trang. App tạo một file mới “${fileName}”. File gốc trên kệ không bị thay đổi.`,
      ),
      h(
        "fieldset",
        { class: "opt-group" },
        h("legend", {}, "Trang trong file mới"),
        radio("scope", "all", `Toàn bộ tài liệu (${d.doc.numPages} trang)`),
        radio("scope", "annotated", `Chỉ các trang có ghi chú (${inked.length} trang)`, "Gọn nhẹ để gửi cho người khác"),
      ),
      bookHasMargin || hasMarginInk
        ? h(
            "fieldset",
            { class: "opt-group" },
            h("legend", {}, "Phần lề nới rộng"),
            radio("marginPages", "noted", "Chỉ ở trang có ghi chú trong lề", "Các trang khác giữ khổ giấy gốc"),
            radio("marginPages", "all", "Ở mọi trang", "Giống hệt khi đọc trong app"),
          )
        : null,
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
        start,
      ),
    ];
    body.append(...parts.filter((x): x is HTMLElement => x !== null));

    start.addEventListener("click", async () => {
      const label = h("div", { class: "export-phase" }, "Đang chuẩn bị…");
      const fill = h("span", { class: "fill" });
      body.replaceChildren(label, h("div", { class: "bar big" }, fill), h("p", { class: "muted small" }, "File lớn có thể mất một lúc. Bạn đừng đóng app."));
      try {
        const { jobs, keepPages } = await buildExportJobs(d.doc, d.ink, d.margins, opts);
        const file = await d.getFile();
        const phases: Record<string, string> = { load: "Đang đọc file gốc…", draw: "Đang vẽ ghi chú vào trang…", save: "Đang ghi file mới…" };
        const bytes = await runExportWorker(file, jobs, keepPages, d.title, (f, phase) => {
          label.textContent = phases[phase] ?? "Đang xử lý…";
          const base = phase === "load" ? 0 : phase === "draw" ? 0.3 : 0.8;
          const span = phase === "load" ? 0.3 : phase === "draw" ? 0.5 : 0.2;
          fill.style.width = `${Math.round((base + f * span) * 100)}%`;
        });
        const blob = new File([bytes as Uint8Array<ArrayBuffer>], fileName, { type: "application/pdf" });
        showDone(body, blob, close);
      } catch (e) {
        body.replaceChildren(
          h("p", { class: "error-text" }, e instanceof Error ? e.message : "Xuất file thất bại."),
          h("div", { class: "modal-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => close(null) }, "Đóng")),
        );
      }
    });
    return box;
  });
}

function showDone(body: HTMLElement, file: File, close: (v: unknown) => void): void {
  const url = URL.createObjectURL(file);
  const save = h("a", {
    class: "btn btn-primary",
    href: url,
    download: file.name,
    "data-testid": "export-save",
    html: `${icon("exportPdf", 19)}<span>Lưu về máy</span>`,
  });
  const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  const share = canShare
    ? h("button", {
        class: "btn",
        type: "button",
        html: `${icon("share", 18)}<span>Chia sẻ…</span>`,
        onclick: () => void navigator.share({ files: [file], title: file.name }).catch(() => {}),
      })
    : null;
  body.replaceChildren(
    h("div", { class: "export-done" }, h("span", { class: "ok-mark", html: icon("check", 22) }), h("div", {}, h("strong", {}, file.name), h("div", { class: "muted small" }, formatBytes(file.size)))),
    h("p", { class: "muted small" }, "“Lưu về máy” đưa file vào thư mục Tải xuống (Download). “Chia sẻ” để gửi qua Zalo, Drive, email…"),
    h(
      "div",
      { class: "modal-actions" },
      h("button", { class: "btn", type: "button", onclick: () => (URL.revokeObjectURL(url), close(null)) }, "Đóng"),
      share,
      save,
    ),
  );
}
