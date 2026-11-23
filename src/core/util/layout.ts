import type { PageSize } from "../types";

/**
 * Pure geometry for a vertical, continuous stack of pages.
 * All values are CSS pixels. Kept free of DOM so it can be unit-tested.
 */
export interface LayoutOptions {
  gap: number;
  /** Width available for pages (viewport width minus side padding). */
  availableWidth: number;
  /** Zoom relative to fit-width of the widest "typical" page. */
  zoom: number;
}

export interface PageAnchor {
  /** 0-based page index. */
  index: number;
  /** Position inside the page, 0..1 on each axis. */
  fx: number;
  fy: number;
}

export class PageLayout {
  readonly tops: Float64Array;
  readonly widths: Float64Array;
  readonly heights: Float64Array;
  readonly scale: number;
  readonly contentWidth: number;
  readonly contentHeight: number;

  constructor(
    readonly sizes: readonly PageSize[],
    readonly opts: LayoutOptions,
    viewportWidth: number,
  ) {
    const n = sizes.length;
    this.tops = new Float64Array(n);
    this.widths = new Float64Array(n);
    this.heights = new Float64Array(n);
    // Fit-width is computed against the first page, so a single odd
    // landscape page does not shrink every other page.
    const ref = n > 0 ? sizes[0].width : 1;
    this.scale = (Math.max(50, opts.availableWidth) / ref) * opts.zoom;
    let y = opts.gap;
    let maxW = 0;
    for (let i = 0; i < n; i++) {
      const w = sizes[i].width * this.scale;
      const h = sizes[i].height * this.scale;
      this.widths[i] = w;
      this.heights[i] = h;
      this.tops[i] = y;
      y += h + opts.gap;
      if (w > maxW) maxW = w;
    }
    this.contentHeight = y;
    this.contentWidth = Math.max(viewportWidth, maxW + 2 * opts.gap);
  }

  get count(): number {
    return this.sizes.length;
  }

  left(i: number): number {
    return (this.contentWidth - this.widths[i]) / 2;
  }

  /** First page whose bottom edge is below y (binary search). */
  indexAt(y: number): number {
    const n = this.count;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tops[mid] + this.heights[mid] < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Inclusive index range of pages intersecting [top, bottom]. */
  visibleRange(top: number, bottom: number): [number, number] {
    if (this.count === 0) return [0, -1];
    const a = this.indexAt(top);
    let b = a;
    while (b + 1 < this.count && this.tops[b + 1] < bottom) b++;
    return [a, b];
  }

  /** Content point -> anchor (page + fractional position). */
  anchorAt(x: number, y: number): PageAnchor {
    const index = this.indexAt(y);
    const top = this.tops[index] ?? 0;
    const h = this.heights[index] || 1;
    const w = this.widths[index] || 1;
    const fy = clamp((y - top) / h, 0, 1);
    const fx = clamp((x - this.left(index)) / w, 0, 1);
    return { index, fx, fy };
  }

  /** Anchor -> content point. */
  pointOf(a: PageAnchor): { x: number; y: number } {
    const i = clamp(a.index, 0, this.count - 1);
    return {
      x: this.left(i) + a.fx * this.widths[i],
      y: this.tops[i] + a.fy * this.heights[i],
    };
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
