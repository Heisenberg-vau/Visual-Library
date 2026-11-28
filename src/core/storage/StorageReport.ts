import type { BookMeta } from "../types";
import { fileFingerprint } from "../util/fingerprint";
import type { FileStore } from "./FileStore";
import { originalKey } from "./LibraryService";
import type { MetaStore } from "./MetaStore";
import { STORES, openDb } from "./idb";

/*
 * Stage 3 · v2.0 — measuring and checking what the library keeps.
 * Read-only: nothing here changes or deletes data.
 */

/** Approximate bytes a value takes in IndexedDB (blobs and typed arrays exactly). */
export function approxBytes(v: unknown, depth = 0): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (typeof v === "number") return 8;
  if (typeof v === "boolean") return 4;
  if (typeof Blob !== "undefined" && v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (depth > 12) return 0;
  if (Array.isArray(v)) {
    let n = 0;
    for (const x of v) n += approxBytes(x, depth + 1);
    return n + v.length;
  }
  if (typeof v === "object") {
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) n += k.length + approxBytes(x, depth + 1);
    return n;
  }
  return 0;
}

/** Visits every record of a store with its key (a cursor: one record in memory at a time). */
export async function eachRecord(store: string, fn: (key: IDBValidKey, value: unknown) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const r = t.objectStore(store).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return;
      fn(c.key, c.value);
      c.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export interface BookUsage {
  id: string;
  title: string;
  kind: BookMeta["kind"];
  categoryId: string | null;
  /** The file you read (for Word: the converted copy). */
  file: number;
  /** For Word: the untouched .docx kept beside the reading copy. */
  original: number;
  cover: number;
  /** Handwriting, highlights, pasted clips. */
  notes: number;
  /** Words for search (the PDF's own text or OCR). */
  text: number;
  total: number;
  /** The file could not be found. */
  missing: boolean;
  /** In cold storage (no file on purpose) / in the trash. */
  cold?: boolean;
  trashed?: boolean;
  lastOpenedAt?: number | null;
  addedAt?: number;
}

export interface LibraryUsage {
  books: BookUsage[];
  /** Your pictures on the wall. */
  pictures: number;
  /** Planner, study time, reading progress, settings. */
  other: number;
  /** Data that belongs to no book any more. */
  orphans: number;
  total: number;
}

const bookOf = (key: IDBValidKey, value: unknown): string | null => {
  const v = value as { bookId?: unknown } | null;
  if (v && typeof v.bookId === "string") return v.bookId;
  return typeof key === "string" ? key : null;
};

export async function measureLibrary(meta: MetaStore, files: FileStore, onProgress?: (done: number, total: number) => void): Promise<LibraryUsage> {
  const list = await meta.list();
  const byId = new Map<string, BookUsage>();
  let i = 0;
  for (const b of list) {
    const u: BookUsage = { id: b.id, title: b.title, kind: b.kind, categoryId: b.categoryId ?? null, file: 0, original: 0, cover: 0, notes: 0, text: 0, total: 0, missing: false, cold: !!b.cold, trashed: !!b.trashedAt, lastOpenedAt: b.lastOpenedAt, addedAt: b.addedAt };
    if (b.kind !== "notebook" && !b.cold) {
      try {
        u.file = (await files.read(b.id)).size;
      } catch {
        u.missing = true;
      }
      if (b.source) u.original = await files.read(originalKey(b.id)).then((f) => f.size, () => 0);
    }
    byId.set(b.id, u);
    onProgress?.(++i, list.length);
  }
  let orphans = 0;
  let pictures = 0;
  let other = 0;
  const add = (id: string | null, field: "cover" | "notes" | "text", n: number) => {
    const u = id ? byId.get(id) : undefined;
    if (u) u[field] += n;
    else orphans += n;
  };
  await eachRecord(STORES.covers, (k, v) => add(String(k), "cover", approxBytes(v)));
  await eachRecord(STORES.ink, (k, v) => add(bookOf(k, v), "notes", approxBytes(v)));
  await eachRecord(STORES.pageText, (k, v) => add(bookOf(k, v), "text", approxBytes(v)));
  await eachRecord(STORES.settings, (k, v) => {
    if (String(k).startsWith("picture:")) pictures += approxBytes(v);
    else other += approxBytes(v);
  });
  for (const s of [STORES.tasks, STORES.study, STORES.reading, STORES.readingDays, STORES.categories, STORES.books]) {
    await eachRecord(s, (_k, v) => (other += approxBytes(v)));
  }
  const books = [...byId.values()];
  for (const u of books) u.total = u.file + u.original + u.cover + u.notes + u.text;
  books.sort((a, b) => b.total - a.total);
  const total = books.reduce((n, u) => n + u.total, 0) + pictures + other + orphans;
  return { books, pictures, other, orphans, total };
}

export interface IntegrityReport {
  books: number;
  /** Books whose file is gone (they cannot open). */
  missingFiles: { id: string; title: string }[];
  /** Word books whose untouched .docx is gone (they still open). */
  missingOriginals: { id: string; title: string }[];
  /** Files on disk that belong to no book. */
  orphanFiles: { name: string; size: number }[];
  /** Records that belong to no book (notes, text, covers, progress). */
  orphanRecords: { store: string; count: number; bytes: number }[];
  /** Files whose size or fingerprint no longer matches what was imported. */
  damaged: { id: string; title: string; reason: string }[];
  /** Whether file contents were checked (fingerprints), not just presence. */
  deep: boolean;
}

export function integrityProblems(r: IntegrityReport): number {
  return r.missingFiles.length + r.missingOriginals.length + r.orphanFiles.length + r.orphanRecords.reduce((n, o) => n + o.count, 0) + r.damaged.length;
}

/**
 * Looks for anything inconsistent. With `deep`, also re-reads the start and
 * end of every file and compares its fingerprint with the one taken at import
 * (whole-file checksums come with backups in v2.1).
 */
export async function checkIntegrity(
  meta: MetaStore,
  files: FileStore,
  opts: { deep?: boolean; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<IntegrityReport> {
  const list = await meta.list();
  const ids = new Set(list.map((b) => b.id));
  const rep: IntegrityReport = { books: list.length, missingFiles: [], missingOriginals: [], orphanFiles: [], orphanRecords: [], damaged: [], deep: !!opts.deep };
  const expected = new Set<string>();
  let i = 0;
  for (const b of list) {
    if (opts.signal?.aborted) break;
    if (b.kind !== "notebook" && !b.cold) {
      expected.add(b.id);
      let f: File | null = null;
      try {
        f = await files.read(b.id);
      } catch {
        rep.missingFiles.push({ id: b.id, title: b.title });
      }
      let orig: File | null = null;
      if (b.source) {
        expected.add(originalKey(b.id));
        try {
          orig = await files.read(originalKey(b.id));
        } catch {
          rep.missingOriginals.push({ id: b.id, title: b.title });
        }
      }
      // the fingerprint was taken on the file as imported (the .docx for Word)
      const imported = b.source ? orig : f;
      if (imported && !b.source && b.size && imported.size !== b.size) rep.damaged.push({ id: b.id, title: b.title, reason: `kích thước ${imported.size} byte, lúc nhập là ${b.size} byte` });
      else if (imported && opts.deep && b.fingerprint) {
        try {
          if ((await fileFingerprint(imported)) !== b.fingerprint) rep.damaged.push({ id: b.id, title: b.title, reason: "nội dung đầu/cuối file đã khác lúc nhập" });
        } catch {
          rep.damaged.push({ id: b.id, title: b.title, reason: "không đọc được file" });
        }
      }
    }
    opts.onProgress?.(++i, list.length);
  }
  for (const name of await files.list().catch(() => [] as string[])) {
    if (expected.has(name)) continue;
    const size = await files.read(name).then((f) => f.size, () => 0);
    rep.orphanFiles.push({ name, size });
  }
  const orphanIn = async (store: string, label: string) => {
    let count = 0;
    let bytes = 0;
    await eachRecord(store, (k, v) => {
      const id = bookOf(k, v);
      if (id && !ids.has(id)) {
        count++;
        bytes += approxBytes(v);
      }
    });
    if (count) rep.orphanRecords.push({ store: label, count, bytes });
  };
  await orphanIn(STORES.covers, "Bìa");
  await orphanIn(STORES.ink, "Ghi chú, nét bút");
  await orphanIn(STORES.pageText, "Chữ tìm kiếm / OCR");
  await orphanIn(STORES.reading, "Tiến độ đọc");
  return rep;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${u[i]}`.replace(".", ",");
}
