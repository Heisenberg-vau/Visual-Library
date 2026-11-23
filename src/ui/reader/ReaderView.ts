import type { InkModel } from "../../core/annotations/InkModel";
import type { Margins, PaperPattern } from "../../core/annotations/types";
import type { PagedDocument } from "../../core/pdf/PagedDocument";
import type { BookMeta } from "../../core/types";
import { JobScheduler } from "../../core/util/scheduler";
import { h, iconButton } from "../dom";
import { popupMenu, toast } from "../feedback";
import { openExportDialog } from "./ExportDialog";
import { InkLayer, type Tool, type ToolState } from "./InkLayer";
import { OutlinePanel } from "./OutlinePanel";
import { PageScroller } from "./PageScroller";
import { ThumbnailPanel } from "./ThumbnailPanel";

export interface ReaderDeps {
  book: BookMeta;
  doc: PagedDocument;
  ink: InkModel;
  tools: ToolState;
  onClose: () => void;
  onPosition: (page: number, zoom: number) => void;
  onToolsChange: (t: ToolState) => void;
  onMargins: (m: Margins) => void;
  getFile: () => Promise<File>;
}

const PEN_COLORS = ["#1d2430", "#1f5fbf", "#d03a2f", "#1e8a4c", "#7b3fb5", "#e07a12"];
const HL_COLORS = ["#ffd400", "#7ee36a", "#ff8fc7", "#6cc7ff", "#ffa94d"];
const UL_COLORS = ["#d03a2f", "#1f5fbf", "#1d2430", "#1e8a4c"];
const PEN_WIDTHS = [1, 1.6, 2.6];
const MARGIN_PRESETS: { label: string; left: number; right: number }[] = [
  { label: "Không nới lề", left: 0, right: 0 },
  { label: "Lề phải rộng 30%", left: 0, right: 0.3 },
  { label: "Lề phải rộng 60%", left: 0, right: 0.6 },
  { label: "Hai bên, mỗi bên 25%", left: 0.25, right: 0.25 },
];
const PATTERNS: { label: string; p: PaperPattern }[] = [
  { label: "Nền lề: kẻ dòng", p: "lines" },
  { label: "Nền lề: ô vuông", p: "grid" },
  { label: "Nền lề: chấm", p: "dots" },
  { label: "Nền lề: trơn", p: "blank" },
];

type PanelTab = "thumbs" | "outline";

/** Reading screen: toolbar, page view and the side panel. */
export class ReaderView {
  readonly el: HTMLElement;
  private scroller: PageScroller;
  private thumbs: ThumbnailPanel;
  private outline: OutlinePanel;
  private scheduler = new JobScheduler(1);
  private pageInput: HTMLInputElement;
  private zoomLabel: HTMLButtonElement;
  private sidebar: HTMLElement;
  private tabButtons: Record<PanelTab, HTMLButtonElement>;
  private panelOpen = false;
  private tab: PanelTab = "thumbs";
  private saveTimer = 0;
  private ink: InkLayer;
  private tools: ToolState;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private colorBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;

  constructor(private readonly deps: ReaderDeps) {
    const { book, doc } = deps;
    this.tools = { ...deps.tools };
    this.scroller = new PageScroller(doc, this.scheduler, {
      initialPage: book.lastPage,
      initialZoom: book.zoom,
      margins: book.margins,
      onPageChange: (p) => this.onPageChange(p),
      onZoomChange: () => {
        this.updateZoomLabel();
        this.queueSave();
      },
    });
    const nav = (p: number) => {
      this.scroller.goToPage(p);
      if (window.innerWidth < 900) this.togglePanel(false);
    };
    this.thumbs = new ThumbnailPanel(doc, this.scheduler, nav);
    this.outline = new OutlinePanel(() => doc.getOutline(), nav);

    this.pageInput = h("input", {
      class: "page-input",
      type: "text",
      inputmode: "numeric",
      "aria-label": "Số trang",
      "data-testid": "page-input",
      value: String(book.lastPage),
    });
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.jumpFromInput();
        this.pageInput.blur();
      } else if (e.key === "Escape") {
        this.pageInput.blur();
      }
    });
    this.pageInput.addEventListener("blur", () => {
      this.pageInput.value = String(this.scroller.currentPage);
    });

    this.zoomLabel = h("button", {
      class: "zoom-label",
      type: "button",
      title: "Vừa chiều rộng",
      "data-testid": "zoom-label",
      onclick: () => this.scroller.setZoom(1),
    });

    const mkTab = (t: PanelTab, label: string) =>
      h("button", { class: "tab", type: "button", "data-tab": t, onclick: () => this.showTab(t) }, label);
    this.tabButtons = { thumbs: mkTab("thumbs", "Trang"), outline: mkTab("outline", "Mục lục") };

    this.sidebar = h(
      "aside",
      { class: "sidebar", "data-testid": "sidebar" },
      h("div", { class: "tabs" }, this.tabButtons.thumbs, this.tabButtons.outline),
      h("div", { class: "sidebar-body" }, this.thumbs.el, this.outline.el),
    );

    this.ink = new InkLayer(this.scroller, deps.ink, () => this.tools, () => this.updateHistory(), (p) => doc.textChars(p));
    const toolGroup = h("div", { class: "tool-group", "data-testid": "tools" });
    const toolDefs: [Tool, string, string][] = [
      ["hand", "hand", "Chỉ đọc (bút cũng cuộn trang)"],
      ["pen", "pen", "Bút"],
      ["highlighter", "highlighter", "Bút dạ quang"],
      ["underline", "underline", "Gạch chân (nét thẳng)"],
      ["eraser", "eraser", "Tẩy (xóa cả nét)"],
    ];
    for (const [t, ic, label] of toolDefs) {
      const b = iconButton(ic, label, () => this.setTool(t), "tool-btn");
      b.dataset.tool = t;
      this.toolButtons.set(t, b);
      toolGroup.append(b);
    }
    this.colorBtn = h("button", {
      class: "color-btn",
      type: "button",
      title: "Màu và độ dày",
      "aria-label": "Màu và độ dày",
      "data-testid": "color-btn",
    });
    this.colorBtn.addEventListener("click", () => this.openPalette());
    this.undoBtn = iconButton("undo", "Hoàn tác (Ctrl+Z)", () => this.undo());
    this.redoBtn = iconButton("redo", "Làm lại (Ctrl+Y)", () => this.redo());
    this.undoBtn.dataset.testid = "undo";
    this.redoBtn.dataset.testid = "redo";
    const marginBtn = iconButton("margin", "Nới rộng lề để ghi chú", () => this.openMargins(marginBtn));
    marginBtn.dataset.testid = "margin-btn";
    const exportBtn = iconButton("exportPdf", "Xuất bản có ghi chú (PDF mới)", () => void this.exportPdf());
    exportBtn.dataset.testid = "export-btn";
    toolGroup.append(this.colorBtn, this.undoBtn, this.redoBtn, marginBtn, exportBtn);

    const toolbar = h(
      "header",
      { class: "reader-toolbar" },
      iconButton("back", "Về kệ sách", () => deps.onClose(), "tb-back"),
      iconButton("panel", "Trang và mục lục", () => this.togglePanel(), "tb-panel"),
      h("div", { class: "reader-title", title: book.title }, book.title),
      toolGroup,
      h(
        "div",
        { class: "page-nav" },
        this.pageInput,
        h("span", { class: "page-total", "data-testid": "page-total" }, `/ ${doc.numPages}`),
      ),
      h(
        "div",
        { class: "zoom-group" },
        iconButton("minus", "Thu nhỏ", () => this.scroller.setZoom(this.scroller.currentZoom / 1.2)),
        this.zoomLabel,
        iconButton("plus", "Phóng to", () => this.scroller.setZoom(this.scroller.currentZoom * 1.2)),
      ),
    );

    this.el = h(
      "div",
      { class: "reader" },
      toolbar,
      h("div", { class: "reader-body" }, this.sidebar, this.scroller.el),
    );
    this.el.addEventListener("keydown", this.onKey);
    this.showTab("thumbs");
    this.updateZoomLabel();
    this.renderTools();
    this.updateHistory();
    document.addEventListener("visibilitychange", this.onHide);
  }

  // ---- ink tools ------------------------------------------------------

  private setTool(t: Tool): void {
    this.tools = { ...this.tools, tool: t };
    this.renderTools();
    this.deps.onToolsChange(this.tools);
  }

  private currentColor(): string | null {
    const t = this.tools.tool;
    return t === "pen" ? this.tools.penColor : t === "highlighter" ? this.tools.hlColor : t === "underline" ? this.tools.ulColor : null;
  }

  private renderTools(): void {
    for (const [t, b] of this.toolButtons) {
      b.classList.toggle("active", t === this.tools.tool);
      b.setAttribute("aria-pressed", String(t === this.tools.tool));
    }
    const c = this.currentColor();
    this.colorBtn.hidden = c === null;
    this.colorBtn.innerHTML = c ? `<span class="color-dot" style="background:${c}"></span>` : "";
  }

  private openPalette(): void {
    const t = this.tools.tool;
    if (t !== "pen" && t !== "highlighter" && t !== "underline") return;
    const colors = t === "pen" ? PEN_COLORS : t === "highlighter" ? HL_COLORS : UL_COLORS;
    const key = t === "pen" ? "penColor" : t === "highlighter" ? "hlColor" : "ulColor";
    const backdrop = h("div", { class: "menu-backdrop" });
    const close = () => backdrop.remove();
    const pal = h("div", { class: "palette", "data-testid": "palette" }, h("h4", {}, "Màu"));
    const sw = h("div", { class: "swatches" });
    for (const col of colors) {
      const b = h("button", {
        class: `sw ${this.tools[key] === col ? "active" : ""}`,
        type: "button",
        "aria-label": col,
        style: `background:${col}`,
      });
      b.addEventListener("click", () => {
        this.tools = { ...this.tools, [key]: col };
        this.renderTools();
        this.deps.onToolsChange(this.tools);
        close();
      });
      sw.append(b);
    }
    pal.append(sw);
    if (t === "pen") {
      pal.append(h("h4", {}, "Độ dày nét"));
      const ws = h("div", { class: "widths" });
      for (const w of PEN_WIDTHS) {
        const b = h(
          "button",
          { class: `wbtn ${this.tools.penWidth === w ? "active" : ""}`, type: "button", "aria-label": `Độ dày ${w}` },
          h("span", { style: `height:${Math.round(w * 2)}px` }),
        );
        b.addEventListener("click", () => {
          this.tools = { ...this.tools, penWidth: w };
          this.deps.onToolsChange(this.tools);
          close();
        });
        ws.append(b);
      }
      pal.append(ws);
    }
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.append(pal);
    document.body.append(backdrop);
    const r = this.colorBtn.getBoundingClientRect();
    pal.style.top = `${r.bottom + 6}px`;
    pal.style.left = `${Math.max(8, Math.min(window.innerWidth - pal.offsetWidth - 8, r.left - 100))}px`;
  }

  private openMargins(anchor: HTMLElement): void {
    const cur = this.scroller.currentMargins;
    const pattern = cur.pattern ?? "lines";
    const apply = (m: Margins) => {
      const shrinking = m.left < cur.left || m.right < cur.right;
      this.scroller.setMargins(m);
      this.deps.onMargins(this.scroller.currentMargins);
      if (shrinking && this.deps.ink.pagesWithInk().length) {
        toast("Ghi chú đã viết ở phần lề vẫn được giữ, nới lề lại là thấy.");
      }
    };
    popupMenu(anchor, [
      ...MARGIN_PRESETS.map((p) => ({
        label: `${p.left === cur.left && p.right === cur.right ? "✓ " : ""}${p.label}`,
        run: () => apply({ left: p.left, right: p.right, pattern }),
      })),
      ...PATTERNS.map((p) => ({
        label: `${p.p === pattern ? "✓ " : ""}${p.label}`,
        run: () => apply({ ...cur, pattern: p.p }),
      })),
    ]);
  }

  private async exportPdf(): Promise<void> {
    await openExportDialog({
      doc: this.deps.doc,
      ink: this.deps.ink,
      margins: this.scroller.currentMargins,
      title: this.deps.book.title,
      getFile: this.deps.getFile,
    });
  }

  private undo(): void {
    const p = this.deps.ink.undo();
    if (p !== null) this.revealPage(p);
  }

  private redo(): void {
    const p = this.deps.ink.redo();
    if (p !== null) this.revealPage(p);
  }

  /** After undo on a page that is off-screen, take the reader there. */
  private revealPage(p: number): void {
    if (!this.scroller.slotElement(p)) this.scroller.goToPage(p + 1);
  }

  private updateHistory(): void {
    this.undoBtn.disabled = !this.deps.ink.canUndo;
    this.redoBtn.disabled = !this.deps.ink.canRedo;
  }

  private onHide = (): void => {
    if (document.visibilityState === "hidden") {
      void this.deps.ink.flush();
      this.savePosition();
    }
  };

  /** Call after the element is in the document. */
  start(): void {
    this.scroller.start();
    this.scroller.el.focus({ preventScroll: true });
  }

  get scrollerForTests(): PageScroller {
    return this.scroller;
  }

  get inkForTests(): InkModel {
    return this.deps.ink;
  }

  get inkLayerForTests(): InkLayer {
    return this.ink;
  }

  private jumpFromInput(): void {
    const n = parseInt(this.pageInput.value.replace(/\D+/g, ""), 10);
    if (Number.isFinite(n)) this.scroller.goToPage(n);
    this.pageInput.value = String(this.scroller.currentPage);
  }

  private onPageChange(p: number): void {
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(p);
    this.thumbs.setCurrent(p);
    this.queueSave();
  }

  private updateZoomLabel(): void {
    this.zoomLabel.textContent = `${Math.round(this.scroller.currentZoom * 100)}%`;
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.savePosition(), 800);
  }

  private savePosition(): void {
    this.deps.onPosition(this.scroller.currentPage, this.scroller.currentZoom);
  }

  togglePanel(force?: boolean): void {
    this.panelOpen = force ?? !this.panelOpen;
    this.el.classList.toggle("panel-open", this.panelOpen);
    this.thumbs.setActive(this.panelOpen && this.tab === "thumbs");
    if (this.panelOpen && this.tab === "outline") void this.outline.ensureLoaded();
  }

  private showTab(t: PanelTab): void {
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabButtons)) b.classList.toggle("active", k === t);
    this.thumbs.el.hidden = t !== "thumbs";
    this.outline.el.hidden = t !== "outline";
    this.thumbs.setActive(this.panelOpen && t === "thumbs");
    if (t === "outline") void this.outline.ensureLoaded();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const vh = this.scroller.el.clientHeight;
    if (e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      this.scroller.el.scrollBy({ top: vh * 0.9 });
    } else if (e.key === "PageUp") {
      e.preventDefault();
      this.scroller.el.scrollBy({ top: -vh * 0.9 });
    } else if (e.key === "Home") {
      this.scroller.goToPage(1);
    } else if (e.key === "End") {
      this.scroller.goToPage(this.deps.doc.numPages);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      this.pageInput.focus();
    }
  };

  async destroy(): Promise<void> {
    clearTimeout(this.saveTimer);
    document.removeEventListener("visibilitychange", this.onHide);
    this.savePosition();
    this.ink.destroy();
    await this.deps.ink.flush();
    this.thumbs.destroy();
    this.scroller.destroy();
    this.el.remove();
    await this.deps.doc.destroy();
  }
}
