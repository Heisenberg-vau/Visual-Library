import type { BookMeta, Category } from "../types";
import { STORES, tx, txMulti, updateRecords } from "./idb";

/** Fills fields added after v0.1.0 so old records keep working. */
function normalize(b: BookMeta): BookMeta {
  return {
    ...b,
    kind: b.kind ?? "pdf",
    categoryId: b.categoryId ?? null,
    tags: Array.isArray(b.tags) ? b.tags : [],
    margins: b.margins ?? { left: 0, right: 0 },
    favorite: b.favorite ?? false,
    bookmarks: Array.isArray(b.bookmarks) ? b.bookmarks : [],
  };
}

/** Book metadata, covers, shelves and settings in IndexedDB. */
export class MetaStore {
  async list(): Promise<BookMeta[]> {
    const all = await tx<BookMeta[]>(STORES.books, "readonly", (s) => s.getAll());
    return all
      .map(normalize)
      .sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
  }

  async get(id: string): Promise<BookMeta | undefined> {
    const b = await tx<BookMeta | undefined>(STORES.books, "readonly", (s) => s.get(id));
    return b && normalize(b);
  }

  async findByFingerprint(fp: string): Promise<BookMeta | undefined> {
    const r = await tx<BookMeta[]>(STORES.books, "readonly", (s) =>
      s.index("fingerprint").getAll(fp),
    );
    return r[0] && normalize(r[0]);
  }

  async put(meta: BookMeta): Promise<void> {
    await tx(STORES.books, "readwrite", (s) => s.put(meta));
  }

  /**
   * Read-modify-write in ONE transaction: two updates close together (the
   * page count of a notebook and its reading position, say) can no longer
   * overwrite each other with stale copies.
   */
  async update(id: string, patch: Partial<BookMeta>): Promise<BookMeta | undefined> {
    const out = await updateRecords<BookMeta>(STORES.books, [id], (cur) => {
      if (!cur) return undefined;
      const next: Record<string, unknown> = { ...normalize(cur), ...patch, id };
      // `undefined` in a patch removes the field (leaving the trash, out of cold storage)
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
      return next as unknown as BookMeta;
    });
    return out.get(id);
  }

  /** Several books changed by a function of their CURRENT record, in one transaction. */
  async updateMany(ids: string[], change: (b: BookMeta) => Partial<BookMeta>): Promise<void> {
    if (!ids.length) return;
    await updateRecords<BookMeta>(STORES.books, ids, (cur) => {
      if (!cur) return undefined;
      const b = normalize(cur);
      return { ...b, ...change(b), id: b.id };
    });
  }

  async delete(id: string): Promise<void> {
    await tx(STORES.books, "readwrite", (s) => s.delete(id));
    await tx(STORES.covers, "readwrite", (s) => s.delete(id));
  }

  async putCover(id: string, blob: Blob): Promise<void> {
    await tx(STORES.covers, "readwrite", (s) => s.put(blob, id));
  }

  getCover(id: string): Promise<Blob | undefined> {
    return tx<Blob | undefined>(STORES.covers, "readonly", (s) => s.get(id));
  }

  // ---- shelves ----

  listCategories(): Promise<Category[]> {
    return tx<Category[]>(STORES.categories, "readonly", (s) => s.getAll());
  }

  async putCategory(c: Category): Promise<void> {
    await tx(STORES.categories, "readwrite", (s) => s.put(c));
  }

  /**
   * Deletes a shelf and moves its books/shelves, atomically. Books are changed
   * from their current record inside the transaction (only categoryId), so a
   * reading position saved meanwhile is never lost.
   */
  async deleteCategory(id: string, bookIds: string[], newParent: string | null, children: Category[]): Promise<void> {
    await txMulti([STORES.categories, STORES.books], (get) => {
      get(STORES.categories).delete(id);
      for (const c of children) get(STORES.categories).put(c);
      const bs = get(STORES.books);
      for (const bid of bookIds) {
        const r = bs.get(bid);
        r.onsuccess = () => {
          if (r.result && r.result.categoryId === id) bs.put({ ...r.result, categoryId: newParent });
        };
      }
    });
  }

  // ---- settings ----

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const v = await tx<T | undefined>(STORES.settings, "readonly", (s) => s.get(key));
    return v === undefined ? fallback : v;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await tx(STORES.settings, "readwrite", (s) => s.put(value, key));
  }
}
