import type { PagedDocument } from "../../core/pdf/PagedDocument";
import type { OcrEngine } from "../../core/text/ocr";
import type { PageText, TextIndexStore } from "../../core/text/TextIndexStore";
import { searchWords, wordsFromChars, type Hit, type WordBox } from "../../core/text/words";

export interface IndexStatus {
  total: number;
  /** Pages whose own text has been read. */
  scanned: number;
  /** Pages that need OCR, and how many are done. */
  ocrTotal: number;
  ocrDone: number;
  running: boolean;
}

export interface PageHits {
  page: number; // 0-based
  hits: Hit[];
}

const OCR_SCALE = 2.6; // image px per PDF point (~190 dpi): good accuracy, bounded cost
const OCR_MAX_PX = 2600;

/**
 * Builds the search index of the open book in the background: the PDF's own
 * text first (quick), then OCR for scanned or unreadable pages, nearest to
 * where you are reading first. Results are saved, so it resumes next time.
 */
export class TextIndexer {
  private pages = new Map<number, PageText>();
  private ctrl = new AbortController();
  private listeners = new Set<(s: IndexStatus) => void>();
  private started = false;

  constructor(
    private readonly bookId: string,
    private readonly doc: PagedDocument,
    private readonly store: TextIndexStore,
    private readonly ocr: OcrEngine,
    private readonly currentPage: () => number,
  ) {}

  get status(): IndexStatus {
    let scanned = 0;
    let ocrTotal = 0;
    let ocrDone = 0;
    for (const p of this.pages.values()) {
      scanned++;
      if (p.source === "pending" || p.source === "ocr") ocrTotal++;
      if (p.source === "ocr") ocrDone++;
    }
    return { total: this.doc.numPages, scanned, ocrTotal, ocrDone, running: this.started && !this.ctrl.signal.aborted && this.busy };
  }

  private busy = false;

  onStatus(fn: (s: IndexStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    const s = this.status;
    for (const fn of this.listeners) fn(s);
  }

  /** OCR words for a page (used to snap highlights on scans), if known. */
  ocrWords(page: number): WordBox[] | null {
    const p = this.pages.get(page);
    return p?.source === "ocr" ? p.words : null;
  }

  words(page: number): WordBox[] | null {
    return this.pages.get(page)?.words ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.busy = true;
    this.pages = await this.store.load(this.bookId);
    this.emit();
    const signal = this.ctrl.signal;
    try {
      await this.textPass(signal);
      await this.ocrPass(signal);
    } catch (e) {
      if (!signal.aborted) console.warn("indexing stopped", e);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private async textPass(signal: AbortSignal): Promise<void> {
    for (let i = 0; i < this.doc.numPages; i++) {
      if (signal.aborted) return;
      if (this.pages.has(i)) continue;
      const quality = await this.doc.textQuality(i);
      const chars = quality === "ok" || quality === "fixed" ? await this.doc.textChars(i) : [];
      const rec = await this.store.put({
        bookId: this.bookId,
        page: i,
        source: quality === "ok" ? "pdf" : quality === "fixed" ? "fixed" : "pending",
        words: wordsFromChars(chars),
      });
      this.pages.set(i, rec);
      if (i % 10 === 9) {
        this.emit();
        await sleep(5); // leave room for page rendering
      }
    }
    this.emit();
  }

  private async ocrPass(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const cur = this.currentPage() - 1;
      const pending = [...this.pages.values()].filter((p) => p.source === "pending").map((p) => p.page);
      if (!pending.length) return;
      pending.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
      const page = pending[0];
      const size = this.doc.pageSize(page);
      const scale = Math.min(OCR_SCALE, OCR_MAX_PX / Math.max(size.width, size.height));
      const canvas = document.createElement("canvas");
      await this.doc.renderPage(page, canvas, scale, 1, signal);
      if (signal.aborted) return;
      const words = await this.ocr.recognize(canvas, scale);
      canvas.width = 0;
      if (signal.aborted) return;
      const rec = await this.store.put({ bookId: this.bookId, page, source: "ocr", words });
      this.pages.set(page, rec);
      this.emit();
      await sleep(30);
    }
  }

  search(query: string): PageHits[] {
    const out: PageHits[] = [];
    const pages = [...this.pages.values()].sort((a, b) => a.page - b.page);
    for (const p of pages) {
      if (!p.words.length) continue;
      const hits = searchWords(p.words, query, 20);
      if (hits.length) out.push({ page: p.page, hits });
    }
    return out;
  }

  /** Boxes to highlight for a hit, merged per line. */
  hitRects(page: number, hit: Hit): number[] {
    const words = this.pages.get(page)?.words ?? [];
    const rects: number[][] = [];
    for (let i = hit.from; i <= hit.to; i++) {
      const w = words[i];
      if (!w) continue;
      const last = rects[rects.length - 1];
      if (last && Math.abs(last[1] - w.y) < w.h * 0.5) {
        const x1 = Math.max(last[0] + last[2], w.x + w.w);
        last[0] = Math.min(last[0], w.x);
        last[2] = x1 - last[0];
        last[3] = Math.max(last[3], w.h);
      } else {
        rects.push([w.x, w.y, w.w, w.h]);
      }
    }
    return rects.flat();
  }

  stop(): void {
    this.ctrl.abort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
