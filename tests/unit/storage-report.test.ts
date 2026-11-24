import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { MetaStore } from "../../src/core/storage/MetaStore";
import { MemoryFileStore } from "../../src/core/storage/FileStore";
import { LibraryService, type DocInspector } from "../../src/core/storage/LibraryService";
import { STORES, resetDbForTests, tx } from "../../src/core/storage/idb";
import { approxBytes, checkIntegrity, formatBytes, integrityProblems, measureLibrary } from "../../src/core/storage/StorageReport";
import { fileFingerprint } from "../../src/core/util/fingerprint";

describe("storage report and integrity check (v2.0)", () => {
  let meta: MetaStore;
  let files: MemoryFileStore;
  let svc: LibraryService;
  const inspector: DocInspector = {
    accepts: async () => "pdf",
    inspect: async (f) => ({ pageCount: 3, fingerprint: await fileFingerprint(f), title: null, cover: new Blob(["c".repeat(100)]) }),
  };
  const pdf = (name: string, n: number) => new File(["%PDF-" + "x".repeat(n)], name, { type: "application/pdf" });

  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase("visual-library");
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
    meta = new MetaStore();
    files = new MemoryFileStore();
    svc = new LibraryService(meta, files, inspector);
  });

  it("measures each book's file, cover, notes and search text; biggest first", async () => {
    const [a, b] = await svc.importFiles([pdf("a.pdf", 50000), pdf("b.pdf", 200)]);
    if (a.status !== "added" || b.status !== "added") throw new Error("import");
    await tx(STORES.ink, "readwrite", (s) => s.put({ key: `${b.book.id}:0`, bookId: b.book.id, page: 0, strokes: [{ tool: "pen", points: new Array(1000).fill(1) }] }));
    await tx(STORES.pageText, "readwrite", (s) => s.put({ key: `${a.book.id}:0`, bookId: a.book.id, page: 0, words: "turbine ".repeat(50) }));
    const u = await measureLibrary(meta, files);
    expect(u.books.map((x) => x.title)).toEqual(["a", "b"]);
    const [ua, ub] = u.books;
    expect(ua.file).toBe(50005);
    expect(ua.cover).toBe(100);
    expect(ua.text).toBeGreaterThan(400);
    expect(ub.notes).toBeGreaterThan(8000);
    expect(u.orphans).toBe(0);
    expect(u.total).toBeGreaterThanOrEqual(ua.total + ub.total);
  });

  it("a healthy library has no problems", async () => {
    await svc.importFiles([pdf("a.pdf", 3000)]);
    const r = await checkIntegrity(meta, files, { deep: true });
    expect(integrityProblems(r)).toBe(0);
  });

  it("finds missing files, stray files, notes of deleted books and damaged files", async () => {
    const [a, b, c] = await svc.importFiles([pdf("a.pdf", 3_000_000), pdf("b.pdf", 300), pdf("c.pdf", 400)]);
    if (a.status !== "added" || b.status !== "added" || c.status !== "added") throw new Error("import");
    await files.delete(b.book.id); // b lost its file
    await files.write("stray-file", new Blob(["zzz"])); // a file no book owns
    await tx(STORES.ink, "readwrite", (s) => s.put({ key: "gone:0", bookId: "gone", page: 0, strokes: [] })); // notes of a deleted book
    // a's middle is intact but its end changed (same size): only the deep check sees it
    const f = await files.read(a.book.id);
    const bytes = new Uint8Array(await f.arrayBuffer());
    bytes[bytes.length - 10] ^= 0xff;
    await files.write(a.book.id, new Blob([bytes]));
    // c changed size: even the quick check sees it
    await files.write(c.book.id, new Blob(["%PDF-short"]));
    const quick = await checkIntegrity(meta, files);
    expect(quick.missingFiles.map((x) => x.title)).toEqual(["b"]);
    expect(quick.orphanFiles.map((x) => x.name)).toEqual(["stray-file"]);
    expect(quick.orphanRecords).toEqual([{ store: "Ghi chú, nét bút", count: 1, bytes: expect.any(Number) }]);
    expect(quick.damaged.map((x) => x.title)).toEqual(["c"]);
    const deep = await checkIntegrity(meta, files, { deep: true });
    expect(deep.damaged.map((x) => x.title).sort()).toEqual(["a", "c"]);
  });

  it("formats sizes the Vietnamese way", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10 GB");
    expect(approxBytes(new Uint8Array(64))).toBe(64);
  });
});
