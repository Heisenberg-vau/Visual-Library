import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../../src/core/storage/FileStore";
import { MetaStore } from "../../src/core/storage/MetaStore";
import { LibraryService, type DocInspector } from "../../src/core/storage/LibraryService";
import { STORES, resetDbForTests, tx } from "../../src/core/storage/idb";
import { coldCandidates, findDuplicates, removeOrphans } from "../../src/core/storage/cleanup";
import { checkIntegrity, integrityProblems, measureLibrary } from "../../src/core/storage/StorageReport";
import { UserFacingError, type BookMeta } from "../../src/core/types";

const pdf = (name: string, body = "%PDF-1.7 hello") => new File([body], name, { type: "application/pdf" });
const fp = async (f: Blob) => {
  const t = await f.text();
  return "fp-" + t.length + t.slice(-3);
};
const inspector: DocInspector = {
  accepts: async (f) => ((await f.text()).startsWith("%PDF-") ? "pdf" : null) as never,
  inspect: async (f) => ({ pageCount: 12, fingerprint: await fp(f), title: null, cover: null }),
};

describe("trash, cold storage, tidying (v2.3)", () => {
  let svc: LibraryService;
  let files: MemoryFileStore;
  let meta: MetaStore;
  const add = async (name: string, body?: string) => {
    const [r] = await svc.importFiles([pdf(name, body)]);
    if (r.status !== "added") throw new Error(r.status);
    return r.book;
  };

  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase("visual-library");
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
    files = new MemoryFileStore();
    meta = new MetaStore();
    svc = new LibraryService(meta, files, inspector);
  });

  it("the trash keeps a book 30 days, then it goes for good", async () => {
    const a = await add("a.pdf", "%PDF-a");
    const b = await add("b.pdf", "%PDF-bb");
    await svc.delete(a.id);
    await svc.delete(b.id);
    await meta.update(a.id, { trashedAt: Date.now() - 31 * 86_400_000 });
    expect(await svc.purgeTrash()).toBe(1);
    expect((await svc.listAll()).map((x) => x.id)).toEqual([b.id]);
    await expect(files.read(a.id)).rejects.toThrow();
    await svc.untrash(b.id);
    const back = await svc.get(b.id);
    expect(back && "trashedAt" in back).toBe(false); // the field is gone, not left as undefined
    expect((await svc.list()).map((x) => x.id)).toEqual([b.id]);
  });

  it("importing a trashed book again brings the same book back (notes and all)", async () => {
    const a = await add("a.pdf");
    await svc.savePosition(a.id, 9, 1);
    await svc.delete(a.id);
    const [r] = await svc.importFiles([pdf("again.pdf")]);
    expect(r).toMatchObject({ status: "returned", from: "trash" });
    const list = await svc.list();
    expect(list.map((x) => [x.id, x.lastPage])).toEqual([[a.id, 9]]);
    expect(await files.list()).toEqual([a.id]);
  });

  it("cold storage removes the file only; the original file or re-import brings it back", async () => {
    const a = await add("a.pdf", "%PDF-cold book");
    await svc.savePosition(a.id, 5, 1);
    await svc.freeze(a.id, "visual-library-x.vlbak");
    expect(await files.list()).toEqual([]);
    const cold = await svc.get(a.id);
    expect(cold?.cold?.backup).toBe("visual-library-x.vlbak");
    expect((await svc.list()).length).toBe(1); // still on its shelf
    // the integrity check does not count it as a missing file
    const rep = await checkIntegrity(meta, files);
    expect(integrityProblems(rep)).toBe(0);
    expect((await measureLibrary(meta, files)).books[0]).toMatchObject({ cold: true, missing: false, file: 0 });
    // a different file is refused
    await expect(svc.thaw(a.id, pdf("other.pdf", "%PDF-another"), fp)).rejects.toBeInstanceOf(UserFacingError);
    await expect(svc.thaw(a.id, new File(["x"], "a.docx"), fp)).rejects.toThrow(/PDF gốc/);
    expect(await files.list()).toEqual([]);
    // the right one is accepted
    await svc.thaw(a.id, pdf("a (1).pdf", "%PDF-cold book"), fp);
    expect(await (await files.read(a.id)).text()).toBe("%PDF-cold book");
    expect((await svc.get(a.id))?.cold).toBeUndefined();
    expect((await svc.get(a.id))?.lastPage).toBe(5);
    // and importing the original again also thaws
    await svc.freeze(a.id);
    const [r] = await svc.importFiles([pdf("copy.pdf", "%PDF-cold book")]);
    expect(r).toMatchObject({ status: "returned", from: "cold" });
    expect(await files.list()).toEqual([a.id]);
  });

  it("removes only what belongs to no book", async () => {
    const a = await add("a.pdf", "%PDF-a");
    const t = await add("t.pdf", "%PDF-tt");
    await svc.delete(t.id); // trash still counts as a book
    await files.write("stray", new Blob(["zzz"]));
    await tx(STORES.ink, "readwrite", (s) => s.put({ key: "ghost:1", bookId: "ghost", page: 1, strokes: [] }));
    await tx(STORES.ink, "readwrite", (s) => s.put({ key: `${a.id}:1`, bookId: a.id, page: 1, strokes: [] }));
    await tx(STORES.covers, "readwrite", (s) => s.put(new Blob(["c"]), "ghost"));
    expect(await removeOrphans(meta, files)).toEqual({ files: 1, records: 2 });
    expect((await files.list()).sort()).toEqual([a.id, t.id].sort());
    expect(await tx(STORES.ink, "readonly", (s) => s.count())).toBe(1);
  });

  it("after an interruption: stray files go, a finished thaw counts, a half one is undone", async () => {
    const a = await add("a.pdf", "%PDF-aaaa");
    const b = await add("b.pdf", "%PDF-bbbbbb");
    const c = await add("c.pdf", "%PDF-cc");
    await svc.freeze(a.id);
    await svc.freeze(b.id);
    await files.write(a.id, new Blob(["%PDF-aaaa"])); // thaw wrote the file, then the app closed
    await files.write(b.id, new Blob([])); // thaw had only created the file
    await files.write("import-in-progress", new Blob(["half"])); // an import stopped before its record
    const r = await svc.repairOnStart();
    expect(r.thawed).toEqual([a.id]);
    expect(r.removed.sort()).toEqual([b.id, "import-in-progress"].sort());
    expect((await svc.get(a.id))?.cold).toBeUndefined();
    expect((await svc.get(b.id))?.cold).toBeTruthy();
    expect((await files.list()).sort()).toEqual([a.id, c.id].sort());
  });

  it("finds duplicates and books to put away", () => {
    const now = Date.now();
    const b = (id: string, over: Partial<BookMeta>): BookMeta =>
      ({ id, kind: "pdf", title: id, fileName: "", size: 100, pageCount: 10, fingerprint: id, addedAt: now, lastOpenedAt: null, lastPage: 1, zoom: 1, categoryId: null, tags: [], margins: { left: 0, right: 0 }, favorite: false, bookmarks: [], ...over }) as BookMeta;
    const list = [
      b("old", { fingerprint: "F", addedAt: 1, size: 5 }),
      b("new", { fingerprint: "F", addedAt: 2, size: 5 }),
      b("x", { size: 777, pageCount: 3, addedAt: 1 }),
      b("y", { size: 777, pageCount: 3, addedAt: 2 }),
      b("gone", { fingerprint: "F", trashedAt: 1 }),
    ];
    const g = findDuplicates(list);
    expect(g.map((x) => [x.reason, x.books.map((y) => y.id)])).toEqual([
      ["same", ["old", "new"]],
      ["likely", ["x", "y"]],
    ]);
    const idle = [
      b("big", { size: 900, lastOpenedAt: now - 90 * 86_400_000 }),
      b("small", { size: 10, lastOpenedAt: now - 90 * 86_400_000 }),
      b("recent", { size: 5000, lastOpenedAt: now - 3 * 86_400_000 }),
      b("frozen", { size: 5000, lastOpenedAt: 0, cold: { at: 1 } }),
    ];
    expect(coldCandidates(idle, now).map((x) => x.id)).toEqual(["big", "small"]);
  });
});
