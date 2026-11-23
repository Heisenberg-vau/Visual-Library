import type { PagedDocument } from "../core/pdf/PagedDocument";
import type { LibraryService } from "../core/storage/LibraryService";
import type { OcrEngine } from "../core/text/ocr";
import type { TextIndexStore } from "../core/text/TextIndexStore";
import { TextIndexer } from "../ui/reader/TextIndexer";

/**
 * Indexes every book in the background, starting right after import, like a
 * browser that OCRs a scanned PDF before you use it. One book at a time; the
 * book you are reading jumps the queue, and its pages near where you are go
 * first. Pausing happens automatically while the app is hidden.
 */
export class IndexService {
  private indexers = new Map<string, TextIndexer>();
  private queue: string[] = [];
  private current: { id: string; ctrl: AbortController } | null = null;
  private listeners = new Set<(bookId: string) => void>();
  private kicking = false;

  constructor(
    private readonly library: LibraryService,
    private readonly store: TextIndexStore,
    private readonly ocr: OcrEngine,
    private readonly openDoc: (bookId: string) => Promise<PagedDocument>,
  ) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
  }

  onChange(fn: (bookId: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The (shared) index of a book; created and loaded on first use. */
  async get(bookId: string): Promise<TextIndexer | null> {
    let ix = this.indexers.get(bookId);
    if (!ix) {
      const b = await this.library.get(bookId);
      if (!b || b.kind !== "pdf") return null;
      ix = new TextIndexer(bookId, b.pageCount, this.store);
      ix.onStatus(() => this.listeners.forEach((fn) => fn(bookId)));
      this.indexers.set(bookId, ix);
    }
    await ix.load();
    return ix;
  }

  statusOf(bookId: string) {
    return this.indexers.get(bookId)?.status ?? null;
  }

  /** Queue every PDF that is not fully indexed yet (on app start). */
  async enqueueAll(): Promise<void> {
    for (const b of await this.library.list()) {
      if (b.kind === "pdf" && !b.indexDone) this.enqueue(b.id);
    }
  }

  enqueue(bookId: string): void {
    if (!this.queue.includes(bookId) && this.current?.id !== bookId) this.queue.push(bookId);
    void this.get(bookId).then((ix) => {
      if (ix) {
        ix.queued = true;
        ix.emit();
      }
    });
    this.kick();
  }

  /** The book open in the reader goes first; `page` gives its reading position. */
  focus(bookId: string | null, page?: () => number): void {
    if (!bookId) return;
    void this.get(bookId).then((ix) => {
      if (!ix) return;
      if (page) ix.currentPage = page;
      if (ix.complete) return;
      this.queue = [bookId, ...this.queue.filter((x) => x !== bookId)];
      // Pause another book to start this one now.
      if (this.current && this.current.id !== bookId) this.current.ctrl.abort();
      this.kick();
    });
  }

  remove(bookId: string): void {
    this.queue = this.queue.filter((x) => x !== bookId);
    if (this.current?.id === bookId) this.current.ctrl.abort();
    this.indexers.delete(bookId);
  }

  private kick(): void {
    if (this.current || this.kicking) return;
    this.kicking = true;
    queueMicrotask(() => {
      this.kicking = false;
      void this.loop();
    });
  }

  private async loop(): Promise<void> {
    while (!this.current && this.queue.length) {
      if (document.visibilityState === "hidden") return; // resumes on visibility
      const id = this.queue.shift()!;
      const ix = await this.get(id);
      if (!ix || ix.complete) {
        if (ix) await this.markDone(ix);
        continue;
      }
      const ctrl = new AbortController();
      this.current = { id, ctrl };
      ix.queued = false;
      let doc: PagedDocument | null = null;
      try {
        doc = await this.openDoc(id);
        await ix.run(doc, this.ocr, ctrl.signal);
      } catch (e) {
        if (!ctrl.signal.aborted) console.warn("indexing failed", id, e);
      } finally {
        await doc?.destroy().catch(() => {});
        this.current = null;
      }
      if (ix.complete) await this.markDone(ix);
      else if (ctrl.signal.aborted && this.indexers.has(id)) {
        // Paused for another book: continue later.
        if (!this.queue.includes(id)) this.queue.push(id);
        ix.queued = true;
        ix.emit();
      }
    }
  }

  private async markDone(ix: TextIndexer): Promise<void> {
    ix.queued = false;
    ix.emit();
    await this.library.setIndexDone(ix.bookId, true);
  }
}
