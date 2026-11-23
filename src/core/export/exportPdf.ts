import {
  EncryptedPDFError,
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFPage,
  StandardFonts,
  type PDFFont,
  appendBezierCurve,
  appendQuadraticCurve,
  fillAndStroke,
  beginText,
  endText,
  setFontAndSize,
  showText,
  moveText,
  concatTransformationMatrix,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  drawObject,
  type PDFImage,
} from "pdf-lib";
import { HIGHLIGHT_OPACITY, linkArrow, strokeCommands } from "../annotations/path";
import { PATTERN_SPACING, type PaperPattern, type Stroke } from "../annotations/types";
import { LINK_FONT, asciiFold } from "../notebook/links";

/**
 * Builds the "annotated copy" of a PDF. Runs in a Web Worker; never touches
 * the original bytes' owner: the input is read, a NEW file is produced.
 *
 * All ink coordinates are in the page's display space (PDF points, y down,
 * rotation applied). `toPdf` maps that space back to PDF user space, so the
 * ink is drawn under one `cm` and lands exactly where it was on screen, for
 * rotated pages and pages with offset boxes alike.
 */
export type Matrix = [number, number, number, number, number, number];

export interface PageJob {
  index: number;
  /** Display-space -> PDF user space. */
  toPdf: Matrix;
  /** Display size (rotation applied). */
  width: number;
  height: number;
  strokes: Stroke[];
  /** Extra paper to add on each side, in points (0 = none). */
  marginLeft: number;
  marginRight: number;
  pattern: PaperPattern;
  /** Notebook pages: paper pattern over the whole page. */
  fullPaper?: PaperPattern;
}

export interface ExportRequest {
  /** Original PDF, or null to start from blank pages (notebooks). */
  bytes: ArrayBuffer | null;
  /** With bytes = null: how many blank pages and their size. */
  blank?: { count: number; width: number; height: number };
  jobs: PageJob[];
  /** Keep only these 0-based pages (in order); null = all pages. */
  keepPages: number[] | null;
  title: string;
}

export class ExportError extends Error {}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) throw new Error("singular matrix");
  // `+ 0` turns -0 into 0 so the content stream stays tidy.
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det].map((v) => v + 0) as Matrix;
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Wraps existing page content in q…Q so its leftover state cannot skew our ink. */
function isolateExistingContent(doc: PDFDocument, page: PDFPage): void {
  const node = page.node;
  node.normalize();
  const contents = node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const q = doc.context.register(doc.context.flateStream("q\n"));
  const Q = doc.context.register(doc.context.flateStream("\nQ\n"));
  contents.insert(0, q);
  contents.push(Q);
}

function widenBoxes(page: PDFPage, job: PageJob): void {
  const corners = [
    apply(job.toPdf, -job.marginLeft, 0),
    apply(job.toPdf, job.width + job.marginRight, 0),
    apply(job.toPdf, -job.marginLeft, job.height),
    apply(job.toPdf, job.width + job.marginRight, job.height),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  page.setMediaBox(x0, y0, w, h);
  page.setCropBox(x0, y0, w, h);
  // Boxes that would otherwise clip the new paper.
  for (const key of ["TrimBox", "BleedBox", "ArtBox"]) {
    if (page.node.get(PDFName.of(key))) page.node.delete(PDFName.of(key));
  }
}

function pathOps(points: number[]): PDFOperator[] {
  const ops: PDFOperator[] = [];
  for (const c of strokeCommands(points)) {
    if (c[0] === "M") ops.push(moveTo(c[1], c[2]));
    else if (c[0] === "L") ops.push(lineTo(c[1], c[2]));
    else ops.push(appendQuadraticCurve(c[1], c[2], c[3], c[4]));
  }
  return ops;
}

function paperOps(job: PageJob): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const areas: [number, number][] = [];
  if (job.marginLeft > 0) areas.push([-job.marginLeft, 0]);
  if (job.marginRight > 0) areas.push([job.width, job.width + job.marginRight]);
  if (!areas.length) return ops;
  const h = job.height;
  ops.push(setFillingRgbColor(1, 1, 1));
  for (const [a, b] of areas) ops.push(rectangle(a, 0, b - a, h), fill());
  const sp = PATTERN_SPACING;
  if (job.pattern === "lines" || job.pattern === "grid") {
    const [r, g, bl] = job.pattern === "lines" ? rgb("#cfd8e6") : rgb("#dfe4ec");
    ops.push(setStrokingRgbColor(r, g, bl), setLineWidth(0.5), setLineCap(LineCapStyle.Butt));
    for (const [a, b] of areas) {
      for (let y = sp; y < h; y += sp) ops.push(moveTo(a, y), lineTo(b, y));
      if (job.pattern === "grid") {
        // Align vertical lines to the page edge like on screen.
        const start = a < 0 ? -Math.floor(-a / sp) * sp : job.width;
        for (let x = start + (a < 0 ? 0 : sp); x < b; x += sp) if (x > a) ops.push(moveTo(x, 0), lineTo(x, h));
      }
    }
    ops.push(stroke());
  } else if (job.pattern === "dots") {
    const [r, g, bl] = rgb("#b7c0cf");
    ops.push(setStrokingRgbColor(r, g, bl), setLineWidth(1.6), setLineCap(LineCapStyle.Round));
    for (const [a, b] of areas) {
      for (let y = sp / 2; y < h; y += sp) {
        for (let x = a + sp / 2; x < b; x += sp) ops.push(moveTo(x, y), lineTo(x + 0.01, y));
      }
    }
    ops.push(stroke());
  }
  // Thin line marking the original page edge.
  ops.push(setStrokingRgbColor(0.85, 0.87, 0.89), setLineWidth(0.6), setLineCap(LineCapStyle.Butt));
  if (job.marginLeft > 0) ops.push(moveTo(0, 0), lineTo(0, h));
  if (job.marginRight > 0) ops.push(moveTo(job.width, 0), lineTo(job.width, h));
  ops.push(stroke());
  return ops;
}

function fullPaperOps(job: PageJob): PDFOperator[] {
  const p = job.fullPaper;
  if (!p || p === "blank") return [];
  const sp = PATTERN_SPACING;
  const { width: w, height: h } = job;
  const ops: PDFOperator[] = [];
  if (p === "lines" || p === "grid") {
    const [r, g, b] = p === "lines" ? rgb("#cfd8e6") : rgb("#dfe4ec");
    ops.push(setStrokingRgbColor(r, g, b), setLineWidth(0.5), setLineCap(LineCapStyle.Butt));
    for (let y = p === "lines" ? sp * 3 : sp; y < h; y += sp) ops.push(moveTo(0, y), lineTo(w, y));
    if (p === "grid") for (let x = sp; x < w; x += sp) ops.push(moveTo(x, 0), lineTo(x, h));
    ops.push(stroke());
    if (p === "lines") {
      const [r2, g2, b2] = rgb("#efb4b4");
      ops.push(setStrokingRgbColor(r2, g2, b2), moveTo(sp * 3.5, 0), lineTo(sp * 3.5, h), stroke());
    }
  } else if (p === "dots") {
    const [r, g, b] = rgb("#b7c0cf");
    ops.push(setStrokingRgbColor(r, g, b), setLineWidth(1.6), setLineCap(LineCapStyle.Round));
    for (let y = sp; y < h; y += sp) for (let x = sp; x < w; x += sp) ops.push(moveTo(x, y), lineTo(x + 0.01, y));
    ops.push(stroke());
  }
  return ops;
}

function linkOps(s: Stroke, font: PDFFont, fontName: PDFName): PDFOperator[] {
  if (!s.rects || !s.link) return [];
  const [x, y, w, h] = s.rects;
  const r = h / 2;
  const k = 0.5523 * r;
  const [cr, cg, cb] = rgb(s.color);
  const label = asciiFold(s.link.label);
  return [
    // pill shape
    setFillingRgbColor(0.91, 0.94, 0.98),
    setStrokingRgbColor(cr, cg, cb),
    setLineWidth(0.8),
    moveTo(x + r, y),
    lineTo(x + w - r, y),
    appendBezierCurve(x + w - r + k, y, x + w, y + r - k, x + w, y + r),
    appendBezierCurve(x + w, y + r + k, x + w - r + k, y + h, x + w - r, y + h),
    lineTo(x + r, y + h),
    appendBezierCurve(x + r - k, y + h, x, y + r + k, x, y + r),
    appendBezierCurve(x, y + r - k, x + r - k, y, x + r, y),
    fillAndStroke(),
    // arrow
    setLineWidth(1.3),
    setLineCap(LineCapStyle.Round),
    ...((a) => [moveTo(a[0], a[1]), lineTo(a[2], a[3]), moveTo(a[4], a[5]), lineTo(a[6], a[7]), lineTo(a[8], a[9])])(linkArrow(x, y, h)),
    stroke(),
    // text: undo the y-flip locally so glyphs are upright
    setFillingRgbColor(cr, cg, cb),
    pushGraphicsState(),
    concatTransformationMatrix(1, 0, 0, -1, x + 18, y + h / 2 + LINK_FONT * 0.35),
    beginText(),
    setFontAndSize(fontName, LINK_FONT),
    moveText(0, 0),
    showText(font.encodeText(label)),
    endText(),
    popGraphicsState(),
  ];
}

/** data: URL → bytes, for embedding pasted clips. */
function dataUrlBytes(url: string): { bytes: Uint8Array; png: boolean } | null {
  const m = /^data:image\/(png|jpeg);base64,(.*)$/.exec(url);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, png: m[1] === "png" };
}

/** Pictures of pasted clips (text clips arrive already drawn as pictures). */
function clipOps(page: PDFPage, job: PageJob, images: Map<string, PDFImage>): PDFOperator[] {
  const ops: PDFOperator[] = [];
  for (const s of job.strokes) {
    if (s.tool !== "clip" || !s.rects || !s.clip?.src) continue;
    const img = images.get(s.clip.src);
    if (!img) continue;
    const [x, y, w, h] = s.rects;
    const name = page.node.newXObject("VLclip", img.ref);
    // Our y axis points down: flip the unit square so the picture stays upright.
    ops.push(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, -h, x, y + h), drawObject(name), popGraphicsState());
  }
  return ops;
}

function inkOps(doc: PDFDocument, page: PDFPage, job: PageJob, font: PDFFont | null, images: Map<string, PDFImage>): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...job.toPdf)];
  ops.push(...fullPaperOps(job));
  ops.push(...paperOps(job));
  ops.push(...clipOps(page, job, images));
  const highlights = job.strokes.filter((s) => s.tool === "highlighter");
  const ink = job.strokes.filter((s) => s.tool !== "highlighter" && s.tool !== "link" && s.tool !== "clip");
  const links = job.strokes.filter((s) => s.tool === "link");
  if (highlights.length) {
    const gs = doc.context.obj({
      Type: "ExtGState",
      ca: PDFNumber.of(HIGHLIGHT_OPACITY),
      CA: PDFNumber.of(HIGHLIGHT_OPACITY),
      BM: PDFName.of("Multiply"),
    });
    const name = page.node.newExtGState("VLhl", doc.context.register(gs));
    ops.push(pushGraphicsState(), setGraphicsState(name));
    for (const s of highlights) {
      const [r, g, b] = rgb(s.color);
      if (s.rects?.length) {
        ops.push(setFillingRgbColor(r, g, b));
        for (let i = 0; i + 3 < s.rects.length; i += 4) ops.push(rectangle(s.rects[i], s.rects[i + 1], s.rects[i + 2], s.rects[i + 3]));
        ops.push(fill());
      } else {
        ops.push(setStrokingRgbColor(r, g, b), setLineWidth(s.width), setLineCap(LineCapStyle.Butt), setLineJoin(LineJoinStyle.Round));
        ops.push(...pathOps(s.points), stroke());
      }
    }
    ops.push(popGraphicsState());
  }
  for (const s of ink) {
    const [r, g, b] = rgb(s.color);
    ops.push(setStrokingRgbColor(r, g, b), setLineWidth(s.width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
    ops.push(...pathOps(s.points), stroke());
  }
  if (links.length && font) {
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    for (const s of links) ops.push(...linkOps(s, font, fontName));
  }
  ops.push(popGraphicsState());
  return ops;
}



export async function exportAnnotatedPdf(
  req: ExportRequest,
  onProgress?: (fraction: number, phase: "load" | "draw" | "save") => void,
): Promise<Uint8Array> {
  try {
    return await build(req, onProgress);
  } catch (e) {
    if (e instanceof ExportError) throw e;
    console.error("export failed", e);
    throw new ExportError("Không đọc được cấu trúc file PDF này để xuất (file có thể bị lỗi).");
  }
}

async function build(
  req: ExportRequest,
  onProgress?: (fraction: number, phase: "load" | "draw" | "save") => void,
): Promise<Uint8Array> {
  onProgress?.(0, "load");
  let doc: PDFDocument;
  try {
    if (req.bytes) {
      doc = await PDFDocument.load(req.bytes, { updateMetadata: false });
    } else {
      doc = await PDFDocument.create();
      const b = req.blank ?? { count: 1, width: 595, height: 842 };
      for (let i = 0; i < b.count; i++) doc.addPage([b.width, b.height]);
    }
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new ExportError("File PDF này được bảo vệ (mã hóa) nên chưa xuất được bản có ghi chú.");
    }
    throw new ExportError("Không đọc được cấu trúc file PDF để xuất.");
  }
  const pages = doc.getPages();
  const needsFont = req.jobs.some((j) => j.strokes.some((s) => s.tool === "link"));
  const font = needsFont ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const images = new Map<string, PDFImage>();
  for (const job of req.jobs) {
    for (const s of job.strokes) {
      const src = s.tool === "clip" ? s.clip?.src : undefined;
      if (!src || images.has(src)) continue;
      const d = dataUrlBytes(src);
      if (!d) continue;
      try {
        images.set(src, d.png ? await doc.embedPng(d.bytes) : await doc.embedJpg(d.bytes));
      } catch (e) {
        console.warn("clip image skipped", e);
      }
    }
  }
  req.jobs.forEach((job, k) => {
    const page = pages[job.index];
    if (!page) return;
    if (job.marginLeft > 0 || job.marginRight > 0) widenBoxes(page, job);
    isolateExistingContent(doc, page);
    page.pushOperators(...inkOps(doc, page, job, font, images));
    onProgress?.((k + 1) / Math.max(1, req.jobs.length), "draw");
  });
  if (req.keepPages) {
    const keep = new Set(req.keepPages);
    for (let i = pages.length - 1; i >= 0; i--) if (!keep.has(i)) doc.removePage(i);
  }
  const title = doc.getTitle();
  doc.setTitle(`${title || req.title} (ghi chú)`, { showInWindowTitleBar: false });
  doc.setModificationDate(new Date());
  onProgress?.(0, "save");
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
