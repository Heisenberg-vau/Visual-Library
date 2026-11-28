import type { BookMeta } from "../types";
import type { FileStore } from "./FileStore";
import type { MetaStore } from "./MetaStore";
import { originalKey } from "./LibraryService";
import { STORES, openDb } from "./idb";

/*
 * Stage 3 · v2.3 — tidying up. Each step only removes what provably belongs
 * to no book (anything in the trash or in cold storage still counts as a book).
 */

const bookOf = (key: IDBValidKey, value: unknown): string | null => {
  const v = value as { bookId?: unknown } | null;
  if (v && typeof v.bookId === "string") return v.bookId;
  return typeof key === "string" ? key : null;
};

/** Deletes files and records that belong to no book. Returns what went. */
export async function removeOrphans(meta: MetaStore, files: FileStore): Promise<{ files: number; records: number }> {
  const list = await meta.list();
  const ids = new Set(list.map((b) => b.id));
  const expected = new Set<string>();
  for (const b of list) {
    if (b.kind === "notebook") continue;
    expected.add(b.id);
    expected.add(originalKey(b.id));
  }
  let nFiles = 0;
  for (const name of await files.list()) {
    if (expected.has(name)) continue;
    await files.delete(name);
    nFiles++;
  }
  const db = await openDb();
  const stores = [STORES.covers, STORES.ink, STORES.pageText, STORES.reading];
  const nRecords = await new Promise<number>((resolve, reject) => {
    let n = 0;
    const t = db.transaction(stores, "readwrite");
    for (const store of stores) {
      const r = t.objectStore(store).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const id = bookOf(c.key, c.value);
        if (id && !ids.has(id)) {
          c.delete();
          n++;
        }
        c.continue();
      };
    }
    t.oncomplete = () => resolve(n);
    t.onerror = () => reject(t.error);
  });
  return { files: nFiles, records: nRecords };
}

export interface DuplicateGroup {
  reason: "same" | "likely";
  books: BookMeta[];
}

/**
 * Books that are the same document: the same fingerprint (identical file), or
 * the same size and page count (very likely the same, e.g. saved again).
 * The oldest of each group comes first: that is the one to keep.
 */
export function findDuplicates(list: BookMeta[]): DuplicateGroup[] {
  const books = list.filter((b) => b.kind !== "notebook" && !b.trashedAt);
  const groups: DuplicateGroup[] = [];
  const seen = new Set<string>();
  const byFp = new Map<string, BookMeta[]>();
  for (const b of books) if (b.fingerprint) byFp.set(b.fingerprint, [...(byFp.get(b.fingerprint) ?? []), b]);
  for (const g of byFp.values()) {
    if (g.length < 2) continue;
    g.forEach((b) => seen.add(b.id));
    groups.push({ reason: "same", books: g.sort((a, b) => a.addedAt - b.addedAt) });
  }
  const bySize = new Map<string, BookMeta[]>();
  for (const b of books) {
    if (seen.has(b.id) || !b.size) continue;
    const k = `${b.size}:${b.pageCount}`;
    bySize.set(k, [...(bySize.get(k) ?? []), b]);
  }
  for (const g of bySize.values()) if (g.length > 1) groups.push({ reason: "likely", books: g.sort((a, b) => a.addedAt - b.addedAt) });
  return groups;
}

/** Books worth putting in cold storage: biggest first among those not opened for a while. */
export function coldCandidates(list: BookMeta[], now = Date.now(), idleDays = 60): BookMeta[] {
  return list
    .filter((b) => b.kind !== "notebook" && !b.cold && !b.trashedAt)
    .filter((b) => now - (b.lastOpenedAt ?? b.addedAt) >= idleDays * 86_400_000)
    .sort((a, b) => b.size - a.size);
}
