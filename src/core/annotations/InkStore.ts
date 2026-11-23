import { STORES, openDb, tx } from "../storage/idb";
import type { PageInk, Stroke } from "./types";

/** Handwriting in IndexedDB, one record per (book, page). */
export class InkStore {
  private key(bookId: string, page: number): string {
    return `${bookId}|${page}`;
  }

  async load(bookId: string): Promise<Map<number, Stroke[]>> {
    const rows = await tx<PageInk[]>(STORES.ink, "readonly", (s) =>
      s.index("bookId").getAll(IDBKeyRange.only(bookId)),
    );
    return new Map(rows.map((r) => [r.page, r.strokes]));
  }

  async savePage(bookId: string, page: number, strokes: Stroke[]): Promise<void> {
    const key = this.key(bookId, page);
    if (strokes.length === 0) {
      await tx(STORES.ink, "readwrite", (s) => s.delete(key));
    } else {
      const rec: PageInk & { key: string } = { key, bookId, page, strokes };
      await tx(STORES.ink, "readwrite", (s) => s.put(rec));
    }
  }

  async deleteBook(bookId: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORES.ink, "readwrite");
      const req = t.objectStore(STORES.ink).index("bookId").openKeyCursor(IDBKeyRange.only(bookId));
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          t.objectStore(STORES.ink).delete(c.primaryKey);
          c.continue();
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async countPages(bookId: string): Promise<number> {
    return tx<number>(STORES.ink, "readonly", (s) => s.index("bookId").count(IDBKeyRange.only(bookId)));
  }
}
