import type { InkModel } from "../annotations/InkModel";
import type { Margins, Stroke } from "../annotations/types";
import type { PagedDocument } from "../pdf/PagedDocument";
import { invert, type Matrix, type PageJob } from "./exportPdf";

export interface ExportOptions {
  /** "all" = whole document; "annotated" = only pages with notes. */
  scope: "all" | "annotated";
  /** "noted" = widen only pages whose notes reach into the margin; "all" = every page. */
  marginPages: "noted" | "all";
}

/** Horizontal extent of a page's ink, in display points. */
export function inkExtent(strokes: readonly Stroke[]): { minX: number; maxX: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of strokes) {
    const half = s.width / 2;
    if (s.rects?.length) {
      for (let i = 0; i + 3 < s.rects.length; i += 4) {
        minX = Math.min(minX, s.rects[i]);
        maxX = Math.max(maxX, s.rects[i] + s.rects[i + 2]);
      }
    } else {
      for (let i = 0; i < s.points.length; i += 2) {
        minX = Math.min(minX, s.points[i] - half);
        maxX = Math.max(maxX, s.points[i] + half);
      }
    }
  }
  return Number.isFinite(minX) ? { minX, maxX } : null;
}

/** Pure part: how much paper a page needs on each side. */
export function marginFor(
  width: number,
  strokes: readonly Stroke[],
  book: Margins,
  marginPages: ExportOptions["marginPages"],
): { left: number; right: number } {
  const ext = inkExtent(strokes);
  const bookL = book.left * width;
  const bookR = book.right * width;
  const needL = ext && ext.minX < 0 ? Math.max(bookL, -ext.minX + 8) : 0;
  const needR = ext && ext.maxX > width ? Math.max(bookR, ext.maxX - width + 8) : 0;
  if (marginPages === "all") return { left: Math.max(bookL, needL), right: Math.max(bookR, needR) };
  return { left: needL, right: needR };
}

/** Collects everything the export worker needs (runs on the main thread). */
export async function buildExportJobs(
  doc: PagedDocument,
  ink: InkModel,
  book: Margins,
  opts: ExportOptions,
): Promise<{ jobs: PageJob[]; keepPages: number[] | null }> {
  const inked = ink.pagesWithInk();
  const widenAll = opts.marginPages === "all" && (book.left > 0 || book.right > 0);
  const pages = widenAll
    ? opts.scope === "annotated"
      ? inked
      : Array.from({ length: doc.numPages }, (_, i) => i)
    : inked;
  const jobs: PageJob[] = [];
  for (const i of pages) {
    const strokes = [...ink.strokes(i)];
    const size = doc.pageSize(i);
    const m = marginFor(size.width, strokes, book, opts.marginPages);
    if (!strokes.length && !m.left && !m.right) continue;
    const toPdf = invert((await doc.displayTransform(i)) as Matrix);
    jobs.push({
      index: i,
      toPdf,
      width: size.width,
      height: size.height,
      strokes,
      marginLeft: m.left,
      marginRight: m.right,
      pattern: book.pattern ?? "lines",
    });
  }
  return { jobs, keepPages: opts.scope === "annotated" ? inked : null };
}

/** Runs the export in a worker. */
export function runExportWorker(
  file: Blob,
  jobs: PageJob[],
  keepPages: number[] | null,
  title: string,
  onProgress: (fraction: number, phase: string) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.fraction, m.phase);
      else if (m.type === "done") {
        w.terminate();
        resolve(m.bytes as Uint8Array);
      } else if (m.type === "error") {
        w.terminate();
        console.error(m.detail);
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "worker failed"));
    };
    w.postMessage({ file, jobs, keepPages, title });
  });
}

/** "Rolls-Royce: The Jet Engine" -> "Rolls-Royce The Jet Engine (ghi chu).pdf" */
export function exportFileName(title: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "tai-lieu";
  return `${base} (ghi chu).pdf`;
}
