import {
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  PasswordException,
  InvalidPDFException,
  RenderingCancelledException,
  Util,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { layoutChars, type CharBox, type TextRun } from "../text/textGeometry";
import { LruCache } from "../util/lru";
import type { OutlineNode, PageSize } from "../types";
import { UserFacingError } from "../types";
import type { PagedDocument, TextQuality } from "./PagedDocument";
import { findShift, looksGarbled, shiftText } from "../text/encoding";

GlobalWorkerOptions.workerSrc = workerUrl;

function assetUrl(path: string): string {
  return new URL(`pdfjs/${path}`, document.baseURI).href;
}

/** Feeds pdf.js byte ranges straight from a disk-backed File. */
class FileRangeTransport extends PDFDataRangeTransport {
  constructor(private readonly file: Blob) {
    super(file.size, null);
  }

  override requestDataRange(begin: number, end: number): void {
    this.file
      .slice(begin, end)
      .arrayBuffer()
      .then((buf) => this.onDataRange(begin, new Uint8Array(buf)))
      .catch((e) => console.error("range read failed", e));
  }
}

/** Glyph advance ratios measured with a similar system font. */
const widthCache = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null = null;
function measureCharWidth(ch: string, family = "sans-serif"): number {
  const key = family + "\u0000" + ch;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    if (!measureCtx) return 0.5;
    measureCtx.font = `100px ${family}`;
    w = measureCtx.measureText(ch).width / 100 || 0.5;
    widthCache.set(key, w);
  }
  return w;
}

/** Max canvas area. Android Chrome is unstable above ~16.7 M pixels. */
const MAX_CANVAS_PIXELS = 16_000_000;

export async function looksLikePdf(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const s = String.fromCharCode(...head);
  return s.includes("%PDF-");
}

export async function openPdf(file: Blob): Promise<PdfDocument> {
  const task = getDocument({
    range: new FileRangeTransport(file),
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: assetUrl("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts/"),
    wasmUrl: assetUrl("wasm/"),
    iccUrl: assetUrl("iccs/"),
    enableXfa: false,
  });
  try {
    const pdf = await task.promise;
    const doc = new PdfDocument(pdf, () => task.destroy());
    await doc.init();
    return doc;
  } catch (e) {
    await task.destroy().catch(() => {});
    if (e instanceof PasswordException) {
      throw new UserFacingError("File PDF này có mật khẩu, phiên bản hiện tại chưa mở được.");
    }
    if (e instanceof InvalidPDFException) {
      throw new UserFacingError("File bị hỏng hoặc không phải PDF hợp lệ.");
    }
    throw e;
  }
}

export class PdfDocument implements PagedDocument {
  private sizes: (PageSize | null)[];
  private fallback: PageSize = { width: 595, height: 842 };
  private knownCount = 0;
  metaTitle: string | null = null;
  private textCache = new LruCache<number, Promise<{ chars: CharBox[]; quality: TextQuality }>>(40);
  /** Repairs found per PDF font, reused on later pages. */
  private fontShift = new Map<string, number | null>();

  constructor(
    private readonly pdf: PDFDocumentProxy,
    private readonly teardown: () => Promise<void>,
  ) {
    this.sizes = new Array(pdf.numPages).fill(null);
  }

  get numPages(): number {
    return this.pdf.numPages;
  }

  get fingerprint(): string {
    return this.pdf.fingerprints[0] ?? "";
  }

  get allSizesKnown(): boolean {
    return this.knownCount === this.numPages;
  }

  async init(): Promise<void> {
    const first = await this.pdf.getPage(1);
    this.fallback = this.recordSize(0, first);
    try {
      const meta = await this.pdf.getMetadata();
      const info = meta.info as { Title?: unknown } | undefined;
      const t = typeof info?.Title === "string" ? info.Title.trim() : "";
      this.metaTitle = t && !/^untitled$/i.test(t) && !/\.(docx?|pdf)$/i.test(t) ? t : null;
    } catch {
      this.metaTitle = null;
    }
  }

  private recordSize(i: number, page: PDFPageProxy): PageSize {
    const vp = page.getViewport({ scale: 1 });
    const s = { width: vp.width, height: vp.height };
    if (!this.sizes[i]) this.knownCount++;
    this.sizes[i] = s;
    return s;
  }

  pageSize(i: number): PageSize {
    return this.sizes[i] ?? this.fallback;
  }

  async loadPageSizes(onBatch: () => void, signal?: AbortSignal): Promise<void> {
    const BATCH = 25;
    let changed = false;
    for (let i = 0; i < this.numPages; i++) {
      if (signal?.aborted) return;
      if (this.sizes[i]) continue;
      let page: PDFPageProxy;
      try {
        page = await this.pdf.getPage(i + 1);
      } catch (e) {
        if (signal?.aborted) return; // document closed meanwhile
        throw e;
      }
      const before = this.fallback;
      const s = this.recordSize(i, page);
      if (s.width !== before.width || s.height !== before.height) changed = true;
      if ((i + 1) % BATCH === 0) {
        if (changed) onBatch();
        changed = false;
        // Yield so rendering of the visible page is not starved.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (changed) onBatch();
  }

  async renderPage(
    i: number,
    canvas: HTMLCanvasElement,
    cssScale: number,
    pixelRatio: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const page = await this.pdf.getPage(i + 1);
    this.recordSize(i, page);
    if (signal.aborted) return;
    let ratio = pixelRatio;
    const base = page.getViewport({ scale: cssScale });
    const area = base.width * base.height * ratio * ratio;
    if (area > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    const vp = page.getViewport({ scale: cssScale * ratio });
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const task = page.render({ canvas, viewport: vp, background: "#ffffff" });
    const onAbort = () => task.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await task.promise;
    } catch (e) {
      if (e instanceof RenderingCancelledException || signal.aborted) return;
      throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async getOutline(): Promise<OutlineNode[]> {
    const raw = await this.pdf.getOutline().catch(() => null);
    if (!raw) return [];
    const resolve = async (dest: unknown): Promise<number | null> => {
      try {
        let d = dest;
        if (typeof d === "string") d = await this.pdf.getDestination(d);
        if (!Array.isArray(d) || d.length === 0) return null;
        const ref = d[0];
        if (typeof ref === "number") return ref + 1;
        if (ref && typeof ref === "object") return (await this.pdf.getPageIndex(ref)) + 1;
        return null;
      } catch {
        return null;
      }
    };
    type RawItem = { title: string; dest: unknown; items: RawItem[] };
    const walk = async (items: RawItem[]): Promise<OutlineNode[]> =>
      Promise.all(
        items.map(async (it) => ({
          title: (it.title || "").trim() || "(không tên)",
          page: await resolve(it.dest),
          children: await walk(it.items ?? []),
        })),
      );
    return walk(raw as unknown as RawItem[]);
  }

  async displayTransform(i: number): Promise<[number, number, number, number, number, number]> {
    const page = await this.pdf.getPage(i + 1);
    return page.getViewport({ scale: 1 }).transform as [number, number, number, number, number, number];
  }

  private text(i: number): Promise<{ chars: CharBox[]; quality: TextQuality }> {
    let p = this.textCache.get(i);
    if (!p) {
      p = this.loadText(i).catch(() => ({ chars: [], quality: "empty" as TextQuality }));
      this.textCache.set(i, p);
    }
    return p;
  }

  async textChars(i: number): Promise<CharBox[]> {
    return (await this.text(i)).chars;
  }

  async textQuality(i: number): Promise<TextQuality> {
    return (await this.text(i)).quality;
  }

  private async loadText(i: number): Promise<{ chars: CharBox[]; quality: TextQuality }> {
    const page = await this.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const styles = content.styles as Record<string, { fontFamily?: string }>;
    const runs: TextRun[] = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str) continue;
      const m = Util.transform(vp.transform, it.transform) as TextRun["m"];
      runs.push({
        str: it.str,
        m,
        width: it.dir === "ttb" ? it.height : it.width,
        family: styles[it.fontName]?.fontFamily,
        font: it.fontName,
      });
    }
    if (!runs.some((r) => r.str.trim())) return { chars: [], quality: "empty" };
    // Repair fonts whose codes are shifted (copy/paste gives other letters).
    let fixed = false;
    const byFont = new Map<string, TextRun[]>();
    for (const r of runs) {
      const k = r.font ?? "";
      const l = byFont.get(k) ?? [];
      l.push(r);
      byFont.set(k, l);
    }
    for (const [font, list] of byFont) {
      const sample = list.map((r) => r.str).join(" ");
      let d = this.fontShift.get(font);
      if (d === undefined) {
        d = sample.replace(/\s/g, "").length >= 30 && looksGarbled(sample) ? findShift(sample) : null;
        if (d !== null || sample.length >= 200) this.fontShift.set(font, d);
      }
      if (d) {
        for (const r of list) r.str = shiftText(r.str, d);
        fixed = true;
      }
    }
    const all = runs.map((r) => r.str).join(" ");
    const quality: TextQuality = looksGarbled(all) ? "garbled" : fixed ? "fixed" : "ok";
    return { chars: layoutChars(runs, measureCharWidth), quality };
  }

  /** Small JPEG of page 1 for the bookshelf. */
  async renderCover(width = 240): Promise<Blob | null> {
    const page = await this.pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvas, viewport: vp, background: "#ffffff" }).promise;
    return new Promise((r) => canvas.toBlob((b) => r(b), "image/jpeg", 0.8));
  }

  async destroy(): Promise<void> {
    await this.teardown();
  }
}
