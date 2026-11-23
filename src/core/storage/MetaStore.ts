import type { BookMeta, Category } from "../types";
import { STORES, tx, txMulti } from "./idb";

/** Fills fields added after v0.1.0 so old records keep working. */
function normalize(b: BookMeta): BookMeta {
  return { ...b, categoryId: b.categoryId ?? null, tags: Array.isArray(b.tags) ? b.tags : [] };
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

  async putMany(metas: BookMeta[]): Promise<void> {
    if (!metas.length) return;
    await txMulti([STORES.books], (get) => {
      for (const m of metas) get(STORES.books).put(m);
    });
  }

  async update(id: string, patch: Partial<BookMeta>): Promise<BookMeta | undefined> {
    const cur = await this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id };
    await this.put(next);
    return next;
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

  /** Deletes a shelf and rewrites the affected books/shelves atomically. */
  async deleteCategory(id: string, books: BookMeta[], children: Category[]): Promise<void> {
    await txMulti([STORES.categories, STORES.books], (get) => {
      get(STORES.categories).delete(id);
      for (const c of children) get(STORES.categories).put(c);
      for (const b of books) get(STORES.books).put(b);
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
