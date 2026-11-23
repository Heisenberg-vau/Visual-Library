import type { InkModel } from "../../core/annotations/InkModel";
import type { PageLink } from "../../core/annotations/types";
import type { NotebookDocument } from "../../core/notebook/NotebookDocument";
import type { BookMeta } from "../../core/types";
import { JobScheduler } from "../../core/util/scheduler";
import { h, icon, iconButton } from "../dom";
import { confirmDialog, toast } from "../feedback";
import { InkLayer, type ToolState } from "./InkLayer";
import { PageScroller } from "./PageScroller";

export interface NotebookPaneDeps {
  meta: BookMeta;
  doc: NotebookDocument;
  ink: InkModel;
  tools: () => ToolState;
  onActivity: () => void;
  onHistory: () => void;
  /** Link to the page currently open in the book pane. */
  currentBookLink: () => PageLink | null;
  onLinkTap: (link: PageLink) => void;
  onClose: () => void;
  onPageCount: (n: number) => void;
  onPosition: (page: number, zoom: number) => void;
}

/**
 * Grows a notebook when ink lands on its last page, so there is always a
 * fresh page below. Shared by the split pane and full-screen notebooks.
 */
export function autoExtend(doc: NotebookDocument, ink: InkModel, onGrow: (n: number) => void): () => void {
  return ink.onAdd((page) => {
    if (page === doc.numPages - 1) onGrow(doc.addPages(1));
  });
}

/** Inserts a blank page after 1-based `current`; returns the new page number. */
export function insertPageAfter(doc: NotebookDocument, ink: InkModel, current: number): number {
  doc.addPages(1);
  ink.insertPage(current); // 0-based index of the new page = current
  return current + 1;
}

/** Deletes 1-based page `current` (asks first if it has writing). Returns true if deleted. */
export async function deletePageAsk(doc: NotebookDocument, ink: InkModel, current: number): Promise<boolean> {
  if (doc.numPages <= 1) {
    toast("Vở cần ít nhất 1 trang.");
    return false;
  }
  if (ink.strokes(current - 1).length) {
    const ok = await confirmDialog(
      `Xóa trang ${current}?`,
      "Trang này có ghi chép. Xóa trang sẽ xóa luôn ghi chép trên đó và không hoàn tác được.",
      "Xóa trang",
      true,
    );
    if (!ok) return false;
  }
  doc.removePage();
  ink.deletePage(current - 1);
  toast(`Đã xóa trang ${current}.`);
  return true;
}

/** The exercise book shown beside a book in split view. */
export class NotebookPane {
  readonly el: HTMLElement;
  readonly scroller: PageScroller;
  readonly inkLayer: InkLayer;
  private scheduler = new JobScheduler(1);
  private pageLabel: HTMLElement;
  private linkBtn: HTMLButtonElement;
  private armedLink: PageLink | null = null;
  private unsubGrow: () => void;
  private saveTimer = 0;

  constructor(private readonly deps: NotebookPaneDeps) {
    const { meta, doc } = deps;
    this.scroller = new PageScroller(doc, this.scheduler, {
      initialPage: Math.min(meta.lastPage, doc.numPages),
      initialZoom: meta.zoom,
      onPageChange: () => {
        this.updateLabel();
        this.queueSave();
      },
      onZoomChange: () => this.queueSave(),
    });
    this.scroller.el.classList.add("nb-scroller");
    this.inkLayer = new InkLayer(this.scroller, deps.ink, deps.tools, deps.onHistory, () => doc.textChars(), {
      onActivity: deps.onActivity,
      linkToPlace: () => this.armedLink,
      onLinkPlaced: () => this.setArmed(null),
      onLinkTap: deps.onLinkTap,
    });
    this.unsubGrow = autoExtend(doc, deps.ink, (n) => this.grown(n));

    this.pageLabel = h("span", { class: "nb-page", "data-testid": "nb-page" });
    this.linkBtn = h("button", {
      class: "btn btn-ghost nb-link",
      type: "button",
      "data-testid": "nb-link",
      html: `${icon("link", 18)}<span>Ghim trang sách</span>`,
      title: "Gắn một nhãn trỏ về trang sách đang mở; chạm vào nhãn để nhảy tới trang đó",
    });
    this.linkBtn.addEventListener("click", () => {
      if (this.armedLink) return this.setArmed(null);
      const link = deps.currentBookLink();
      if (link) this.setArmed(link);
    });
    const addBtn = iconButton("addPage", "Chèn trang trắng sau trang này", () => {
      const p = insertPageAfter(doc, deps.ink, this.scroller.currentPage);
      this.grown(doc.numPages);
      this.scroller.goToPage(p);
    });
    addBtn.dataset.testid = "nb-add-page";
    const delBtn = iconButton("trash", "Xóa trang này", async () => {
      const cur = this.scroller.currentPage;
      if (await deletePageAsk(doc, deps.ink, cur)) {
        this.grown(doc.numPages);
        this.scroller.goToPage(Math.min(cur, doc.numPages));
      }
    });
    delBtn.dataset.testid = "nb-del-page";
    const closeBtn = iconButton("close", "Đóng vở", () => deps.onClose());
    closeBtn.dataset.testid = "nb-close";

    this.el = h(
      "section",
      { class: "nb-pane", "data-testid": "nb-pane" },
      h(
        "header",
        { class: "nb-header" },
        h("span", { class: "nb-icon", html: icon("notebook", 20) }),
        h("span", { class: "nb-title", title: meta.title }, meta.title),
        this.pageLabel,
        this.linkBtn,
        addBtn,
        delBtn,
        closeBtn,
      ),
      this.scroller.el,
    );
    this.updateLabel();
  }

  flush(): Promise<void> {
    this.deps.onPosition(this.scroller.currentPage, this.scroller.currentZoom);
    return this.deps.ink.flush();
  }

  get inkModel(): InkModel {
    return this.deps.ink;
  }

  get id(): string {
    return this.deps.meta.id;
  }

  start(): void {
    this.scroller.start();
  }

  private setArmed(link: PageLink | null): void {
    this.armedLink = link;
    this.linkBtn.classList.toggle("armed", !!link);
    this.el.classList.toggle("placing-link", !!link);
    if (link) toast(`Chạm bút vào vở để đặt nhãn “${link.label}”.`);
  }

  private grown(n: number): void {
    this.deps.onPageCount(n);
    this.scroller.relayout();
    this.updateLabel();
  }

  private updateLabel(): void {
    this.pageLabel.textContent = `${this.scroller.currentPage} / ${this.deps.doc.numPages}`;
  }

  private queueSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.deps.onPosition(this.scroller.currentPage, this.scroller.currentZoom), 800);
  }

  async destroy(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.deps.onPosition(this.scroller.currentPage, this.scroller.currentZoom);
    this.unsubGrow();
    this.inkLayer.destroy();
    await this.deps.ink.flush();
    this.scroller.destroy();
    this.el.remove();
  }
}
