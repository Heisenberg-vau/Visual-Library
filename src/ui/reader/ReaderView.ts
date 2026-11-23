import type { PagedDocument } from "../../core/pdf/PagedDocument";
import type { BookMeta } from "../../core/types";
import { JobScheduler } from "../../core/util/scheduler";
import { h, iconButton } from "../dom";
import { OutlinePanel } from "./OutlinePanel";
import { PageScroller } from "./PageScroller";
import { ThumbnailPanel } from "./ThumbnailPanel";

export interface ReaderDeps {
  book: BookMeta;
  doc: PagedDocument;
  onClose: () => void;
  onPosition: (page: number, zoom: number) => void;
}

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

  constructor(private readonly deps: ReaderDeps) {
    const { book, doc } = deps;
    this.scroller = new PageScroller(doc, this.scheduler, {
      initialPage: book.lastPage,
      initialZoom: book.zoom,
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

    const toolbar = h(
      "header",
      { class: "reader-toolbar" },
      iconButton("back", "Về kệ sách", () => deps.onClose(), "tb-back"),
      iconButton("panel", "Trang và mục lục", () => this.togglePanel(), "tb-panel"),
      h("div", { class: "reader-title", title: book.title }, book.title),
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
  }

  /** Call after the element is in the document. */
  start(): void {
    this.scroller.start();
    this.scroller.el.focus({ preventScroll: true });
  }

  get scrollerForTests(): PageScroller {
    return this.scroller;
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
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      this.pageInput.focus();
    }
  };

  async destroy(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.savePosition();
    this.thumbs.destroy();
    this.scroller.destroy();
    this.el.remove();
    await this.deps.doc.destroy();
  }
}
