import type { InkModel } from "../../core/annotations/InkModel";
import type { Margins, PageLink, PaperPattern } from "../../core/annotations/types";
import { linkLabel } from "../../core/notebook/links";
import type { NotebookDocument } from "../../core/notebook/NotebookDocument";
import type { PagedDocument } from "../../core/pdf/PagedDocument";
import type { BookMeta } from "../../core/types";
import { JobScheduler } from "../../core/util/scheduler";
import { DWELL_MS } from "../../core/study/reading";
import type { IndexService } from "../../app/IndexService";
import { layoutChars } from "../../core/text/textGeometry";
import { runsFromWords } from "../../core/text/words";
import { SearchPanel } from "./SearchPanel";
import type { TextIndexer } from "./TextIndexer";
import { ClipCard } from "./ClipCard";
import { textFromWords, wordsInRect, type Rect } from "../../core/notebook/clips";
import { wordsFromChars } from "../../core/text/words";
import { h, icon, iconButton } from "../dom";
import { modal, popupMenu, toast } from "../feedback";
import { openExportDialog } from "./ExportDialog";
import { InkLayer, type Tool, type ToolState } from "./InkLayer";
import { NOTEBOOK_GAP, NotebookPane, autoExtend, editTextClip, notebookPageDecor, pageMenu } from "./NotebookPane";
import type { Ambience } from "../study/Ambience";
import type { StudySession } from "../study/StudySession";
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
  notebooks: NotebookHost;
  study: StudySession;
  ambience: Ambience;
  /** A page (0-based) stayed on screen long enough to count as read. */
  onPageRead: (page: number) => void;
  onBookmarks: (pages: number[]) => void;
  /** This book's search index (shared with the background indexing service). */
  indexer: TextIndexer | null;
  index: IndexService;
}

/** What the reader needs from the app to work with exercise books. */
export interface NotebookHost {
  list(): Promise<BookMeta[]>;
  create(name: string, paper: PaperPattern): Promise<BookMeta>;
  open(id: string): Promise<{ meta: BookMeta; doc: NotebookDocument; ink: InkModel }>;
  setPageCount(id: string, n: number): void;
  savePosition(id: string, page: number, zoom: number): void;
  /** Notebook last opened beside this book (reopened automatically). */
  companionId: string | null;
  setCompanion(notebookId: string | null): void;
  /** Follow a link to a different book (keeps this notebook beside it). */
  openLink(link: PageLink, notebookId: string | null): void;
  splitRatio: number;
  saveSplitRatio(r: number): void;
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

type PanelTab = "thumbs" | "outline" | "marks" | "search";

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
  private main: HTMLElement;
  private divider: HTMLElement;
  private nbPane: NotebookPane | null = null;
  private clipCard: ClipCard | null = null;
  /** Undo/redo act on the pane last written in. */
  private activeInk: InkModel;
  private activeScroller: PageScroller;
  private unsubGrow: (() => void) | null = null;
  private totalLabel: HTMLElement;
  private readonly isNotebook: boolean;
  private chips: { el: HTMLButtonElement; dispose: () => void }[] = [];
  private focusOn = false;
  private pill: HTMLElement;
  private pillPage: HTMLElement;
  private pillTools = new Map<Tool, HTMLButtonElement>();
  private dwellTimer = 0;
  private bookmarks: number[];
  private bookmarkBtn!: HTMLButtonElement;
  private marksList: HTMLElement;
  private indexer: TextIndexer | null = null;
  private searchPanel: SearchPanel | null = null;


  constructor(private readonly deps: ReaderDeps) {
    const { book, doc } = deps;
    this.isNotebook = book.kind === "notebook";
    this.bookmarks = [...(book.bookmarks ?? [])];
    this.marksList = h("div", { class: "marks", "data-testid": "marks" });
    this.tools = { ...deps.tools };
    this.activeInk = deps.ink;
    this.scroller = new PageScroller(doc, this.scheduler, {
      initialPage: book.lastPage,
      initialZoom: book.zoom,
      margins: book.margins,
      ...(book.kind === "notebook"
        ? {
            gap: NOTEBOOK_GAP,
            decorate: notebookPageDecor(doc as NotebookDocument, deps.ink, (n) => this.mainGrown(n), (p) => this.scroller.goToPage(p)),
          }
        : {}),
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
    this.thumbs = new ThumbnailPanel(
      doc,
      this.scheduler,
      nav,
      book.kind === "notebook"
        ? (p, anchor) =>
            pageMenu(
              anchor,
              doc as NotebookDocument,
              deps.ink,
              p,
              (q) => this.scroller.el.querySelector<HTMLElement>(`.page-slot[data-page="${q}"]`),
              (n) => this.mainGrown(n),
              (q) => this.scroller.goToPage(q),
            )
        : undefined,
    );
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
    this.tabButtons = {
      thumbs: mkTab("thumbs", "Trang"),
      outline: mkTab("outline", "Mục lục"),
      marks: mkTab("marks", "Đánh dấu"),
      search: mkTab("search", "Tìm"),
    };
    if (!this.isNotebook) {
      this.indexer = deps.indexer;
    }
    if (this.indexer) {
      this.searchPanel = new SearchPanel(this.indexer, (page, rects) => {
        if (rects.length) this.scroller.goToPoint(page, rects[1]);
        else this.scroller.goToPage(page + 1);
        this.ink.setMarks(page, rects);
        if (window.innerWidth < 900) this.togglePanel(false);
      }, { get: () => deps.index.paused, set: (v) => deps.index.setPaused(v) });
    }

    this.sidebar = h(
      "aside",
      { class: "sidebar", "data-testid": "sidebar" },
      h(
        "div",
        { class: "tabs" },
        this.tabButtons.thumbs,
        this.tabButtons.outline,
        this.tabButtons.marks,
        this.isNotebook ? null : this.tabButtons.search,
      ),
      h("div", { class: "sidebar-body" }, this.thumbs.el, this.outline.el, this.marksList, this.searchPanel?.el ?? null),
    );

    this.activeScroller = this.scroller;
    // Character boxes for snapping: the PDF's own, or OCR words on scans.
    const charsFor = async (p: number) => {
      const own = await doc.textChars(p);
      if (own.length) return own;
      const words = this.indexer?.snapWords(p);
      return words ? layoutChars(runsFromWords(words)) : own;
    };
    this.ink = new InkLayer(this.scroller, deps.ink, () => this.tools, () => this.updateHistory(), charsFor, {
      onActivity: () => this.setActive(deps.ink, this.scroller),
      onLinkTap: (link) => this.followLink(link, this.isNotebook ? book.id : null),
      onSelect: this.isNotebook ? undefined : (page, rect, near) => this.openClip(page, rect, near, charsFor),
      onClipTap: this.isNotebook ? (page, clip) => void editTextClip(deps.ink, page, clip) : undefined,
    });
    if (this.isNotebook) {
      this.unsubGrow = autoExtend(doc as NotebookDocument, deps.ink, (n) => this.mainGrown(n));
    }
    const toolGroup = h("div", { class: "tool-group", "data-testid": "tools" });
    const toolDefs: [Tool, string, string][] = [
      ["hand", "hand", "Chỉ đọc (bút cũng cuộn trang)"],
      ["pen", "pen", "Bút"],
      ["highlighter", "highlighter", "Bút dạ quang"],
      ["underline", "underline", "Gạch chân (nét thẳng)"],
      ["eraser", "eraser", "Tẩy (xóa cả nét)"],
      ["clip", "scissors", this.isNotebook ? "Di chuyển chữ/hình đã dán" : "Cắt chữ/hình sang vở: dùng bút kéo một khung quanh đoạn cần lấy"],
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
    this.bookmarkBtn = iconButton("bookmark", "Đánh dấu trang này", () => this.toggleBookmark());
    this.bookmarkBtn.dataset.testid = "bookmark-btn";
    const nbBtn = iconButton("notebook", "Mở vở ghi chép bên cạnh", () => void this.chooseNotebook(nbBtn));
    nbBtn.dataset.testid = "nb-btn";
    toolGroup.append(this.colorBtn, this.undoBtn, this.redoBtn, this.bookmarkBtn);
    if (!this.isNotebook) toolGroup.append(marginBtn);
    toolGroup.append(exportBtn);
    if (!this.isNotebook) toolGroup.append(nbBtn);

    const chip = deps.study.chip();
    this.chips.push(chip);
    const focusBtn = iconButton("focus", "Chế độ tập trung (toàn màn hình)", () => this.setFocus(true));
    focusBtn.dataset.testid = "focus-btn";
    const studyGroup = h("div", { class: "tool-group study-group" }, chip.el, deps.ambience.button(), focusBtn);

    const toolbar = h(
      "header",
      { class: "reader-toolbar" },
      iconButton("back", "Về kệ sách", () => deps.onClose(), "tb-back"),
      iconButton("panel", "Trang và mục lục", () => this.togglePanel(), "tb-panel"),
      h("div", { class: "reader-title", title: book.title }, book.title),
      toolGroup,
      studyGroup,
      h(
        "div",
        { class: "page-nav" },
        this.pageInput,
        (this.totalLabel = h("span", { class: "page-total", "data-testid": "page-total" }, `/ ${doc.numPages}`)),
      ),
      h(
        "div",
        { class: "zoom-group" },
        iconButton("minus", "Thu nhỏ", () => this.scroller.setZoom(this.scroller.currentZoom / 1.2)),
        this.zoomLabel,
        iconButton("plus", "Phóng to", () => this.scroller.setZoom(this.scroller.currentZoom * 1.2)),
      ),
    );

    this.divider = h("div", { class: "split-divider", role: "separator", "aria-label": "Kéo để đổi tỉ lệ", "data-testid": "divider" }, h("span"));
    this.divider.addEventListener("pointerdown", this.onDividerDown);
    this.main = h("div", { class: "reader-main" }, this.scroller.el);
    // Floating mini bar for focus mode.
    this.pillPage = h("span", { class: "pill-page", "data-testid": "pill-page" });
    const pillTool = (t: Tool, ic: string, label: string) => {
      const b = iconButton(ic, label, () => this.setTool(t), "tool-btn");
      b.dataset.tool = t;
      this.pillTools.set(t, b);
      return b;
    };
    const pillChip = deps.study.chip();
    this.chips.push(pillChip);
    const exitBtn = iconButton("close", "Thoát chế độ tập trung", () => this.setFocus(false));
    exitBtn.dataset.testid = "focus-exit";
    this.pill = h(
      "div",
      { class: "focus-pill", "data-testid": "focus-pill" },
      pillTool("hand", "hand", "Chỉ đọc"),
      pillTool("pen", "pen", "Bút"),
      pillTool("highlighter", "highlighter", "Dạ quang"),
      pillTool("eraser", "eraser", "Tẩy"),
      iconButton("undo", "Hoàn tác", () => this.undo()),
      h("span", { class: "pill-sep" }),
      this.pillPage,
      pillChip.el,
      deps.ambience.button(),
      exitBtn,
    );

    this.el = h(
      "div",
      { class: `reader ${this.isNotebook ? "is-notebook" : ""}` },
      toolbar,
      h("div", { class: "reader-body" }, this.sidebar, this.main),
      this.pill,
    );
    window.addEventListener("popstate", this.onPopState);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    this.el.addEventListener("keydown", this.onKey);
    this.showTab("thumbs");
    this.updateZoomLabel();
    this.renderTools();
    this.updateHistory();
    document.addEventListener("visibilitychange", this.onHide);
  }

  // ---- ink tools ------------------------------------------------------

  private setTool(t: Tool): void {
    if (t !== "clip") this.clipCard?.close();
    if (t === "clip" && this.tools.tool !== "clip") {
      toast(this.isNotebook ? "Dùng bút kéo chữ/hình đã dán để di chuyển." : "Dùng bút kéo một khung quanh chữ hoặc hình cần lấy.");
    }
    this.tools = { ...this.tools, tool: t };
    this.renderTools();
    this.deps.onToolsChange(this.tools);
  }

  private currentColor(): string | null {
    const t = this.tools.tool;
    return t === "pen" ? this.tools.penColor : t === "highlighter" ? this.tools.hlColor : t === "underline" ? this.tools.ulColor : null;
  }

  private renderTools(): void {
    // Clip frames and resize handles show only while the clip tool is on.
    this.el?.classList.toggle("tool-clip", this.tools.tool === "clip");
    for (const map of [this.toolButtons, this.pillTools]) {
      for (const [t, b] of map) {
        b.classList.toggle("active", t === this.tools.tool);
        b.setAttribute("aria-pressed", String(t === this.tools.tool));
      }
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

  // ---- focus mode -------------------------------------------------------

  /** Full screen, no toolbars: only the pages and a small floating bar. */
  setFocus(on: boolean, fromHistory = false): void {
    if (on === this.focusOn) return;
    this.focusOn = on;
    this.el.classList.toggle("focus", on);
    if (on) {
      this.updatePill();
      // A history entry so the Android back gesture leaves focus mode first.
      history.pushState({ ...(history.state ?? {}), focus: true }, "", location.href);
      document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
      if (this.panelOpen) this.togglePanel(false);
    } else {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      if (!fromHistory && history.state?.focus) history.back();
    }
    this.scroller.relayout();
  }

  get inFocus(): boolean {
    return this.focusOn;
  }

  private onPopState = (): void => {
    if (this.focusOn && !history.state?.focus) this.setFocus(false, true);
  };

  private onFullscreenChange = (): void => {
    // Leaving full screen with the system gesture also leaves focus mode.
    if (!document.fullscreenElement && this.focusOn && document.fullscreenEnabled) this.setFocus(false);
  };

  private updatePill(): void {
    this.pillPage.textContent = `${this.scroller.currentPage} / ${this.deps.doc.numPages}`;
  }

  private async exportPdf(): Promise<void> {
    await openExportDialog({
      doc: this.deps.doc,
      ink: this.deps.ink,
      margins: this.scroller.currentMargins,
      title: this.deps.book.title,
      getFile: this.deps.getFile,
      notebookPaper: this.isNotebook ? (this.deps.doc as NotebookDocument).pattern : undefined,
    });
  }

  // ---- notebooks --------------------------------------------------------

  private setActive(ink: InkModel, scroller: PageScroller): void {
    if (this.activeInk === ink) return;
    this.activeInk = ink;
    this.activeScroller = scroller;
    this.el.classList.toggle("nb-active", ink !== this.deps.ink);
    this.updateHistory();
  }

  private mainGrown(n: number): void {
    this.deps.notebooks.setPageCount(this.deps.book.id, n);
    this.scroller.relayout();
    this.thumbs.pagesChanged();
    this.totalLabel.textContent = `/ ${n}`;
  }

  private followLink(link: PageLink, fromNotebook: string | null): void {
    if (link.bookId === this.deps.book.id) {
      this.scroller.goToPage(link.page, true);
    } else {
      this.deps.notebooks.openLink(link, fromNotebook);
    }
  }

  private async chooseNotebook(anchor: HTMLElement): Promise<void> {
    if (this.nbPane) {
      popupMenu(anchor, [
        { label: "Đổi sang vở khác…", run: () => void this.pickNotebook() },
        { label: "Đóng vở", run: () => void this.closeNotebook() },
      ]);
      return;
    }
    await this.pickNotebook();
  }

  private async pickNotebook(): Promise<void> {
    const list = (await this.deps.notebooks.list()).sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
    const chosen = await modal((close) => {
      const name = h("input", { class: "text-input", type: "text", placeholder: "Tên vở mới, ví dụ: Vở M15 – Động cơ", "data-testid": "nb-new-name" });
      const paper = h(
        "select",
        { class: "text-input", "aria-label": "Kiểu giấy", "data-testid": "nb-new-paper" },
        h("option", { value: "lines" }, "Kẻ dòng"),
        h("option", { value: "grid" }, "Ô vuông"),
        h("option", { value: "dots" }, "Chấm"),
        h("option", { value: "blank" }, "Giấy trơn"),
      );
      const form = h(
        "form",
        { class: "nb-new" },
        name,
        paper,
        h("button", { class: "btn btn-primary", type: "submit", "data-testid": "nb-create" }, "Tạo vở"),
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const nb = await this.deps.notebooks.create(name.value, paper.value as PaperPattern);
          close(nb.id);
        } catch (err) {
          toast(err instanceof Error ? err.message : "Không tạo được vở.", "error");
        }
      });
      const rows = list.map((nb) =>
        h(
          "button",
          { class: "picker-row", type: "button", "data-testid": "nb-choice", onclick: () => close(nb.id) },
          h("span", { class: "picker-ic", html: icon("notebook", 18) }),
          h("span", { class: "picker-label" }, nb.title),
          h("span", { class: "muted small" }, `${nb.pageCount} trang`),
        ),
      );
      return h(
        "div",
        { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "data-testid": "nb-picker" },
        h("h2", {}, "Mở vở bên cạnh sách"),
        rows.length ? h("div", { class: "picker-list" }, ...rows) : h("p", {}, "Bạn chưa có vở nào. Tạo vở đầu tiên bên dưới."),
        h("h4", { class: "nb-new-title" }, "Hoặc tạo vở mới (cùng danh mục với sách này)"),
        form,
        h("div", { class: "modal-actions" }, h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy")),
      );
    });
    if (typeof chosen === "string") await this.openNotebook(chosen);
  }

  /** After framing part of a book page with the clip tool. */
  private openClip(page: number, rect: Rect, near: { left: number; top: number; right: number; bottom: number }, charsFor: (p: number) => Promise<import("../../core/text/textGeometry").CharBox[]>): void {
    this.clipCard?.close();
    const doc = this.deps.doc;
    const size = doc.pageSize(page);
    // Only the page itself (not the widened margin).
    const x0 = Math.max(0, rect[0]);
    const y0 = Math.max(0, rect[1]);
    const x1 = Math.min(size.width, rect[0] + rect[2]);
    const y1 = Math.min(size.height, rect[1] + rect[3]);
    if (x1 - x0 < 4 || y1 - y0 < 4) {
      this.ink.setSelection(null);
      return;
    }
    const r: Rect = [x0, y0, x1 - x0, y1 - y0];
    const book = this.deps.book;
    const card: ClipCard = new ClipCard({
      near,
      link: { bookId: book.id, page: page + 1, label: linkLabel(book.title, page + 1) },
      size: { w: r[2], h: r[3] },
      text: async () => textFromWords(wordsInRect(wordsFromChars(await charsFor(page)), r)),
      image: () => this.cutImage(page, r),
      hasNotebook: () => !!this.nbPane,
      openNotebook: () => void this.pickNotebook().then(() => card.refresh()),
      drop: (cx, cy, payload) => this.nbPane?.dropClip(cx, cy, payload) ?? false,
      onClose: () => {
        if (this.clipCard === card) this.clipCard = null;
        this.ink.setSelection(null);
      },
    });
    this.clipCard = card;
  }

  /** A sharp picture of part of a page (data: URL). */
  private async cutImage(page: number, r: Rect): Promise<string> {
    const size = this.deps.doc.pageSize(page);
    // ~200 dpi, capped so huge pages don't blow up memory.
    const scale = Math.min(2.8, 4200 / Math.max(size.width, size.height));
    const full = document.createElement("canvas");
    await this.deps.doc.renderPage(page, full, scale, 1, new AbortController().signal);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(r[2] * scale));
    out.height = Math.max(1, Math.round(r[3] * scale));
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(full, r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale, 0, 0, out.width, out.height);
    full.width = 0;
    let url = out.toDataURL("image/png");
    if (url.length > 1_800_000) url = out.toDataURL("image/jpeg", 0.9); // photos: smaller as JPEG
    out.width = 0;
    return url;
  }

  async openNotebook(id: string): Promise<void> {
    if (this.nbPane?.id === id) return;
    await this.closeNotebook(false);
    let opened;
    try {
      opened = await this.deps.notebooks.open(id);
    } catch {
      toast("Không mở được vở này (có thể đã bị xóa).", "error");
      this.deps.notebooks.setCompanion(null);
      return;
    }
    const { meta, doc, ink } = opened;
    const host = this.deps.notebooks;
    let pane: NotebookPane;
    pane = new NotebookPane({
      meta,
      doc,
      ink,
      tools: () => this.tools,
      onActivity: () => this.setActive(ink, pane.scroller),
      onHistory: () => this.updateHistory(),
      currentBookLink: () =>
        this.isNotebook
          ? null
          : { bookId: this.deps.book.id, page: this.scroller.currentPage, label: linkLabel(this.deps.book.title, this.scroller.currentPage) },
      onLinkTap: (link) => this.followLink(link, meta.id),
      onClose: () => void this.closeNotebook(),
      onPageCount: (n) => host.setPageCount(meta.id, n),
      onPosition: (page, zoom) => host.savePosition(meta.id, page, zoom),
    });
    this.nbPane = pane;
    this.main.append(this.divider, pane.el);
    this.el.classList.add("split");
    this.applyRatio(host.splitRatio);
    pane.start();
    host.setCompanion(meta.id);
    this.clipCard?.refresh();
  }

  async closeNotebook(forget = true): Promise<void> {
    const pane = this.nbPane;
    if (!pane) return;
    this.nbPane = null;
    this.clipCard?.refresh();
    if (this.activeInk !== this.deps.ink) this.setActive(this.deps.ink, this.scroller);
    await pane.destroy();
    this.divider.remove();
    this.el.classList.remove("split");
    this.scroller.el.style.flexBasis = "";
    if (forget) this.deps.notebooks.setCompanion(null);
    this.scroller.relayout();
  }

  private applyRatio(r: number): void {
    const ratio = Math.min(0.8, Math.max(0.2, r));
    this.scroller.el.style.flexBasis = `${ratio * 100}%`;
  }

  private onDividerDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.divider.setPointerCapture(e.pointerId);
    this.divider.classList.add("dragging");
    const rect = this.main.getBoundingClientRect();
    const vertical = getComputedStyle(this.main).flexDirection === "column";
    let ratio = this.deps.notebooks.splitRatio;
    const move = (ev: PointerEvent) => {
      ratio = vertical ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      this.applyRatio(ratio);
    };
    const up = () => {
      this.divider.classList.remove("dragging");
      this.divider.removeEventListener("pointermove", move);
      this.divider.removeEventListener("pointerup", up);
      this.divider.removeEventListener("pointercancel", up);
      this.deps.notebooks.saveSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    };
    this.divider.addEventListener("pointermove", move);
    this.divider.addEventListener("pointerup", up);
    this.divider.addEventListener("pointercancel", up);
  };

  private undo(): void {
    const p = this.activeInk.undo();
    if (p !== null) this.revealPage(p);
  }

  private redo(): void {
    const p = this.activeInk.redo();
    if (p !== null) this.revealPage(p);
  }

  /** After undo on a page that is off-screen, take the reader there. */
  private revealPage(p: number): void {
    if (!this.activeScroller.slotElement(p)) this.activeScroller.goToPage(p + 1);
  }

  private updateHistory(): void {
    if (!this.undoBtn) return;
    this.undoBtn.disabled = !this.activeInk.canUndo;
    this.redoBtn.disabled = !this.activeInk.canRedo;
  }

  private onHide = (): void => {
    if (document.visibilityState === "hidden") {
      void this.deps.ink.flush();
      this.savePosition();
      void this.nbPane?.flush();
    }
  };

  /** Call after the element is in the document. */
  start(): void {
    this.scroller.start();
    this.updateBookmarkBtn();
    this.armDwell(this.scroller.currentPage);
    // This book jumps the background indexing/OCR queue, nearest pages first.
    if (this.indexer) this.deps.index.focus(this.deps.book.id, () => this.scroller.currentPage);
    this.scroller.el.focus({ preventScroll: true });
    const companion = this.deps.notebooks.companionId;
    if (companion && !this.isNotebook) void this.openNotebook(companion);
  }

  get indexerForTests(): TextIndexer | null {
    return this.indexer;
  }

  get notebookPaneForTests(): NotebookPane | null {
    return this.nbPane;
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

  // ---- bookmarks and reading progress --------------------------------

  private toggleBookmark(): void {
    const p = this.scroller.currentPage;
    this.bookmarks = this.bookmarks.includes(p) ? this.bookmarks.filter((x) => x !== p) : [...this.bookmarks, p].sort((a, b) => a - b);
    this.deps.onBookmarks(this.bookmarks);
    toast(this.bookmarks.includes(p) ? `Đã đánh dấu trang ${p}.` : `Đã bỏ đánh dấu trang ${p}.`);
    this.updateBookmarkBtn();
    this.renderMarks();
  }

  private updateBookmarkBtn(): void {
    const on = this.bookmarks.includes(this.scroller.currentPage);
    this.bookmarkBtn.classList.toggle("marked", on);
    this.bookmarkBtn.setAttribute("aria-pressed", String(on));
  }

  private renderMarks(): void {
    if (!this.bookmarks.length) {
      this.marksList.replaceChildren(h("p", { class: "muted pad" }, "Chưa có trang nào được đánh dấu. Bấm nút 🔖 trên thanh công cụ để đánh dấu trang đang đọc."));
      return;
    }
    this.marksList.replaceChildren(
      ...this.bookmarks.map((p) => {
        const row = h(
          "div",
          { class: "mark-row" },
          h("button", { class: "outline-item", type: "button", onclick: () => this.scroller.goToPage(p) }, h("span", { class: "outline-title" }, `Trang ${p}`)),
          iconButton("close", `Bỏ đánh dấu trang ${p}`, () => {
            this.bookmarks = this.bookmarks.filter((x) => x !== p);
            this.deps.onBookmarks(this.bookmarks);
            this.updateBookmarkBtn();
            this.renderMarks();
          }),
        );
        return row;
      }),
    );
  }

  /** A page counts as read after DWELL_MS as the main page, app visible. */
  private armDwell(p: number): void {
    clearTimeout(this.dwellTimer);
    if (this.isNotebook) return;
    this.dwellTimer = window.setTimeout(() => {
      if (document.visibilityState === "visible" && this.scroller.currentPage === p) this.deps.onPageRead(p - 1);
    }, (window as unknown as { __dwellMs?: number }).__dwellMs ?? DWELL_MS); // tests may shorten it
  }

  private onPageChange(p: number): void {
    this.updateBookmarkBtn();
    this.armDwell(p);
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(p);
    if (this.focusOn) this.updatePill();
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
    this.marksList.hidden = t !== "marks";
    if (this.searchPanel) this.searchPanel.el.hidden = t !== "search";
    if (t === "marks") this.renderMarks();
    if (t === "search") this.searchPanel?.focus();
    this.thumbs.setActive(this.panelOpen && t === "thumbs");
    if (t === "outline") void this.outline.ensureLoaded();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "Escape" && this.focusOn) {
      this.setFocus(false);
      return;
    }
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
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && this.searchPanel) {
      e.preventDefault();
      if (!this.panelOpen) this.togglePanel(true);
      this.showTab("search");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      this.pageInput.focus();
    }
  };

  async destroy(): Promise<void> {
    clearTimeout(this.saveTimer);
    clearTimeout(this.dwellTimer);
    this.deps.index.focus(null);
    this.searchPanel?.destroy();
    this.clipCard?.close();
    if (this.focusOn) this.setFocus(false, true);
    window.removeEventListener("popstate", this.onPopState);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    for (const c of this.chips) c.dispose();
    document.removeEventListener("visibilitychange", this.onHide);
    this.savePosition();
    await this.closeNotebook(false);
    this.unsubGrow?.();
    this.ink.destroy();
    await this.deps.ink.flush();
    this.thumbs.destroy();
    this.scroller.destroy();
    this.el.remove();
    await this.deps.doc.destroy();
  }
}
