/** Minimal promise wrapper over IndexedDB (no dependency). */

export const DB_NAME = "visual-library";
export const DB_VERSION = 1;

export const STORES = {
  books: "books", // BookMeta, keyPath id
  covers: "covers", // Blob keyed by book id
  blobs: "blobs", // original files when OPFS is unavailable
  settings: "settings", // key/value
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Future versions add stores here (annotations in milestone 2) using
      // `if (!db.objectStoreNames.contains(...))`, never by dropping data.
      if (!db.objectStoreNames.contains(STORES.books)) {
        const s = db.createObjectStore(STORES.books, { keyPath: "id" });
        s.createIndex("fingerprint", "fingerprint", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.covers)) db.createObjectStore(STORES.covers);
      if (!db.objectStoreNames.contains(STORES.blobs)) db.createObjectStore(STORES.blobs);
      if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** For tests: forget the cached connection. */
export async function resetDbForTests(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) (await p.catch(() => null))?.close();
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let result: T;
    r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? r.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
  });
}
