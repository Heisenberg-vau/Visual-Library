/**
 * Handwriting data. Coordinates are PDF points relative to the ORIGINAL
 * page's top-left corner, so they are independent of zoom and screen.
 * Ink in a widened margin simply has x < 0 (left) or x > page width (right).
 */
export type InkTool = "pen" | "highlighter" | "underline";

/** A tappable tag in a notebook that jumps to a page of a book. */
export interface PageLink {
  bookId: string;
  /** 1-based page in that book. */
  page: number;
  /** Text shown on the tag, e.g. "Rolls-Royce · tr. 245". */
  label: string;
}

/** Text or a picture cut from a book and placed in a notebook. */
export interface ClipData {
  kind: "image" | "text";
  /** Picture (data: URL, PNG or JPEG). */
  src?: string;
  /** Text, already wrapped into lines at `fontSize`. */
  lines?: string[];
  fontSize?: number;
}

export interface Stroke {
  id: string;
  /**
   * "link": a page-link tag (drawn as a chip; `rects` holds its box).
   * "clip": text/picture from a book (`rects` = its box, `link` = where it came from).
   */
  tool: InkTool | "link" | "clip";
  /** CSS colour, e.g. "#1d2430". */
  color: string;
  /** Line width in PDF points. */
  width: number;
  /** Flat list x0,y0,x1,y1,… in PDF points (rounded to 0.1). */
  points: number[];
  /**
   * Highlights snapped to text: flat x,y,w,h,… rectangles covering the
   * characters. When present they are drawn instead of `points`.
   */
  rects?: number[];
  link?: PageLink;
  clip?: ClipData;
}

export interface PageInk {
  bookId: string;
  /** 0-based page index. */
  page: number;
  strokes: Stroke[];
}

/** Extra writing space beside every page, as a fraction of page width. */
export type PaperPattern = "blank" | "lines" | "grid" | "dots";

export interface Margins {
  left: number;
  right: number;
  /** Background of the widened area. */
  pattern?: PaperPattern;
}

export const NO_MARGINS: Margins = { left: 0, right: 0, pattern: "lines" };

/** Spacing of the margin background, in PDF points. */
export const PATTERN_SPACING = 18;
