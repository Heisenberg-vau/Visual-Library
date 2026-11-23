import { STORES, openDb, tx } from "../storage/idb";
import type { WordBox } from "./words";

/** Words of one page as used for search (and for highlights on scans). */
export interface PageText {
  key: string;
  bookId: string;
  page: number;
  /** Where the words came from. "pending" = waiting for OCR. */
  source: "pdf" | "fixed" | "ocr" | "pending" | "none" | "docx";
  words: WordBox[];
  updatedAt: number;
}

export class TextIndexStore {
  key(bookId: string, page: number): string {
    return `${bookId}|${page}`;
  }

  async load(bookId: string): Promise<Map<number, PageText>> {
    const rows = await tx<PageText[]>(STORES.pageText, "readonly", (s) => s.index("bookId").getAll(IDBKeyRange.only(bookId)));
    return new Map(rows.map((r) => [r.page, r]));
  }

  async put(p: Omit<PageText, "key" | "updatedAt">): Promise<PageText> {
    const rec: PageText = { ...p, key: this.key(p.bookId, p.page), updatedAt: Date.now() };
    await tx(STORES.pageText, "readwrite", (s) => s.put(rec));
    return rec;
  }

  async deleteBook(bookId: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORES.pageText, "readwrite");
      const req = t.objectStore(STORES.pageText).index("bookId").openKeyCursor(IDBKeyRange.only(bookId));
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          t.objectStore(STORES.pageText).delete(c.primaryKey);
          c.continue();
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
}
