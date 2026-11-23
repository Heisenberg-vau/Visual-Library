import { PATTERN_SPACING, type PaperPattern } from "../annotations/types";
import type { PagedDocument } from "../pdf/PagedDocument";
import type { CharBox } from "../text/textGeometry";
import type { OutlineNode, PageSize } from "../types";

/** A4 portrait, the size of a school notebook page. */
export const NOTEBOOK_PAGE: PageSize = { width: 595, height: 842 };

/**
 * A notebook seen as a paged document: blank pages with ruled/grid/dot paper.
 * Everything else (reader, pen, eraser, export) treats it like a PDF.
 */
export class NotebookDocument implements PagedDocument {
  readonly metaTitle: string | null = null;
  readonly allSizesKnown = true;
  private count: number;

  constructor(
    readonly fingerprint: string,
    pageCount: number,
    private paper: PaperPattern,
  ) {
    this.count = Math.max(1, pageCount);
  }

  get numPages(): number {
    return this.count;
  }

  get pattern(): PaperPattern {
    return this.paper;
  }

  setPattern(p: PaperPattern): void {
    this.paper = p;
  }

  /** Grows the notebook (pages are only ever added at the end). */
  addPages(n = 1): number {
    this.count += n;
    return this.count;
  }

  pageSize(): PageSize {
    return NOTEBOOK_PAGE;
  }

  async loadPageSizes(): Promise<void> {}

  async renderPage(
    _i: number,
    canvas: HTMLCanvasElement,
    cssScale: number,
    pixelRatio: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const k = cssScale * pixelRatio;
    canvas.width = Math.max(1, Math.round(NOTEBOOK_PAGE.width * k));
    canvas.height = Math.max(1, Math.round(NOTEBOOK_PAGE.height * k));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawPaper(ctx, this.paper, NOTEBOOK_PAGE.width, NOTEBOOK_PAGE.height, k);
  }

  async getOutline(): Promise<OutlineNode[]> {
    return [];
  }

  async textChars(): Promise<CharBox[]> {
    return [];
  }

  async displayTransform(): Promise<[number, number, number, number, number, number]> {
    return [1, 0, 0, -1, 0, NOTEBOOK_PAGE.height];
  }

  async destroy(): Promise<void> {}
}

/** Same paper as the CSS margins and the PDF export. */
export function drawPaper(ctx: CanvasRenderingContext2D, p: PaperPattern, w: number, h: number, k: number): void {
  const sp = PATTERN_SPACING;
  ctx.save();
  ctx.scale(k, k);
  if (p === "lines" || p === "grid") {
    ctx.strokeStyle = p === "lines" ? "#cfd8e6" : "#dfe4ec";
    ctx.lineWidth = Math.max(0.5, 1 / k);
    ctx.beginPath();
    for (let y = p === "lines" ? sp * 3 : sp; y < h; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    if (p === "grid") {
      for (let x = sp; x < w; x += sp) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
    }
    ctx.stroke();
    if (p === "lines") {
      // Red margin line, like a real exercise book.
      ctx.strokeStyle = "#efb4b4";
      ctx.beginPath();
      ctx.moveTo(sp * 3.5, 0);
      ctx.lineTo(sp * 3.5, h);
      ctx.stroke();
    }
  } else if (p === "dots") {
    ctx.fillStyle = "#b7c0cf";
    for (let y = sp; y < h; y += sp) {
      for (let x = sp; x < w; x += sp) {
        ctx.beginPath();
        ctx.arc(x, y, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
