/**
 * Handwriting data. Coordinates are PDF points relative to the ORIGINAL
 * page's top-left corner, so they are independent of zoom and screen.
 * Ink in a widened margin simply has x < 0 (left) or x > page width (right).
 */
export type InkTool = "pen" | "highlighter" | "underline";

export interface Stroke {
  id: string;
  tool: InkTool;
  /** CSS colour, e.g. "#1d2430". */
  color: string;
  /** Line width in PDF points. */
  width: number;
  /** Flat list x0,y0,x1,y1,… in PDF points (rounded to 0.1). */
  points: number[];
}

export interface PageInk {
  bookId: string;
  /** 0-based page index. */
  page: number;
  strokes: Stroke[];
}

/** Extra writing space beside every page, as a fraction of page width. */
export interface Margins {
  left: number;
  right: number;
}

export const NO_MARGINS: Margins = { left: 0, right: 0 };
