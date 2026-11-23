import type { CharBox } from "../text/textGeometry";
import type { OutlineNode, PageSize } from "../types";

/**
 * What the UI needs from any paged document. PDF implements it today; the
 * .docx importer (milestone 6) converts Word files into the same shape, so the
 * reader, pen tools and export never need to know the source format.
 */
export interface PagedDocument {
  readonly numPages: number;
  readonly fingerprint: string;
  /** Title from document metadata, or null. */
  readonly metaTitle: string | null;

  /** Size of page i (0-based). Exact once known, else an estimate. */
  pageSize(i: number): PageSize;
  /** True once every page size has been read from the file. */
  readonly allSizesKnown: boolean;
  /** Reads page sizes in the background; calls back as batches arrive. */
  loadPageSizes(onBatch: () => void, signal?: AbortSignal): Promise<void>;

  /**
   * Draws page i into the canvas. `cssScale` maps PDF points to CSS px;
   * `pixelRatio` is the device pixel ratio (possibly capped).
   */
  renderPage(
    i: number,
    canvas: HTMLCanvasElement,
    cssScale: number,
    pixelRatio: number,
    signal: AbortSignal,
  ): Promise<void>;

  getOutline(): Promise<OutlineNode[]>;

  /**
   * Matrix from PDF user space to the page's display space (points, y down,
   * rotation applied) at scale 1. Used to export ink back into the PDF.
   */
  displayTransform(i: number): Promise<[number, number, number, number, number, number]>;

  /** Character boxes of page i (empty for scanned pages without text). */
  textChars(i: number): Promise<CharBox[]>;
  destroy(): Promise<void>;
}
