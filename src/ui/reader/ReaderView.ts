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
import { PenCase, TOOL_ICON, toolName, type PenSlot } from "./PenCase";
import { QuickWheel } from "./QuickWheel";
import { applyTheme, currentTheme } from "../theme";

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
  private zoomLabel: HTMLElement;
  private sidebar: HTMLElement;
  private tabButtons: Record<PanelTab, HTMLButtonElement>;
  private panelOpen = false;
  private tab: PanelTab = "thumbs";
  private saveTimer = 0;
  private ink: InkLayer;
  private tools: ToolState;
  private pencase: PenCase;
  private wheel = new QuickWheel();
  private edge: HTMLElement;
  private drawer: HTMLElement;
  private scrim: HTMLElement;
  private drawerBtn: HTMLButtonElement;
  private hud: HTMLElement;
  private hudTimer = 0;
  /** Recent finger/wheel input: only the user's own scrolling hides the edge. */
  private userScrollAt = 0;
  private penAt = 0;
  private lastScrollTop = 0;
  /** After the edge is called back on purpose it stays a moment. */
  private edgePinnedUntil = 0;
  private edgeZone!: HTMLElement;
  private colObs: ResizeObserver | null = null;
  private gesture: { start: number; max: number; moved: boolean; x: number; y: number; long: number } | null = null;
  private main: HTMLElement;
  private divider: HTMLElement;
  private nbPane: NotebookPane | null = null;
  private clipCard: ClipCard | null = null;
  /** Undo/redo act on the pane last written in. */
  private activeInk: InkModel;
  private activeScroller: PageScroller;
  private unsubGrow: (() => void) | null = null;
  private totalLabel: HTMLElement;
  /** Brass hairline under the running head: where you are in the book. */
  private progressLine: HTMLElement;
  private readonly isNotebook: boolean;
  private chips: { el: HTMLButtonElement; dispose: () => void }[] = [];
  private focusOn = false;
  private dwellTimer = 0;
  private bookmarks: number[];
  private bookmarkBtn!: HTMLButtonElement;
  private focusTile!: HTMLButtonElement;
  private dockTile!: HTMLButtonElement;
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

    this.zoomLabel = h("span", { class: "zoom-label tile-big", "data-testid": "zoom-label" });

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
    // ---- the pen case (docked on an edge) and the quick wheel
    this.el = h("div", { class: `reader ${this.isNotebook ? "is-notebook" : ""}` });
    this.pencase = new PenCase({
      notebook: this.isNotebook,
      get: () => this.tools,
      set: (st) => this.applyTools(st),
      setTool: (t) => this.setTool(t),
      undo: () => this.undo(),
      redo: () => this.redo(),
      host: this.el,
      onDock: () => requestAnimationFrame(() => {
        this.syncEdge();
        this.renderDockTile();
      }),
    });

    // ---- the thin top edge: back, title, timer when running, page, drawer
    const chip = deps.study.chip();
    this.chips.push(chip);
    chip.el.classList.add("edge-timer");
    this.drawerBtn = h("button", { class: "edge-btn", type: "button", "data-testid": "drawer-btn", "aria-label": "Ngăn kéo", title: "Ngăn kéo", html: icon("more", 22) });
    this.drawerBtn.addEventListener("click", () => this.openDrawer(true));
    this.edge = h(
      "header",
      { class: "reader-edge", "data-testid": "reader-edge" },
      h("button", { class: "edge-btn tb-back", type: "button", "aria-label": "Về kệ sách", title: "Về kệ sách", html: icon("back", 22), onclick: () => deps.onClose() }),
      h("div", { class: "edge-title" }, h("span", { class: "rh-orn", "aria-hidden": "true" }, "❦"), h("span", { class: "reader-title", title: book.title }, book.title), h("span", { class: "rh-orn", "aria-hidden": "true" }, "❦")),
      chip.el,
      h(
        "label",
        { class: "edge-page", title: "Chạm để gõ số trang" },
        this.pageInput,
        (this.totalLabel = h("span", { class: "page-total", "data-testid": "page-total" }, `/ ${doc.numPages}`)),
      ),
      this.drawerBtn,
      (this.progressLine = h("i", { class: "rh-progress", "data-testid": "read-progress", "aria-hidden": "true" })),
    );
    const edgeZone = h("div", { class: "edge-zone", "aria-hidden": "true" });
    this.edgeZone = edgeZone;
    edgeZone.addEventListener("pointerdown", () => this.revealChrome());

    // ---- the drawer: everything else, grouped, with a command filter
    this.scrim = h("div", { class: "drawer-scrim" });
    this.scrim.addEventListener("click", () => this.openDrawer(false));
    this.drawer = this.buildDrawer(deps);

    this.hud = h("div", { class: "reader-hud", "data-testid": "hud", "aria-live": "polite" });

    this.divider = h("div", { class: "split-divider", role: "separator", "aria-label": "Kéo để đổi tỉ lệ", "data-testid": "divider" }, h("span"));
    this.divider.addEventListener("pointerdown", this.onDividerDown);
    this.main = h("div", { class: "reader-main" }, this.scroller.el);
    this.wireGestures();
    // the top edge belongs to the book's column (the notebook has its own header)
    this.colObs = new ResizeObserver(() => this.syncEdge());
    this.colObs.observe(this.scroller.el);

    this.el.append(
      h("div", { class: "reader-body" }, this.sidebar, this.main),
      this.edge,
      edgeZone,
      this.pencase.el,
      this.pencase.tray,
      this.hud,
      this.wheel.el,
      this.scrim,
      this.drawer,
    );
    this.setProgressLine(Math.min(book.lastPage, doc.numPages));
    window.addEventListener("popstate", this.onPopState);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    this.el.addEventListener("keydown", this.onKey);
    this.showTab("thumbs");
    this.updateZoomLabel();
    this.renderTools();
    this.updateHistory();
    document.addEventListener("visibilitychange", this.onHide);
  }

  // ---- chrome: the top edge, the drawer, the HUD -------------------------

  /** The thin top edge slides away while you read or write; it comes back when you scroll up or touch the top. */
  showEdge(on: boolean): void {
    if (!on && (this.drawer?.classList.contains("open") || this.panelOpen || document.activeElement === this.pageInput)) return;
    this.edge?.classList.toggle("away", !on);
  }

  /** Keep the top edge over the book column only (beside the notebook and the pen rail). */
  private syncEdge(): void {
    if (!this.el.isConnected) return;
    const r = this.el.getBoundingClientRect();
    const c = this.scroller.el.getBoundingClientRect();
    if (!c.width) return;
    for (const e of [this.edge, this.edgeZone]) {
      e.style.left = `${Math.max(0, c.left - r.left)}px`;
      e.style.right = `${Math.max(0, r.right - c.right)}px`;
    }
  }

  /** For tests and the keyboard: bring the top edge back. */
  revealChrome(): void {
    this.edgePinnedUntil = Date.now() + 1200;
    this.showEdge(true);
  }

  private showHud(text: string): void {
    if (!this.hud) return;
    this.hud.textContent = text;
    this.hud.classList.add("show");
    clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => this.hud.classList.remove("show"), 1100);
  }

  openDrawer(open: boolean): void {
    this.drawer.classList.toggle("open", open);
    this.scrim.classList.toggle("open", open);
    this.drawerBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      this.pencase.openTray(false);
      this.showEdge(true);
      const f = this.drawer.querySelector<HTMLInputElement>(".drawer-find");
      if (f) {
        f.value = "";
        this.filterDrawer("");
      }
    }
  }

  private filterDrawer(q: string): void {
    const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
    const k = norm(q.trim());
    for (const t of this.drawer.querySelectorAll<HTMLElement>(".tile")) t.hidden = !!k && !norm(`${t.textContent} ${t.dataset.keys ?? ""}`).includes(k);
    for (const g of this.drawer.querySelectorAll<HTMLElement>(".drawer-group")) g.hidden = ![...g.querySelectorAll<HTMLElement>(".tile")].some((t) => !t.hidden);
  }

  private buildDrawer(deps: ReaderDeps): HTMLElement {
    const nb = this.isNotebook;
    const anchor = () => this.drawerBtn;
    const tile = (testid: string, ic: string, label: string, keys: string, run: () => void, extraClass = "") => {
      const b = h("button", { class: `tile ${extraClass}`, type: "button", "data-testid": testid, "data-keys": keys }, h("span", { class: "tile-ic", html: icon(ic, 22) }), h("span", { class: "tile-label" }, label));
      b.addEventListener("click", () => {
        this.openDrawer(false);
        run();
      });
      return b;
    };
    const group = (title: string, ...tiles: (HTMLElement | null)[]) =>
      h("section", { class: "drawer-group" }, h("div", { class: "drawer-k" }, title), h("div", { class: "drawer-grid" }, ...tiles.filter((t): t is HTMLElement => !!t)));

    this.bookmarkBtn = tile("bookmark-btn", "bookmark", "Đánh dấu trang", "bookmark danh dau", () => this.toggleBookmark());
    const panel = tile("tb-panel", "panel", "Mục lục & trang", "muc luc trang thumbnail outline", () => this.togglePanel(), "tb-panel");
    const search = nb ? null : tile("search-btn", "search", "Tìm trong sách", "tim kiem search", () => {
      if (!this.panelOpen) this.togglePanel(true);
      this.showTab("search");
    });
    const notebook = nb ? null : tile("nb-btn", "notebook", "Vở bên cạnh", "vo ghi chep notebook song song", () => void this.chooseNotebook(anchor()));
    const margin = nb ? null : tile("margin-btn", "margin", "Nới rộng lề", "le margin noi rong", () => this.openMargins(anchor()));
    const exp = tile("export-btn", "exportPdf", "Xuất PDF có ghi chú", "xuat export pdf in", () => void this.exportPdf());
    const timer = tile("drawer-timer", "timer", "Hẹn giờ học", "gio hen gio dong ho timer hoc nghi", () => void deps.study.openPanel(anchor()));
    // the ambience button keeps its own panel; it becomes a tile here
    const amb = deps.ambience.button();
    amb.className = "tile";
    amb.dataset.keys = "am thanh mua anh sang am ton giay";
    amb.innerHTML = `<span class="tile-ic">${icon("sun", 22)}</span><span class="tile-label">Ánh sáng &amp; âm thanh</span>`;
    amb.addEventListener("click", () => this.openDrawer(false));
    this.focusTile = tile("focus-btn", "focus", "Toàn màn hình", "toan man hinh tap trung fullscreen focus", () => this.setFocus(!this.focusOn));
    const zoomOut = tile("zoom-out", "minus", "Thu nhỏ", "thu nho zoom", () => this.scroller.setZoom(this.scroller.currentZoom / 1.2));
    zoomOut.setAttribute("aria-label", "Thu nhỏ");
    const fit = h("button", { class: "tile", type: "button", "data-testid": "zoom-fit", "data-keys": "vua kho zoom 100 chieu rong", title: "Vừa chiều rộng" }, this.zoomLabel, h("span", { class: "tile-label" }, "Vừa khổ"));
    fit.addEventListener("click", () => {
      this.openDrawer(false);
      this.scroller.setZoom(1);
    });
    const zoomIn = tile("zoom-in", "plus", "Phóng to", "phong to zoom", () => this.scroller.setZoom(this.scroller.currentZoom * 1.2));
    zoomIn.setAttribute("aria-label", "Phóng to");
    const theme = tile("theme-btn", "sun", "Giấy da / Ánh nến", "giao dien sang toi dem anh nen giay da theme", () => applyTheme(currentTheme() === "night" ? "day" : "night"));
    this.dockTile = tile("dock-btn", "hand", "", "hop but tay thuan trai phai canh", () => {
      this.pencase.setDock(this.pencase.dock === "right" ? "left" : "right");
    });
    this.renderDockTile();
    this.renderFocusTile();

    const find = h("input", { class: "drawer-find", type: "search", placeholder: "Gõ để tìm lệnh… (vd: lề, giờ, xuất)", "aria-label": "Tìm lệnh", "data-testid": "drawer-find" }) as HTMLInputElement;
    find.addEventListener("input", () => this.filterDrawer(find.value));
    find.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.drawer.querySelector<HTMLElement>(".tile:not([hidden])")?.click();
    });
    return h(
      "aside",
      { class: "reader-drawer", "data-testid": "drawer", "aria-label": "Ngăn kéo" },
      h("div", { class: "drawer-head" }, h("h3", {}, "Ngăn kéo"), h("button", { class: "edge-btn", type: "button", "aria-label": "Đóng", html: icon("close", 20), onclick: () => this.openDrawer(false) })),
      find,
      group("ĐỌC", panel, search, this.bookmarkBtn),
      group("GHI CHÉP", notebook, margin, exp),
      group("HỌC", timer, amb, this.focusTile),
      group("HIỂN THỊ", zoomOut, fit, zoomIn, theme, this.dockTile),
    );
  }

  private renderFocusTile(): void {
    const l = this.focusTile?.querySelector(".tile-label");
    if (l) l.textContent = this.focusOn ? "Thoát toàn màn hình" : "Toàn màn hình";
  }

  private renderDockTile(): void {
    const l = this.dockTile?.querySelector(".tile-label");
    if (l) l.innerHTML = `Hộp bút: cạnh <b>${this.pencase.dock === "left" ? "trái" : "phải"}</b>`;
  }

  /**
   * Fingers on the page: hold still to open the quick wheel, tap with two
   * fingers to undo, three to redo. The pen writes; scrolling is untouched.
   */
  private wireGestures(): void {
    const m = this.main;
    // no stylus, no palm (a large contact): a resting hand is never a gesture
    const fingers = (l: TouchList) => [...l].filter((t) => (t as Touch & { touchType?: string }).touchType !== "stylus" && Math.max(t.radiusX || 0, t.radiusY || 0) <= 28);
    m.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "pen" || (e.pointerType === "mouse" && e.button === 0 && this.tools.tool !== "hand")) {
        this.penAt = Date.now();
        if (this.tools.tool !== "hand") {
          this.showEdge(false);
          this.pencase.setDrawing(true);
        }
      }
      if (e.pointerType === "touch") this.userScrollAt = Date.now();
    });
    const penUp = (e: PointerEvent) => {
      if (e.pointerType === "pen" || e.pointerType === "mouse") this.pencase.setDrawing(false);
    };
    m.addEventListener("pointerup", penUp);
    m.addEventListener("pointercancel", penUp);
    m.addEventListener("wheel", () => (this.userScrollAt = Date.now()), { passive: true });
    m.addEventListener("contextmenu", (e) => {
      if ((e as PointerEvent).pointerType !== "mouse") e.preventDefault();
    });
    m.addEventListener(
      "touchstart",
      (e) => {
        this.userScrollAt = Date.now();
        const f = fingers(e.touches);
        if (!f.length) return;
        if (!this.gesture || e.touches.length === 1) {
          if (this.gesture) clearTimeout(this.gesture.long);
          const t = f[0];
          this.gesture = { start: Date.now(), max: f.length, moved: false, x: t.clientX, y: t.clientY, long: 0 };
          if (f.length === 1) {
            const g = this.gesture;
            g.long = window.setTimeout(() => {
              if (this.gesture === g && !g.moved && g.max === 1 && Date.now() - this.penAt > 600) this.openWheel(g.x, g.y);
            }, 480);
          }
        } else {
          this.gesture.max = Math.max(this.gesture.max, f.length);
          clearTimeout(this.gesture.long);
        }
      },
      { passive: true },
    );
    m.addEventListener(
      "touchmove",
      (e) => {
        const t = fingers(e.touches)[0];
        if (this.wheel.open) {
          e.preventDefault(); // the wheel owns this finger: no scrolling
          if (t) this.wheel.move(t.clientX, t.clientY);
          return;
        }
        const g = this.gesture;
        if (g && t && Math.hypot(t.clientX - g.x, t.clientY - g.y) > 12) {
          g.moved = true;
          clearTimeout(g.long);
        }
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      if (this.wheel.open) {
        if (e.touches.length === 0) this.closeWheel(e.type === "touchend");
        return;
      }
      const g = this.gesture;
      if (!g || e.touches.length) return;
      clearTimeout(g.long);
      this.gesture = null;
      if (e.type === "touchend" && !g.moved && g.max >= 2 && Date.now() - g.start < 350 && Date.now() - this.penAt > 600) {
        if (g.max === 2) {
          this.undo();
          this.showHud("Hoàn tác");
        } else {
          this.redo();
          this.showHud("Làm lại");
        }
      }
    };
    m.addEventListener("touchend", end);
    m.addEventListener("touchcancel", end);
    // only the reader's own scrolling hides or brings back the edge
    this.scroller.el.addEventListener(
      "scroll",
      () => {
        const top = this.scroller.el.scrollTop;
        const d = top - this.lastScrollTop;
        this.lastScrollTop = top;
        if (Date.now() - this.userScrollAt > 800) return;
        if (d > 8 && top > 60 && Date.now() >= this.edgePinnedUntil) this.showEdge(false);
        else if (d < -8) this.showEdge(true);
      },
      { passive: true },
    );
  }

  private openWheel(x: number, y: number): void {
    const nb = this.isNotebook;
    const t = (k: Tool) => ({ key: k, label: toolName(k, nb), icon: TOOL_ICON[k] });
    this.pencase.openTray(false);
    this.wheel.show(x, y, [t("pen"), t("highlighter"), t("underline"), t("eraser"), t("clip"), t("hand"), { key: "undo", label: "Hoàn tác", icon: "undo" }, { key: "redo", label: "Làm lại", icon: "redo" }]);
  }

  private closeWheel(apply: boolean): void {
    const k = this.wheel.close();
    this.gesture = null;
    if (!apply || !k) return;
    if (k === "undo") return this.undo();
    if (k === "redo") return this.redo();
    this.setTool(k as Tool);
    this.showHud(toolName(k as Tool, this.isNotebook));
  }

  /** Tests: open the wheel at a point, point towards a slice, lift. */
  wheelForTests(x: number, y: number, toX: number, toY: number): string | null {
    this.openWheel(x, y);
    this.wheel.move(toX, toY);
    const k = this.wheel.chosen;
    this.closeWheel(true);
    return k;
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

  private renderTools(): void {
    // Clip frames and resize handles show only while the clip tool is on.
    this.el?.classList.toggle("tool-clip", this.tools.tool === "clip");
    this.pencase?.render();
  }

  /** New tool state from the pen case (slot, colour, width). */
  private applyTools(st: ToolState & { slots?: PenSlot[] }): void {
    if (st.tool !== this.tools.tool) {
      this.setTool(st.tool);
    }
    this.tools = { ...st };
    this.renderTools();
    this.deps.onToolsChange(this.tools);
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
    this.renderFocusTile();
    this.showEdge(!on);
    if (on) {
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
    this.pencase?.setHistory(this.activeInk.canUndo, this.activeInk.canRedo);
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
    this.syncEdge();
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
    const label = this.bookmarkBtn.querySelector(".tile-label");
    if (label) label.textContent = on ? "Bỏ đánh dấu" : "Đánh dấu trang";
  }

  private renderMarks(): void {
    if (!this.bookmarks.length) {
      this.marksList.replaceChildren(h("p", { class: "muted pad" }, "Chưa có trang nào được đánh dấu. Mở ngăn kéo ⋯ và chọn “Đánh dấu trang” để đánh dấu trang đang đọc."));
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
    if (Date.now() - this.userScrollAt < 800 && this.edge.classList.contains("away")) this.showHud(`Trang ${p} / ${this.deps.doc.numPages}`);
    this.thumbs.setCurrent(p);
    this.setProgressLine(p);
    this.queueSave();
  }

  private setProgressLine(p: number): void {
    const n = this.deps.doc.numPages;
    const f = n > 1 ? (p - 1) / (n - 1) : 1;
    this.progressLine.style.width = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`;
    this.progressLine.title = `Trang ${p}/${n}`;
  }

  private updateZoomLabel(): void {
    const t = `${Math.round(this.scroller.currentZoom * 100)}%`;
    if (this.zoomLabel.textContent && this.zoomLabel.textContent !== t) this.showHud(t);
    this.zoomLabel.textContent = t;
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
    if (this.panelOpen) this.showEdge(true);
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
    if (e.key === "Escape" && this.drawer.classList.contains("open")) {
      this.openDrawer(false);
      return;
    }
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
      this.showEdge(true);
      this.pageInput.focus();
    }
  };

  async destroy(): Promise<void> {
    clearTimeout(this.saveTimer);
    clearTimeout(this.dwellTimer);
    clearTimeout(this.hudTimer);
    this.colObs?.disconnect();
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
