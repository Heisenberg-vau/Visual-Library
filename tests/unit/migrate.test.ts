import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { DB_NAME, DB_VERSION, STORES, openDb, resetDbForTests } from "../../src/core/storage/idb";
import { MetaStore } from "../../src/core/storage/MetaStore";

/*
 * Every database version the app ever shipped must open in today's app with
 * nothing lost. Each case builds the database exactly as that version left it,
 * with data in it, then opens it the way the app does.
 */

type Builder = (db: IDBDatabase) => void;
const STAGES: Builder[] = [
  // v1: books, covers, original files, settings
  (db) => {
    db.createObjectStore("books", { keyPath: "id" }).createIndex("fingerprint", "fingerprint", { unique: false });
    db.createObjectStore("covers");
    db.createObjectStore("blobs");
    db.createObjectStore("settings");
  },
  (db) => db.createObjectStore("categories", { keyPath: "id" }), // v2 shelves
  (db) => db.createObjectStore("ink", { keyPath: "key" }).createIndex("bookId", "bookId", { unique: false }), // v3
  (db) => {
    db.createObjectStore("tasks", { keyPath: "id" }); // v4 planner
    db.createObjectStore("study", { keyPath: "date" });
  },
  (db) => {
    db.createObjectStore("reading", { keyPath: "bookId" }); // v5 progress
    db.createObjectStore("readingDays", { keyPath: "date" });
  },
];

function buildOld(version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      for (let v = 0; v < version; v++) STAGES[v](req.result);
    };
    req.onsuccess = () => {
      const db = req.result;
      const names = [...db.objectStoreNames];
      const t = db.transaction(names, "readwrite");
      t.objectStore("books").put({ id: "old", kind: "pdf", title: `Sách từ CSDL v${version}`, fileName: "a.pdf", size: 10, pageCount: 5, fingerprint: "fp", addedAt: 1, lastOpenedAt: 2, lastPage: 3, zoom: 1 });
      t.objectStore("covers").put(new Blob(["cover"]), "old");
      t.objectStore("settings").put({ x: 1 }, "someSetting");
      if (names.includes("categories")) t.objectStore("categories").put({ id: "c1", name: "Hàng không", parentId: null, createdAt: 1 });
      if (names.includes("ink")) t.objectStore("ink").put({ key: "old:0", bookId: "old", page: 0, strokes: [{ tool: "pen", points: [1, 2, 3, 4] }] });
      if (names.includes("tasks")) t.objectStore("tasks").put({ id: "t1", title: "Ôn ATA", date: "2026-11-24", done: false, kind: "task" });
      if (names.includes("reading")) t.objectStore("reading").put({ bookId: "old", bits: new Uint8Array([7]), count: 3, updatedAt: 1 });
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

const all = async <T>(db: IDBDatabase, store: string): Promise<T[]> =>
  new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result as T[]);
    r.onerror = () => reject(r.error);
  });

describe("database upgrades keep everything", () => {
  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
  });

  for (let v = 1; v < DB_VERSION; v++) {
    it(`from v${v} to v${DB_VERSION}`, async () => {
      await buildOld(v);
      const db = await openDb();
      expect(db.version).toBe(DB_VERSION);
      for (const s of Object.values(STORES)) expect([...db.objectStoreNames]).toContain(s);
      // the book from the old version, filled in for today's fields
      const [b] = await new MetaStore().list();
      expect(b.title).toBe(`Sách từ CSDL v${v}`);
      expect(b.lastPage).toBe(3);
      expect(b.tags).toEqual([]);
      expect(b.categoryId).toBe(null);
      expect((await all(db, STORES.covers)).length).toBe(1);
      expect(await new MetaStore().getSetting("someSetting", null)).toEqual({ x: 1 });
      if (v >= 2) expect((await all<{ name: string }>(db, STORES.categories))[0].name).toBe("Hàng không");
      if (v >= 3) expect((await all<{ strokes: unknown[] }>(db, STORES.ink))[0].strokes.length).toBe(1);
      if (v >= 4) expect((await all<{ title: string }>(db, STORES.tasks))[0].title).toBe("Ôn ATA");
      if (v >= 5) expect((await all<{ count: number }>(db, STORES.reading))[0].count).toBe(3);
    });
  }
});
