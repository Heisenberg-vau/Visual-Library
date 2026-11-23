/** Minimal promise wrapper over IndexedDB (no dependency). */

export const DB_NAME = "visual-library";
export const DB_VERSION = 6;

export const STORES = {
  books: "books", // BookMeta, keyPath id
  covers: "covers", // Blob keyed by book id
  blobs: "blobs", // original files when OPFS is unavailable
  settings: "settings", // key/value
  categories: "categories", // Category, keyPath id (v2)
  ink: "ink", // PageInk per (book, page), keyPath key, index bookId (v3)
  tasks: "tasks", // Task, keyPath id (v4)
  study: "study", // StudyDay, keyPath date (v4)
  reading: "reading", // BookReading (pages actually read), keyPath bookId (v5)
  readingDays: "readingDays", // pages read per day, keyPath date (v5)
  pageText: "pageText", // searchable words per (book, page), keyPath key, index bookId (v6)
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
      // v2: shelves. Books from v1 get categoryId/tags filled in on read.
      if (!db.objectStoreNames.contains(STORES.categories)) {
        db.createObjectStore(STORES.categories, { keyPath: "id" });
      }
      // v3: handwriting.
      if (!db.objectStoreNames.contains(STORES.ink)) {
        db.createObjectStore(STORES.ink, { keyPath: "key" }).createIndex("bookId", "bookId", { unique: false });
      }
      // v4: study planner and time log.
      if (!db.objectStoreNames.contains(STORES.tasks)) db.createObjectStore(STORES.tasks, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.study)) db.createObjectStore(STORES.study, { keyPath: "date" });
      // v5: real reading progress.
      if (!db.objectStoreNames.contains(STORES.reading)) db.createObjectStore(STORES.reading, { keyPath: "bookId" });
      if (!db.objectStoreNames.contains(STORES.readingDays)) db.createObjectStore(STORES.readingDays, { keyPath: "date" });
      // v6: text index for search, including OCR results.
      if (!db.objectStoreNames.contains(STORES.pageText)) {
        db.createObjectStore(STORES.pageText, { keyPath: "key" }).createIndex("bookId", "bookId", { unique: false });
      }
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

/** Several stores in one transaction (all-or-nothing). */
export async function txMulti(
  stores: string[],
  fn: (get: (name: string) => IDBObjectStore) => void,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, "readwrite");
    fn((name) => t.objectStore(name));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
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
