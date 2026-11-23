import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildTree, cleanTag, countBooks, flatten, matchesQuery, mergeTags, pathOf, subtreeIds, tagCounts,
} from "../../src/core/library/shelves";
import { MemoryFileStore } from "../../src/core/storage/FileStore";
import { LibraryService, type DocInspector } from "../../src/core/storage/LibraryService";
import { MetaStore } from "../../src/core/storage/MetaStore";
import { DB_NAME, resetDbForTests } from "../../src/core/storage/idb";
import type { BookMeta, Category } from "../../src/core/types";

const cat = (id: string, name: string, parentId: string | null = null): Category => ({ id, name, parentId, createdAt: 0 });
const book = (id: string, categoryId: string | null, tags: string[] = [], title = id): BookMeta => ({
  id, kind: "pdf", title, fileName: `${title}.pdf`, size: 1, pageCount: 1, fingerprint: id,
  addedAt: 0, lastOpenedAt: null, lastPage: 1, zoom: 1, categoryId, tags,
});

const cats = [
  cat("air", "Hàng không"),
  cat("eng", "Động cơ", "air"),
  cat("aero", "Khí động", "air"),
  cat("gt", "Tuabin khí", "eng"),
  cat("zh", "Tiếng Trung"),
];

describe("shelf tree", () => {
  it("builds a sorted tree (Vietnamese collation)", () => {
    const names = flatten(buildTree(cats)).map((n) => `${"-".repeat(n.depth)}${n.category.name}`);
    expect(names).toEqual(["Hàng không", "-Động cơ", "--Tuabin khí", "-Khí động", "Tiếng Trung"]);
  });

  it("puts orphans at the root and survives cycles", () => {
    const weird = [cat("a", "A", "b"), cat("b", "B", "a"), cat("o", "Orphan", "missing")];
    const flat = flatten(buildTree(weird)).map((n) => n.category.id);
    expect(flat).toContain("o");
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("computes subtrees, paths and counts including sub-shelves", () => {
    expect([...subtreeIds(cats, "air")].sort()).toEqual(["aero", "air", "eng", "gt"]);
    expect(pathOf(cats, "gt").map((c) => c.name)).toEqual(["Hàng không", "Động cơ", "Tuabin khí"]);
    const counts = countBooks(cats, [book("1", "gt"), book("2", "eng"), book("3", "zh"), book("4", null)]);
    expect(counts.get("air")).toBe(2);
    expect(counts.get("eng")).toBe(2);
    expect(counts.get("aero")).toBe(0);
    expect(counts.get("zh")).toBe(1);
  });
});

describe("tags and search", () => {
  it("cleans and merges tags case-insensitively", () => {
    expect(cleanTag("  #M15   Gas  ")).toBe("M15 Gas");
    expect(mergeTags(["M15"], ["m15", "ATA 72", "", "#ATA 72"])).toEqual(["M15", "ATA 72"]);
  });

  it("counts tags", () => {
    expect(tagCounts([book("1", null, ["M15", "ATA"]), book("2", null, ["m15"])])).toEqual([
      { tag: "M15", count: 2 },
      { tag: "ATA", count: 1 },
    ]);
  });

  it("searches without diacritics, by title or #tag", () => {
    const b = book("1", null, ["Động cơ"], "Rolls Royce Đường dẫn khí");
    expect(matchesQuery(b, "duong dan")).toBe(true);
    expect(matchesQuery(b, "#dong")).toBe(true);
    expect(matchesQuery(b, "rolls khi")).toBe(true);
    expect(matchesQuery(b, "boeing")).toBe(false);
  });
});

describe("LibraryService shelves", () => {
  let svc: LibraryService;
  let meta: MetaStore;
  const inspector: DocInspector = {
    accepts: async () => true,
    inspect: async (f) => ({ pageCount: 1, fingerprint: await f.text(), title: null, cover: null }),
  };
  const file = (name: string) => new File([name], `${name}.pdf`);

  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
    meta = new MetaStore();
    svc = new LibraryService(meta, new MemoryFileStore(), inspector);
  });

  it("imports onto the selected shelf", async () => {
    const air = await svc.createCategory("Hàng không", null);
    const [r] = await svc.importFiles([file("a")], undefined, air.id);
    expect(r.status === "added" && r.book.categoryId).toBe(air.id);
  });

  it("rejects empty and duplicate sibling names, allows same name elsewhere", async () => {
    const air = await svc.createCategory("Hàng không", null);
    await expect(svc.createCategory("  ", null)).rejects.toThrow("trống");
    await expect(svc.createCategory("hàng KHÔNG", null)).rejects.toThrow("Đã có");
    await svc.createCategory("Động cơ", air.id);
    await expect(svc.createCategory("Động cơ", null)).resolves.toBeTruthy();
  });

  it("deleting a shelf keeps its books and sub-shelves (moved up)", async () => {
    const air = await svc.createCategory("Hàng không", null);
    const eng = await svc.createCategory("Động cơ", air.id);
    const gt = await svc.createCategory("Tuabin khí", eng.id);
    await svc.importFiles([file("a"), file("b")], undefined, eng.id);
    await svc.deleteCategory(eng.id);
    const cs = await svc.listCategories();
    expect(cs.find((c) => c.id === eng.id)).toBeUndefined();
    expect(cs.find((c) => c.id === gt.id)?.parentId).toBe(air.id);
    const books = await svc.list();
    expect(books).toHaveLength(2);
    expect(books.every((b) => b.categoryId === air.id)).toBe(true);
  });

  it("will not move a shelf inside itself", async () => {
    const a = await svc.createCategory("A", null);
    const b = await svc.createCategory("B", a.id);
    await expect(svc.moveCategory(a.id, b.id)).rejects.toThrow("chính nó");
    await svc.moveCategory(b.id, null);
    expect((await svc.listCategories()).find((c) => c.id === b.id)?.parentId).toBeNull();
  });

  it("moves several books and manages tags in bulk", async () => {
    const zh = await svc.createCategory("Tiếng Trung", null);
    const rs = await svc.importFiles([file("a"), file("b"), file("c")]);
    const ids = rs.flatMap((r) => (r.status === "added" ? [r.book.id] : []));
    await svc.moveBooks(ids.slice(0, 2), zh.id);
    await svc.addTags(ids, ["HSK 3", "hsk 3", "Từ vựng"]);
    await svc.removeTag([ids[0]], "từ vựng");
    await svc.renameTag("HSK 3", "HSK3");
    const books = await svc.list();
    const byId = new Map(books.map((b) => [b.id, b]));
    expect(byId.get(ids[0])).toMatchObject({ categoryId: zh.id, tags: ["HSK3"] });
    expect(byId.get(ids[2])).toMatchObject({ categoryId: null, tags: ["Từ vựng", "HSK3"] });
  });

  it("upgrades v0.1.0 records (no categoryId/tags) without losing them", async () => {
    const old = { ...book("old", null) } as Partial<BookMeta>;
    delete old.categoryId;
    delete old.tags;
    await meta.put(old as BookMeta);
    const [b] = await svc.list();
    expect(b).toMatchObject({ id: "old", categoryId: null, tags: [] });
  });
});
