import type { InkModel } from "../annotations/InkModel";
import type { Margins, PaperPattern, Stroke } from "../annotations/types";
import type { PagedDocument } from "../pdf/PagedDocument";
import { asciiFold } from "../notebook/links";
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

/**
 * Text clips are drawn into pictures before export: standard PDF fonts have
 * no Vietnamese letters, and the picture matches the screen exactly.
 */
export async function rasterizeTextClips(jobs: PageJob[]): Promise<PageJob[]> {
  const { CLIP_BAR, CLIP_BAR_COLOR, CLIP_FONT, CLIP_FONT_FAMILY, CLIP_LINE, CLIP_PAD } = await import("../notebook/clips");
  const K = 4; // pixels per point (~290 dpi)
  return jobs.map((job) => {
    if (!job.strokes.some((s) => s.tool === "clip" && s.clip?.kind === "text")) return job;
    const strokes = job.strokes.map((s) => {
      if (s.tool !== "clip" || s.clip?.kind !== "text" || !s.rects) return s;
      const [, , w, h] = s.rects;
      const fs = s.clip.fontSize ?? CLIP_FONT;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(w * K));
      c.height = Math.max(1, Math.ceil(h * K));
      const ctx = c.getContext("2d")!;
      ctx.scale(K, K);
      ctx.fillStyle = CLIP_BAR_COLOR;
      ctx.fillRect(0, 0, CLIP_BAR, h);
      ctx.fillStyle = s.color;
      ctx.font = `${fs}px ${CLIP_FONT_FAMILY}`;
      (s.clip.lines ?? []).forEach((line, i) => ctx.fillText(line, CLIP_PAD, fs * (0.95 + i * CLIP_LINE)));
      const src = c.toDataURL("image/png");
      c.width = 0;
      return { ...s, clip: { ...s.clip, src } };
    });
    return { ...job, strokes };
  });
}

/** Runs the export in a worker. */
export async function runExportWorker(
  file: Blob | null,
  jobs: PageJob[],
  keepPages: number[] | null,
  title: string,
  onProgress: (fraction: number, phase: string) => void,
  blank?: { count: number; width: number; height: number },
): Promise<Uint8Array> {
  jobs = await rasterizeTextClips(jobs);
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
    w.postMessage({ file, jobs, keepPages, title, blank });
  });
}

/** "Rolls-Royce: The Jet Engine" -> "Rolls-Royce The Jet Engine (ghi chu).pdf" */
export function exportFileName(title: string): string {
  // ASCII only: some download managers and chat apps mangle accents.
  const base = asciiFold(title)
    .replace(/\?/g, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "tai-lieu";
  return `${base} (ghi chu).pdf`;
}

/** Jobs for a notebook: every kept page gets its paper, plus any ink. */
export function buildNotebookJobs(
  pageCount: number,
  size: { width: number; height: number },
  paper: PaperPattern,
  ink: InkModel,
  scope: ExportOptions["scope"],
): { jobs: PageJob[]; keepPages: number[] | null; blank: { count: number; width: number; height: number } } {
  const inked = ink.pagesWithInk();
  const toPdf: Matrix = [1, 0, 0, -1, 0, size.height];
  const pages = Array.from({ length: pageCount }, (_, i) => i);
  const jobs: PageJob[] = pages.map((i) => ({
    index: i,
    toPdf,
    width: size.width,
    height: size.height,
    strokes: [...ink.strokes(i)],
    marginLeft: 0,
    marginRight: 0,
    pattern: paper,
    fullPaper: paper,
  }));
  return { jobs, keepPages: scope === "annotated" ? inked : null, blank: { count: pageCount, ...size } };
}
