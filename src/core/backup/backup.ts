import type { FileStore } from "../storage/FileStore";
import { STORES, openDb } from "../storage/idb";
import { BackupError, BackupWriter, b64, unb64, type EntryInfo, type OpenedBackup, type Sink } from "./container";

/*
 * Stage 3 · v2.1 — backing the library up and bringing it back.
 *
 * A backup holds the database (every store, blobs and all) and, depending on
 * its kind, the book files:
 *   full    – every file
 *   new     – files not in an earlier backup (and the whole database)
 *   notes   – no files: notes, plans, progress, shelves (small, any time)
 * Restoring takes the newest database among the chosen backups and the files
 * from whichever backup has them, after every hash has been checked.
 */

export type BackupKind = "full" | "new" | "notes";
export const BACKUP_LOG_KEY = "backupLog";
/** Settings that describe this device, not the library. */
const LOCAL_SETTINGS = new Set(["diagMarker", BACKUP_LOG_KEY]);
/** The database stores in a backup ("blobs" holds files on devices without a file area: they go as files). */
const DB_STORES = Object.values(STORES).filter((s) => s !== STORES.blobs);
/** Stores whose records carry their own key. */
const OUT_OF_LINE = new Set<string>([STORES.covers, STORES.settings]);

export interface BackupLog {
  last: { id: string; at: number; kind: BackupKind; size: number; locked: boolean } | null;
  /** Files already in some backup (name → size). */
  files: Record<string, number>;
  /** Which backup file holds each of them (name → file name of the backup). */
  names?: Record<string, string>;
}

export interface Manifest {
  format: 1;
  id: string;
  kind: BackupKind;
  createdAt: number;
  app: string;
  books: number;
  notebooks: number;
  /** Files in this backup. */
  files: string[];
  /** Every file the library had (to tell what a restore still needs). */
  libraryFiles: Record<string, number>;
  stores: string[];
  part?: { n: number; of: number; set: string };
  entries: EntryInfo[];
}

async function dumpStore(store: string): Promise<{ keys: IDBValidKey[]; values: unknown[] }> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const s = t.objectStore(store);
    const kr = s.getAllKeys();
    const vr = s.getAll();
    t.oncomplete = () => resolve({ keys: kr.result, values: vr.result });
    t.onerror = () => reject(t.error);
  });
}

export interface BackupProgress {
  phase: "db" | "files" | "finish";
  done: number;
  total: number;
}

export async function makeBackup(opts: {
  kind: BackupKind;
  files: FileStore;
  log: BackupLog;
  app: string;
  password?: string;
  /** Where encrypted frames go (a file on disk in the app). */
  cipherOut?: () => { write(b: Uint8Array): Promise<void>; close(): Promise<Blob> };
  plainSink?: () => Sink;
  iterations?: number;
  /** The name the backup will be saved under (remembered per file, for cold storage). */
  fileName?: string;
  /** Only these files (one part of a backup split in several files). */
  only?: string[];
  /** Part n of `of`, all sharing `set`. */
  part?: { n: number; of: number; set: string };
  onProgress?: (p: BackupProgress) => void;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; manifest: Manifest; log: BackupLog }> {
  const w = await BackupWriter.create({ app: opts.app, password: opts.password, cipherOut: opts.cipherOut, plainSink: opts.plainSink, iterations: opts.iterations });
  opts.signal?.addEventListener("abort", () => w.cancel());
  const id = crypto.randomUUID();
  // the database, store by store; blobs and byte arrays travel as their own entries
  const blobs: Blob[] = [];
  const encode = (_k: string, v: unknown) => {
    if (v instanceof Uint8Array) return { $u8: b64(v) };
    if (typeof Blob !== "undefined" && v instanceof Blob) {
      blobs.push(v);
      return { $blob: blobs.length - 1, type: v.type };
    }
    return v;
  };
  let books = 0;
  let notebooks = 0;
  for (const store of DB_STORES) {
    const { keys, values } = await dumpStore(store);
    let records: unknown[] = OUT_OF_LINE.has(store) ? keys.map((k, i) => [k, values[i]]) : values;
    if (store === STORES.settings) records = (records as [IDBValidKey, unknown][]).filter(([k]) => !LOCAL_SETTINGS.has(String(k)));
    if (store === STORES.books) for (const b of values as { kind?: string }[]) b.kind === "notebook" ? notebooks++ : books++;
    await w.addBytes(`db/${store}.json`, new TextEncoder().encode(JSON.stringify(records, encode)));
    opts.onProgress?.({ phase: "db", done: DB_STORES.indexOf(store) + 1, total: DB_STORES.length });
  }
  for (let i = 0; i < blobs.length; i++) await w.addBlob(`blob/${i}`, blobs[i]);
  // the files
  const libraryFiles: Record<string, number> = {};
  const names = await opts.files.list();
  const sizes = new Map<string, Blob>();
  for (const n of names) {
    const f = await opts.files.read(n);
    libraryFiles[n] = f.size;
    sizes.set(n, f);
  }
  const take = opts.only ?? (opts.kind === "notes" ? [] : names.filter((n) => opts.kind === "full" || opts.log.files[n] !== libraryFiles[n]));
  const total = take.reduce((s, n) => s + libraryFiles[n], 0);
  let done = 0;
  for (const n of take) {
    await w.addBlob(`file/${n}`, sizes.get(n)!, (k) => opts.onProgress?.({ phase: "files", done: (done += k), total }));
  }
  opts.onProgress?.({ phase: "finish", done: 1, total: 1 });
  const manifest = { format: 1 as const, id, kind: opts.kind, createdAt: Date.now(), app: opts.app, books, notebooks, files: take, libraryFiles, stores: DB_STORES, ...(opts.part ? { part: opts.part } : {}) };
  const blob = await w.finish(manifest);
  // a full backup starts the record afresh (its later parts add to it)
  const fresh = opts.kind === "full" && (opts.part?.n ?? 1) === 1;
  const files = fresh ? {} : { ...opts.log.files };
  const where: Record<string, string> = fresh ? {} : { ...(opts.log.names ?? {}) };
  for (const n of take) {
    files[n] = libraryFiles[n];
    if (opts.fileName) where[n] = opts.fileName;
  }
  const log: BackupLog = { last: { id, at: manifest.createdAt, kind: opts.kind, size: blob.size, locked: !!opts.password }, files, names: where };
  return { blob, manifest: { ...manifest, entries: [] }, log };
}

/** The files a backup of this kind would carry, with their sizes. */
export async function filesToBackUp(kind: BackupKind, files: FileStore, log: BackupLog): Promise<{ name: string; size: number }[]> {
  if (kind === "notes") return [];
  const out: { name: string; size: number }[] = [];
  for (const name of await files.list()) {
    const size = (await files.read(name)).size;
    if (kind === "full" || log.files[name] !== size) out.push({ name, size });
  }
  return out;
}

/** Splits files into parts of at most `limit` bytes (a bigger single file gets a part of its own). */
export function splitParts(list: { name: string; size: number }[], limit: number): string[][] {
  const parts: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const f of list) {
    if (cur.length && bytes + f.size > limit) {
      parts.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f.name);
    bytes += f.size;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts;
}

/** What has changed since the last backup (for "Sao lưu phần mới"). */
export async function pendingSinceLastBackup(files: FileStore, log: BackupLog): Promise<{ files: number; bytes: number }> {
  let n = 0;
  let bytes = 0;
  for (const name of await files.list()) {
    const size = (await files.read(name)).size;
    if (log.files[name] !== size) {
      n++;
      bytes += size;
    }
  }
  return { files: n, bytes };
}

// ------------------------------------------------------------------ restoring

export interface RestorePlan {
  /** The backup whose database is restored (the newest). */
  base: OpenedBackup;
  /** Parts of a split backup that were not chosen (e.g. "2/3"). */
  partsMissing: string[];
  books: number;
  notebooks: number;
  createdAt: number;
  /** Where each file needed comes from. */
  files: Map<string, { from: OpenedBackup; entry: EntryInfo }>;
  /** Files no chosen backup has but this device already holds, unchanged: they stay. */
  keep: string[];
  /** Files the restored books need that neither the backups nor this device have. */
  missing: string[];
}

/** `local`: the files on this device now (name → size), so a notes or "new" backup can lean on them. */
export function planRestore(backups: OpenedBackup[], local: Record<string, number> = {}): RestorePlan {
  if (!backups.length) throw new BackupError("Chưa chọn bản sao lưu nào.");
  const sorted = [...backups].sort((a, b) => Number(b.manifest.createdAt) - Number(a.manifest.createdAt));
  const base = sorted[0];
  const m = base.manifest as unknown as Manifest;
  const files = new Map<string, { from: OpenedBackup; entry: EntryInfo }>();
  for (const b of sorted) {
    for (const e of b.manifest.entries) {
      if (!e.name.startsWith("file/")) continue;
      const n = e.name.slice(5);
      if (!files.has(n)) files.set(n, { from: b, entry: e });
    }
  }
  const need = Object.entries(m.libraryFiles ?? {}).filter(([n]) => !files.has(n));
  const keep = need.filter(([n, size]) => local[n] === size).map(([n]) => n);
  const missing = need.filter(([n, size]) => local[n] !== size).map(([n]) => n);
  // parts of split backups: which of each set were chosen
  const sets = new Map<string, { of: number; have: Set<number> }>();
  for (const b of backups) {
    const p = (b.manifest as unknown as Manifest).part;
    if (!p) continue;
    const s = sets.get(p.set) ?? { of: p.of, have: new Set<number>() };
    s.have.add(p.n);
    sets.set(p.set, s);
  }
  const partsMissing: string[] = [];
  for (const s of sets.values()) for (let n = 1; n <= s.of; n++) if (!s.have.has(n)) partsMissing.push(`${n}/${s.of}`);
  return { base, books: m.books, notebooks: m.notebooks, createdAt: m.createdAt, files, keep, missing, partsMissing };
}

/** The books in a backup's database (for the confirmation). */
export async function readDb(b: OpenedBackup): Promise<Map<string, unknown[]>> {
  const blobEntries = b.manifest.entries.filter((e) => e.name.startsWith("blob/"));
  const blobs: Blob[] = [];
  for (const e of blobEntries) {
    const i = Number(e.name.slice(5));
    blobs[i] = b.slice(e) ?? new Blob([(await b.bytes(e)) as BlobPart]);
  }
  const revive = (_k: string, v: unknown) => {
    if (v && typeof v === "object") {
      const o = v as { $u8?: string; $blob?: number; type?: string };
      if (typeof o.$u8 === "string") return unb64(o.$u8);
      if (typeof o.$blob === "number") {
        const bl = blobs[o.$blob];
        return bl ? (o.type ? new Blob([bl], { type: o.type }) : bl) : new Blob([]);
      }
    }
    return v;
  };
  const out = new Map<string, unknown[]>();
  for (const e of b.manifest.entries) {
    if (!e.name.startsWith("db/")) continue;
    const store = e.name.slice(3, -5);
    out.set(store, JSON.parse(new TextDecoder().decode(await b.bytes(e)), revive) as unknown[]);
  }
  return out;
}

/**
 * Replaces the library with the plan. Files are written first (the old
 * database still stands if that fails); the database is swapped in one
 * transaction; files the restored library does not use are removed last.
 */
export async function applyRestore(
  plan: RestorePlan,
  files: FileStore,
  onProgress?: (done: number, total: number) => void,
): Promise<BackupLog> {
  const db = await readDb(plan.base);
  const total = [...plan.files.values()].reduce((s, f) => s + f.entry.size, 0);
  let done = 0;
  for (const [name, { from, entry }] of plan.files) {
    const slice = from.slice(entry);
    if (slice) {
      await files.write(name, slice);
      done += entry.size;
      onProgress?.(done, total);
    } else {
      await files.writeChunks(
        name,
        from.read(entry, (n) => onProgress?.((done += n), total)),
      );
    }
  }
  // the database in one transaction: all of it or none of it
  const idb = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = idb.transaction(DB_STORES, "readwrite");
    let failure: unknown = null;
    for (const store of DB_STORES) {
      const s = t.objectStore(store);
      const keep: [IDBValidKey, unknown][] = [];
      if (store === STORES.settings) {
        // this device's own notes survive a restore
        const r = s.getAll();
        const k = s.getAllKeys();
        k.onsuccess = () => {
          k.result.forEach((key, i) => LOCAL_SETTINGS.has(String(key)) && keep.push([key, r.result[i]]));
        };
      }
      s.clear().onsuccess = () => {
        try {
          for (const rec of db.get(store) ?? []) {
            if (OUT_OF_LINE.has(store)) {
              const [k, v] = rec as [IDBValidKey, unknown];
              s.put(v, k);
            } else s.put(rec);
          }
          for (const [k, v] of keep) s.put(v, k);
        } catch (e) {
          failure = e;
          t.abort();
        }
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(failure ?? t.error ?? new BackupError("Khôi phục cơ sở dữ liệu bị hủy."));
  });
  const wanted = new Set([...plan.files.keys(), ...plan.keep]);
  for (const n of await files.list()) if (!wanted.has(n)) await files.delete(n);
  // every restored file is in a backup already
  const log: BackupLog = { last: null, files: {} };
  for (const [n, f] of plan.files) log.files[n] = f.entry.size;
  return log;
}
