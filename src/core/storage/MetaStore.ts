import type { BookMeta } from "../types";
import { STORES, tx } from "./idb";

/** Book metadata, covers and settings in IndexedDB. */
export class MetaStore {
  async list(): Promise<BookMeta[]> {
    const all = await tx<BookMeta[]>(STORES.books, "readonly", (s) => s.getAll());
    return all.sort(
      (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt),
    );
  }

  get(id: string): Promise<BookMeta | undefined> {
    return tx<BookMeta | undefined>(STORES.books, "readonly", (s) => s.get(id));
  }

  async findByFingerprint(fp: string): Promise<BookMeta | undefined> {
    const r = await tx<BookMeta[]>(STORES.books, "readonly", (s) =>
      s.index("fingerprint").getAll(fp),
    );
    return r[0];
  }

  async put(meta: BookMeta): Promise<void> {
    await tx(STORES.books, "readwrite", (s) => s.put(meta));
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

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const v = await tx<T | undefined>(STORES.settings, "readonly", (s) => s.get(key));
    return v === undefined ? fallback : v;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await tx(STORES.settings, "readwrite", (s) => s.put(value, key));
  }
}
