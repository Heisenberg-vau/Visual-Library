import type { PagedDocument } from "../../core/pdf/PagedDocument";
import { LruCache } from "../../core/util/lru";
import type { JobScheduler } from "../../core/util/scheduler";
import { h, icon } from "../dom";

const THUMB_W = 116;
const BOX_H = 164;
const ITEM_H = BOX_H + 34;

/** Virtualised list of page thumbnails. */
export class ThumbnailPanel {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private items = new Map<number, HTMLElement>();
  private cache = new LruCache<number, HTMLCanvasElement>(150, (_k, c) => {
    c.width = 0;
    c.height = 0;
  });
  private current = 1;
  private raf = 0;
  private active = false;

  constructor(
    private readonly doc: PagedDocument,
    private readonly scheduler: JobScheduler,
    private readonly onNavigate: (page: number) => void,
    /** Notebooks: a "⋯" on each thumbnail opens the page menu. */
    private readonly pageMenu?: (page: number, anchor: HTMLElement) => void,
  ) {
    this.inner = h("div", { class: "thumbs-inner" });
    this.inner.style.height = `${doc.numPages * ITEM_H}px`;
    this.el = h("div", { class: "thumbs", "data-testid": "thumbs" }, this.inner);
    this.el.addEventListener("scroll", () => this.schedule(), { passive: true });
  }

  /** The document grew (notebooks add pages). */
  pagesChanged(): void {
    this.inner.style.height = `${this.doc.numPages * ITEM_H}px`;
    this.update();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.scrollToCurrent();
      this.update();
    } else {
      this.scheduler.cancelWhere((k) => k.startsWith("thumb:"));
    }
  }

  setCurrent(page: number): void {
    const prev = this.items.get(this.current);
    prev?.classList.remove("current");
    this.current = page;
    this.items.get(page)?.classList.add("current");
  }

  scrollToCurrent(): void {
    const y = (this.current - 1) * ITEM_H - this.el.clientHeight / 2 + ITEM_H / 2;
    this.el.scrollTop = Math.max(0, y);
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  private update(): void {
    if (!this.active) return;
    const top = this.el.scrollTop;
    const vh = this.el.clientHeight || 600;
    const first = Math.max(1, Math.floor(top / ITEM_H) + 1 - 3);
    const last = Math.min(this.doc.numPages, Math.ceil((top + vh) / ITEM_H) + 3);
    for (const [p, el] of this.items) {
      if (p < first || p > last) {
        this.scheduler.cancel(`thumb:${p}`);
        el.remove();
        this.items.delete(p);
      }
    }
    for (let p = first; p <= last; p++) {
      if (this.items.has(p)) continue;
      const box = h("div", { class: "thumb-box" });
      const nav = h("button", { class: "thumb-nav", type: "button", "aria-label": `Trang ${p}` }, box, h("span", { class: "thumb-label" }, String(p)));
      nav.addEventListener("click", () => this.onNavigate(p));
      const item = h("div", { class: `thumb ${p === this.current ? "current" : ""}`, "data-page": p, style: `top:${(p - 1) * ITEM_H}px` }, nav);
      if (this.pageMenu) {
        const more = h("button", { class: "thumb-more", type: "button", "data-testid": "thumb-more", "aria-label": `Thao tác với trang ${p}`, html: icon("more", 18) });
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.pageMenu!(p, more);
        });
        item.append(more);
      }
      this.inner.append(item);
      this.items.set(p, item);
      const cached = this.cache.get(p);
      if (cached) box.append(cached);
      else this.queue(p, box, Math.abs(p - this.current));
    }
  }

  private queue(p: number, box: HTMLElement, distance: number): void {
    this.scheduler.enqueue({
      key: `thumb:${p}`,
      priority: 10_000 + distance,
      run: async (signal) => {
        const size = this.doc.pageSize(p - 1);
        const scale = Math.min(THUMB_W / size.width, BOX_H / size.height);
        const canvas = h("canvas", { class: "thumb-canvas" });
        await this.doc.renderPage(p - 1, canvas, scale, Math.min(window.devicePixelRatio || 1, 2), signal);
        if (signal.aborted) {
          canvas.width = 0;
          return;
        }
        canvas.style.width = `${Math.round(size.width * scale)}px`;
        canvas.style.height = `${Math.round(size.height * scale)}px`;
        this.cache.set(p, canvas);
        if (this.items.get(p)?.contains(box)) box.replaceChildren(canvas);
      },
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.scheduler.cancelWhere((k) => k.startsWith("thumb:"));
    this.cache.clear();
  }
}
