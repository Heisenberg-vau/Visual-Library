import type { PagedDocument } from "../../core/pdf/PagedDocument";
import { PageLayout, clamp, type PageAnchor } from "../../core/util/layout";
import type { JobScheduler } from "../../core/util/scheduler";
import { h } from "../dom";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
const GAP = 14;

interface Slot {
  index: number;
  el: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** layout.scale the current canvas was rendered at (0 = none). */
  renderedScale: number;
}

export interface PageScrollerOptions {
  initialPage: number; // 1-based
  initialZoom: number;
  onPageChange: (page: number) => void;
  onZoomChange: (zoom: number) => void;
}

/**
 * Continuous vertical page view. Only pages near the viewport exist in the
 * DOM and only those get a canvas, so a 1000-page file costs the same memory
 * as a 10-page one. Pinch-zoom is done with a CSS transform during the
 * gesture, then the pages are re-laid-out and re-rendered sharply.
 */
export class PageScroller {
  readonly el: HTMLElement;
  private content: HTMLElement;
  private layout!: PageLayout;
  private slots = new Map<number, Slot>();
  private zoom: number;
  private page = 1;
  private raf = 0;
  private resizeObs: ResizeObserver;
  private sizeCtrl = new AbortController();
  private pinch: {
    startDist: number;
    startMid: { x: number; y: number };
    mid: { x: number; y: number };
    ratio: number;
    anchor: PageAnchor;
  } | null = null;
  private destroyed = false;

  constructor(
    private readonly doc: PagedDocument,
    private readonly scheduler: JobScheduler,
    private readonly opts: PageScrollerOptions,
  ) {
    this.zoom = clamp(opts.initialZoom || 1, MIN_ZOOM, MAX_ZOOM);
    this.content = h("div", { class: "pages-content" });
    this.el = h("div", { class: "pages-scroller", "data-testid": "scroller", tabindex: 0 }, this.content);
    this.el.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.el.addEventListener("touchstart", this.onTouchStart, { passive: false });
    this.el.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.el.addEventListener("touchend", this.onTouchEnd);
    this.el.addEventListener("touchcancel", this.onTouchEnd);
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    this.resizeObs = new ResizeObserver(() => this.relayout());
    this.page = clamp(opts.initialPage || 1, 1, doc.numPages);
  }

  /** Call once the element is attached (needs real dimensions). */
  start(): void {
    this.buildLayout();
    this.goToPage(this.page, false);
    this.resizeObs.observe(this.el);
    this.doc
      .loadPageSizes(() => this.relayout(), this.sizeCtrl.signal)
      .catch((e) => !this.destroyed && console.warn("page sizes", e));
  }

  get currentPage(): number {
    return this.page;
  }

  get currentZoom(): number {
    return this.zoom;
  }

  /** For tests/debug: which pages currently have a canvas rendered. */
  renderedPages(): number[] {
    return [...this.slots.values()].filter((s) => s.renderedScale > 0).map((s) => s.index + 1);
  }

  private buildLayout(): void {
    const sizes = Array.from({ length: this.doc.numPages }, (_, i) => this.doc.pageSize(i));
    this.layout = new PageLayout(
      sizes,
      { gap: GAP, availableWidth: this.el.clientWidth - 2 * GAP, zoom: this.zoom },
      this.el.clientWidth,
    );
    this.content.style.width = `${this.layout.contentWidth}px`;
    this.content.style.height = `${this.layout.contentHeight}px`;
    for (const s of this.slots.values()) this.positionSlot(s);
  }

  /** Viewport point (relative to scroller) -> anchor in the document. */
  private anchorAtViewport(vx: number, vy: number): PageAnchor {
    return this.layout.anchorAt(this.el.scrollLeft + vx, this.el.scrollTop + vy);
  }

  private placeAnchor(a: PageAnchor, vx: number, vy: number): void {
    const p = this.layout.pointOf(a);
    this.el.scrollLeft = p.x - vx;
    this.el.scrollTop = p.y - vy;
  }

  /** Re-layout keeping the content under the focal point still. */
  relayout(focal?: { x: number; y: number }): void {
    if (this.destroyed || !this.layout) return;
    const fx = focal?.x ?? this.el.clientWidth / 2;
    const fy = focal?.y ?? this.el.clientHeight * 0.3;
    const a = this.anchorAtViewport(fx, fy);
    this.buildLayout();
    this.placeAnchor(a, fx, fy);
    this.update();
  }

  setZoom(z: number, focal?: { x: number; y: number }): void {
    const nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nz - this.zoom) < 1e-4) return;
    this.zoom = nz;
    this.relayout(focal);
    this.opts.onZoomChange(this.zoom);
  }

  goToPage(n: number, smooth = false): void {
    const i = clamp(Math.round(n), 1, this.doc.numPages) - 1;
    const top = this.layout.tops[i] - GAP / 2;
    const left = (this.layout.contentWidth - this.el.clientWidth) / 2;
    this.el.scrollTo({ top, left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
    this.setPage(i + 1);
    this.update();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  private setPage(p: number): void {
    if (p !== this.page) {
      this.page = p;
      this.opts.onPageChange(p);
    }
  }

  /** Create/destroy slots around the viewport and queue renders. */
  private update(): void {
    if (this.destroyed || !this.layout) return;
    const vh = this.el.clientHeight;
    const top = this.el.scrollTop;
    const [a, b] = this.layout.visibleRange(top - vh * 0.5, top + vh * 1.5);
    const probe = this.layout.indexAt(top + vh * 0.35);
    this.setPage(probe + 1);

    for (const [i, s] of this.slots) {
      if (i < a || i > b) this.dropSlot(s);
    }
    const center = top + vh / 2;
    for (let i = a; i <= b; i++) {
      let s = this.slots.get(i);
      if (!s) {
        s = this.createSlot(i);
        this.slots.set(i, s);
      }
      if (s.renderedScale !== this.layout.scale) {
        const mid = this.layout.tops[i] + this.layout.heights[i] / 2;
        this.queueRender(s, Math.abs(mid - center));
      }
    }
  }

  private createSlot(index: number): Slot {
    const el = h(
      "div",
      { class: "page-slot", "data-page": index + 1 },
      h("div", { class: "page-placeholder" }, String(index + 1)),
    );
    const s: Slot = { index, el, canvas: null, renderedScale: 0 };
    this.positionSlot(s);
    this.content.append(el);
    return s;
  }

  private positionSlot(s: Slot): void {
    const i = s.index;
    if (i >= this.layout.count) return;
    const st = s.el.style;
    st.top = `${this.layout.tops[i]}px`;
    st.left = `${this.layout.left(i)}px`;
    st.width = `${this.layout.widths[i]}px`;
    st.height = `${this.layout.heights[i]}px`;
  }

  private dropSlot(s: Slot): void {
    this.scheduler.cancel(this.jobKey(s.index));
    if (s.canvas) {
      // Releasing the backing store promptly matters on tablets.
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
    s.el.remove();
    this.slots.delete(s.index);
  }

  private jobKey(i: number): string {
    return `page:${i}`;
  }

  private queueRender(s: Slot, priority: number): void {
    const scale = this.layout.scale;
    this.scheduler.enqueue({
      key: this.jobKey(s.index),
      priority,
      run: async (signal) => {
        if (this.slots.get(s.index) !== s || s.renderedScale === scale) return;
        const canvas = h("canvas", { class: "page-canvas" });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        await this.doc.renderPage(s.index, canvas, scale, dpr, signal);
        if (signal.aborted || this.slots.get(s.index) !== s) {
          canvas.width = 0;
          return;
        }
        if (s.canvas) {
          s.canvas.width = 0;
          s.canvas.replaceWith(canvas);
        } else {
          s.el.replaceChildren(canvas);
        }
        s.canvas = canvas;
        s.renderedScale = scale;
        // The scale may have changed while rendering.
        if (scale !== this.layout.scale) this.schedule();
      },
    });
  }

  // ---- gestures -------------------------------------------------------

  private viewportPoint(t: Touch): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  private onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 2) return;
    const p1 = this.viewportPoint(e.touches[0]);
    const p2 = this.viewportPoint(e.touches[1]);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
    this.pinch = { startDist: dist, startMid: mid, mid, ratio: 1, anchor: this.anchorAtViewport(mid.x, mid.y) };
    const ox = this.el.scrollLeft + mid.x;
    const oy = this.el.scrollTop + mid.y;
    this.content.style.transformOrigin = `${ox}px ${oy}px`;
    this.content.classList.add("pinching");
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const p1 = this.viewportPoint(e.touches[0]);
    const p2 = this.viewportPoint(e.touches[1]);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
    let ratio = dist / this.pinch.startDist;
    ratio = clamp(this.zoom * ratio, MIN_ZOOM, MAX_ZOOM) / this.zoom;
    this.pinch.ratio = ratio;
    this.pinch.mid = mid;
    const dx = mid.x - this.pinch.startMid.x;
    const dy = mid.y - this.pinch.startMid.y;
    this.content.style.transform = `translate(${dx}px, ${dy}px) scale(${ratio})`;
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.pinch || e.touches.length >= 2) return;
    const { ratio, anchor, mid } = this.pinch;
    this.pinch = null;
    this.content.style.transform = "";
    this.content.classList.remove("pinching");
    const nz = clamp(this.zoom * ratio, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nz - this.zoom) > 1e-3) {
      this.zoom = nz;
      this.buildLayout();
      this.opts.onZoomChange(this.zoom);
    }
    this.placeAnchor(anchor, mid.x, mid.y);
    this.update();
  };

  /** Ctrl + wheel / trackpad pinch on a laptop. */
  private onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.01);
    this.setZoom(this.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  destroy(): void {
    this.destroyed = true;
    this.sizeCtrl.abort();
    this.resizeObs.disconnect();
    cancelAnimationFrame(this.raf);
    for (const s of [...this.slots.values()]) this.dropSlot(s);
    this.scheduler.cancelWhere((k) => k.startsWith("page:"));
    this.el.remove();
  }
}
