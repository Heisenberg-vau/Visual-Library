import type { PagedDocument } from "../../core/pdf/PagedDocument";
import type { OcrEngine } from "../../core/text/ocr";
import type { PageText, TextIndexStore } from "../../core/text/TextIndexStore";
import { searchWords, wordsFromChars, type Hit, type WordBox } from "../../core/text/words";

export interface IndexStatus {
  total: number;
  /** Pages whose own text has been read. */
  scanned: number;
  /** Pages that need OCR (scans, broken encodings), and how many are done. */
  ocrTotal: number;
  ocrDone: number;
  running: boolean;
  queued: boolean;
}

export interface PageHits {
  page: number; // 0-based
  hits: Hit[];
}

const OCR_SCALE = 2.6; // image px per PDF point (~190 dpi): good accuracy, bounded cost
const OCR_MAX_PX = 2600;

/** Pages whose words still have to come from OCR. */
const needsOcr = (p: PageText) => p.source === "pending" || p.source === "fixed";

/**
 * The search index of one book: the PDF's own text where it is fine, OCR for
 * everything else (scans, unreadable text, and text we had to repair, which
 * gets OCR'd anyway to be sure). Driven by the app-wide IndexService.
 */
export class TextIndexer {
  private pages = new Map<number, PageText>();
  private loaded: Promise<void> | null = null;
  private listeners = new Set<(s: IndexStatus) => void>();
  running = false;
  queued = false;
  /** Reading position (1-based) to OCR nearby pages first. */
  currentPage: () => number = () => 1;

  constructor(
    readonly bookId: string,
    private readonly total: number,
    private readonly store: TextIndexStore,
  ) {}

  load(): Promise<void> {
    this.loaded ??= this.store.load(this.bookId).then((m) => {
      this.pages = m;
      this.emit();
    });
    return this.loaded;
  }

  get complete(): boolean {
    if (this.pages.size < this.total) return false;
    for (const p of this.pages.values()) if (needsOcr(p)) return false;
    return true;
  }

  get status(): IndexStatus {
    let ocrTotal = 0;
    let ocrDone = 0;
    for (const p of this.pages.values()) {
      if (needsOcr(p) || p.source === "ocr") ocrTotal++;
      if (p.source === "ocr") ocrDone++;
    }
    return { total: this.total, scanned: this.pages.size, ocrTotal, ocrDone, running: this.running, queued: this.queued };
  }

  onStatus(fn: (s: IndexStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => void this.listeners.delete(fn);
  }

  emit(): void {
    const s = this.status;
    for (const fn of this.listeners) fn(s);
  }

  /** Words of a page from the index (OCR, Word import…) for highlight snapping. */
  snapWords(page: number): WordBox[] | null {
    const p = this.pages.get(page);
    return p && p.source !== "pdf" && p.source !== "pending" && p.words.length ? p.words : null;
  }

  /** Stores words produced elsewhere (e.g. a converted Word document). */
  async putWords(page: number, words: WordBox[], source: PageText["source"]): Promise<void> {
    const rec = await this.store.put({ bookId: this.bookId, page, source, words });
    this.pages.set(page, rec);
  }

  /** Text pass, then OCR pass. Stops early when the signal aborts. */
  async run(doc: PagedDocument, ocr: OcrEngine, signal: AbortSignal): Promise<void> {
    await this.load();
    this.running = true;
    this.emit();
    try {
      await this.textPass(doc, signal);
      await this.ocrPass(doc, ocr, signal);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private async textPass(doc: PagedDocument, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < doc.numPages; i++) {
      if (signal.aborted) return;
      if (this.pages.has(i)) continue;
      const quality = await doc.textQuality(i);
      const chars = quality === "ok" || quality === "fixed" ? await doc.textChars(i) : [];
      const rec = await this.store.put({
        bookId: this.bookId,
        page: i,
        source: quality === "ok" ? "pdf" : quality === "fixed" ? "fixed" : "pending",
        words: wordsFromChars(chars), // repaired text stays searchable until OCR replaces it
      });
      this.pages.set(i, rec);
      if (i % 10 === 9) {
        this.emit();
        await sleep(5); // leave room for page rendering
      }
    }
    this.emit();
  }

  private async ocrPass(doc: PagedDocument, ocr: OcrEngine, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const cur = this.currentPage() - 1;
      const todo = [...this.pages.values()].filter(needsOcr).map((p) => p.page);
      if (!todo.length) return;
      todo.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
      const page = todo[0];
      const size = doc.pageSize(page);
      const scale = Math.min(OCR_SCALE, OCR_MAX_PX / Math.max(size.width, size.height));
      const canvas = document.createElement("canvas");
      await doc.renderPage(page, canvas, scale, 1, signal);
      if (signal.aborted) return;
      const words = await ocr.recognize(canvas, scale);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
