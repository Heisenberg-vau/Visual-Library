import { describe, expect, it } from "vitest";
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { exportAnnotatedPdf, invert, type Matrix, type PageJob } from "../../src/core/export/exportPdf";
import { exportFileName, inkExtent, marginFor } from "../../src/core/export/ExportService";
import type { Stroke } from "../../src/core/annotations/types";

const pen: Stroke = { id: "p", tool: "pen", color: "#1f5fbf", width: 1.6, points: [100, 100, 150, 120, 200, 100] };
const hl: Stroke = { id: "h", tool: "highlighter", color: "#ffd400", width: 12, points: [0, 0, 1, 1], rects: [60, 190, 200, 11] };
const marginNote: Stroke = { id: "m", tool: "pen", color: "#000000", width: 1.6, points: [640, 300, 660, 320] };

async function makePdf(pages: number): Promise<ArrayBuffer> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`page ${i + 1}`, { x: 50, y: 700 });
  const bytes = await d.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const DISPLAY: Matrix = [1, 0, 0, -1, 0, 842]; // pdf.js viewport transform for an unrotated A4 page

function contentText(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((r) => {
      const s = doc.context.lookup(r as never) as PDFRawStream;
      return new TextDecoder("latin1").decode(decodePDFRawStream(s).decode());
    })
    .join("\n");
}

describe("export maths", () => {
  it("inverts the display transform", () => {
    const inv = invert(DISPLAY);
    expect(inv).toEqual([1, 0, 0, -1, 0, 842]);
    const rot: Matrix = [0, 1, 1, 0, 0, 0];
    expect(invert(rot)).toEqual([0, 1, 1, 0, 0, 0]);
  });

  it("measures ink extent and decides margins", () => {
    expect(inkExtent([pen])).toEqual({ minX: 99.2, maxX: 200.8 });
    const book = { left: 0, right: 0.3, pattern: "lines" as const };
    expect(marginFor(595, [pen], book, "noted")).toEqual({ left: 0, right: 0 });
    const m = marginFor(595, [marginNote], book, "noted");
    expect(m.left).toBe(0);
    expect(m.right).toBeCloseTo(178.5);
    expect(marginFor(595, [pen], book, "all").right).toBeCloseTo(178.5);
  });

  it("makes safe file names", () => {
    expect(exportFileName('Rolls-Royce: The "Jet" Engine')).toBe("Rolls-Royce The Jet Engine (ghi chu).pdf");
  });
});

describe("exportAnnotatedPdf", () => {
  it("adds ink, highlight and widened paper to a new file; other pages untouched", async () => {
    const bytes = await makePdf(3);
    const original = new Uint8Array(bytes.slice(0));
    const job: PageJob = {
      index: 1,
      toPdf: invert(DISPLAY),
      width: 595,
      height: 842,
      strokes: [hl, pen, marginNote],
      marginLeft: 0,
      marginRight: 178.5,
      pattern: "grid",
    };
    const out = await exportAnnotatedPdf({ bytes, jobs: [job], keepPages: null, title: "Sách" });
    expect(new Uint8Array(bytes)).toEqual(original); // input never modified
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getMediaBox()).toEqual({ x: 0, y: 0, width: 773.5, height: 842 });
    expect(doc.getPage(1).getCropBox()).toEqual({ x: 0, y: 0, width: 773.5, height: 842 });
    expect(doc.getPage(0).getMediaBox().width).toBe(595);
    const text = contentText(doc, 1);
    expect(text.trimStart().startsWith("q")).toBe(true); // original content isolated
    expect(text).toContain("1 0 0 -1 0 842 cm");
    expect(text).toMatch(/\/VLhl-?\d+ gs/);
    expect(text).toContain("60 190 200 11 re");
    expect(text).toMatch(/0\.1215\d* 0\.3725\d* 0\.749\d* RG/); // blue pen
    expect(doc.getTitle()).toBe("Sách (ghi chú)");
  });

  it("can keep only the annotated pages", async () => {
    const bytes = await makePdf(5);
    const job: PageJob = {
      index: 3, toPdf: invert(DISPLAY), width: 595, height: 842, strokes: [pen], marginLeft: 0, marginRight: 0, pattern: "lines",
    };
    const out = await exportAnnotatedPdf({ bytes, jobs: [job], keepPages: [3], title: "x" });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(contentText(doc, 0).toLowerCase()).toContain("706167652034"); // "page 4" as hex glyphs
  });

  it("reports encrypted files clearly", async () => {
    await expect(
      exportAnnotatedPdf({ bytes: new TextEncoder().encode("%PDF-1.7 garbage").buffer as ArrayBuffer, jobs: [], keepPages: null, title: "x" }),
    ).rejects.toThrow(/Không đọc được|bảo vệ/);
  });
});
