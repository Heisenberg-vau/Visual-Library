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
  appendQuadraticCurve,
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
} from "pdf-lib";
import { HIGHLIGHT_OPACITY, strokeCommands } from "../annotations/path";
import { PATTERN_SPACING, type PaperPattern, type Stroke } from "../annotations/types";

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
}

export interface ExportRequest {
  bytes: ArrayBuffer;
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

function inkOps(doc: PDFDocument, page: PDFPage, job: PageJob): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...job.toPdf)];
  ops.push(...paperOps(job));
  const highlights = job.strokes.filter((s) => s.tool === "highlighter");
  const ink = job.strokes.filter((s) => s.tool !== "highlighter");
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
    doc = await PDFDocument.load(req.bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new ExportError("File PDF này được bảo vệ (mã hóa) nên chưa xuất được bản có ghi chú.");
    }
    throw new ExportError("Không đọc được cấu trúc file PDF để xuất.");
  }
  const pages = doc.getPages();
  req.jobs.forEach((job, k) => {
    const page = pages[job.index];
    if (!page) return;
    if (job.marginLeft > 0 || job.marginRight > 0) widenBoxes(page, job);
    isolateExistingContent(doc, page);
    page.pushOperators(...inkOps(doc, page, job));
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
