import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { PageLayout } from "../../src/core/util/layout";
import { LruCache } from "../../src/core/util/lru";
import { JobScheduler } from "../../src/core/util/scheduler";
import { MetaStore } from "../../src/core/storage/MetaStore";
import { MemoryFileStore } from "../../src/core/storage/FileStore";
import { LibraryService, titleFromFileName, type DocInspector } from "../../src/core/storage/LibraryService";
import { resetDbForTests } from "../../src/core/storage/idb";
import { UserFacingError } from "../../src/core/types";

describe("PageLayout", () => {
  const sizes = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
    { width: 800, height: 600 }, // landscape
    { width: 600, height: 800 },
  ];
  const layout = new PageLayout(sizes, { gap: 10, availableWidth: 300, zoom: 1 }, 320);

  it("fits the first page to the available width", () => {
    expect(layout.scale).toBeCloseTo(0.5);
    expect(layout.widths[0]).toBeCloseTo(300);
    expect(layout.heights[0]).toBeCloseTo(400);
  });

  it("stacks pages with gaps", () => {
    expect(layout.tops[0]).toBe(10);
    expect(layout.tops[1]).toBe(420);
    expect(layout.tops[2]).toBe(830);
    expect(layout.contentHeight).toBe(10 + 400 + 10 + 400 + 10 + 300 + 10 + 400 + 10);
  });

  it("widens content for wider pages", () => {
    expect(layout.contentWidth).toBe(400 + 20);
  });

  it("finds pages by y with binary search", () => {
    expect(layout.indexAt(0)).toBe(0);
    expect(layout.indexAt(409)).toBe(0);
    expect(layout.indexAt(411)).toBe(1);
    expect(layout.indexAt(1e9)).toBe(3);
    expect(layout.visibleRange(400, 900)).toEqual([0, 2]);
  });

  it("round-trips anchors across zoom changes", () => {
    const a = layout.anchorAt(layout.left(1) + 150, layout.tops[1] + 100);
    expect(a.index).toBe(1);
    expect(a.fx).toBeCloseTo(0.5);
    expect(a.fy).toBeCloseTo(0.25);
    const z2 = new PageLayout(sizes, { gap: 10, availableWidth: 300, zoom: 2 }, 320);
    const p = z2.pointOf(a);
    expect(p.y).toBeCloseTo(z2.tops[1] + 200);
    expect(p.x).toBeCloseTo(z2.left(1) + 300);
  });

  it("handles 10 000 pages quickly", () => {
    const many = Array.from({ length: 10_000 }, () => ({ width: 595, height: 842 }));
    const t = performance.now();
    const l = new PageLayout(many, { gap: 14, availableWidth: 1200, zoom: 1 }, 1228);
    for (let i = 0; i < 1000; i++) l.indexAt(Math.random() * l.contentHeight);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("LruCache", () => {
  it("evicts least recently used and reports it", () => {
    const evicted: number[] = [];
    const c = new LruCache<number, string>(2, (k) => evicted.push(k));
    c.set(1, "a");
    c.set(2, "b");
    c.get(1);
    c.set(3, "c");
    expect(evicted).toEqual([2]);
    expect(c.has(1) && c.has(3)).toBe(true);
  });
});

describe("JobScheduler", () => {
  it("runs by priority and drops cancelled jobs", async () => {
    const s = new JobScheduler(1);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.enqueue({ key: "first", priority: 0, run: () => gate.then(() => void order.push("first")) });
    s.enqueue({ key: "low", priority: 50, run: async () => void order.push("low") });
    s.enqueue({ key: "high", priority: 1, run: async () => void order.push("high") });
    s.enqueue({ key: "gone", priority: 2, run: async () => void order.push("gone") });
    s.cancel("gone");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first", "high", "low"]);
  });

  it("aborts a running job on cancel", async () => {
    const s = new JobScheduler(1);
    let aborted = false;
    s.enqueue({
      key: "x",
      priority: 0,
      run: (signal) =>
        new Promise<void>((r) => signal.addEventListener("abort", () => ((aborted = true), r()))),
    });
    s.cancel("x");
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
  });
});

describe("LibraryService", () => {
  let svc: LibraryService;
  let files: MemoryFileStore;
  const pdf = (name: string, body = "%PDF-1.7 hello") => new File([body], name, { type: "application/pdf" });
  const inspector: DocInspector = {
    accepts: async (f) => (await f.text()).startsWith("%PDF-"),
    inspect: async (f) => {
      const t = await f.text();
      if (t.includes("broken")) throw new UserFacingError("File bị hỏng hoặc không phải PDF hợp lệ.");
      return { pageCount: 12, fingerprint: "fp-" + t.length + t.slice(-3), title: null, cover: null };
    },
  };

  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase("visual-library");
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
    files = new MemoryFileStore();
    svc = new LibraryService(new MetaStore(), files, inspector);
  });

  it("imports, stores the original and lists it", async () => {
    const [r] = await svc.importFiles([pdf("GAS_TURBINE_fundamental.pdf")]);
    expect(r.status).toBe("added");
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("GAS TURBINE fundamental");
    expect(list[0].pageCount).toBe(12);
    expect(await (await svc.readFile(list[0].id)).text()).toBe("%PDF-1.7 hello");
  });

  it("detects duplicates and does not keep a second copy", async () => {
    await svc.importFiles([pdf("a.pdf")]);
    const [r] = await svc.importFiles([pdf("a-copy.pdf")]);
    expect(r.status).toBe("duplicate");
    expect(await svc.list()).toHaveLength(1);
  });

  it("rejects non-PDF files with a readable message", async () => {
    const [r] = await svc.importFiles([new File(["hello"], "note.pdf")]);
    expect(r).toMatchObject({ status: "error", message: "Không phải file PDF." });
  });

  it("cleans up the stored copy when a file is broken", async () => {
    const [r] = await svc.importFiles([pdf("x.pdf", "%PDF-broken")]);
    expect(r.status).toBe("error");
    expect(await svc.list()).toHaveLength(0);
  });

  it("renames, saves position and deletes", async () => {
    const [r] = await svc.importFiles([pdf("b.pdf")]);
    if (r.status !== "added") throw new Error();
    await svc.rename(r.book.id, "  Sách mới  ");
    await svc.savePosition(r.book.id, 7, 1.5);
    const b = await svc.get(r.book.id);
    expect(b).toMatchObject({ title: "Sách mới", lastPage: 7, zoom: 1.5 });
    await svc.delete(r.book.id);
    expect(await svc.list()).toHaveLength(0);
    await expect(files.read(r.book.id)).rejects.toThrow();
  });

  it("derives titles from file names", () => {
    expect(titleFromFileName("Rolls_royce_the_jet_engine.pdf")).toBe("Rolls royce the jet engine");
  });
});

import { fileFingerprint } from "../../src/core/util/fingerprint";
describe("fileFingerprint", () => {
  it("differs for files sharing the same first kilobyte", async () => {
    const head = "%PDF-1.7\n" + "x".repeat(2000);
    const a = await fileFingerprint(new Blob([head + "AAA"]));
    const b = await fileFingerprint(new Blob([head + "BBBB"]));
    const a2 = await fileFingerprint(new Blob([head + "AAA"]));
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
  });
});
