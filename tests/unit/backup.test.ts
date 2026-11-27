import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFileStore } from "../../src/core/storage/FileStore";
import { STORES, resetDbForTests, tx } from "../../src/core/storage/idb";
import { applyRestore, makeBackup, pendingSinceLastBackup, planRestore, type BackupLog } from "../../src/core/backup/backup";
import { openBackup, verifyBackup } from "../../src/core/backup/container";

const put = (store: string, v: unknown, key?: IDBValidKey) => tx(store, "readwrite", (s) => (key === undefined ? s.put(v) : s.put(v, key)));
const all = (store: string) => tx<unknown[]>(store, "readonly", (s) => s.getAll());
const get = (store: string, key: IDBValidKey) => tx<unknown>(store, "readonly", (s) => s.get(key));
const text = async (b: Blob) => new TextDecoder().decode(await b.arrayBuffer());
const empty: BackupLog = { last: null, files: {} };

async function library(files: MemoryFileStore) {
  await put(STORES.books, { id: "b1", title: "ATA 72", kind: "pdf", lastPage: 12 });
  await put(STORES.books, { id: "n1", title: "Vở ghi", kind: "notebook" });
  await put(STORES.covers, new Blob(["cover-png"], { type: "image/png" }), "b1");
  await put(STORES.ink, { key: "b1:3", bookId: "b1", page: 3, strokes: [{ pts: new Uint8Array([1, 2, 250]) }] });
  await put(STORES.tasks, { id: "t1", title: "Ôn chương 3" });
  await put(STORES.settings, { a: 1 }, "theme");
  await put(STORES.settings, { here: true }, "diagMarker");
  await files.write("b1", new Blob(["PDF-ONE"]));
  await files.write("b1.orig", new Blob(["DOCX-ONE"]));
}

describe("backup and restore", () => {
  beforeEach(async () => {
    await resetDbForTests();
    for (const store of Object.values(STORES)) await tx(store, "readwrite", (s) => s.clear());
  });

  for (const password of [undefined, "mk"]) {
    it(`${password ? "locked" : "plain"}: a full backup brings everything back, byte for byte`, async () => {
      const files = new MemoryFileStore();
      await library(files);
      const { blob, log } = await makeBackup({ kind: "full", files, log: empty, app: "t", password, iterations: 1000 });
      expect(log.files).toEqual({ b1: 7, "b1.orig": 8 });

      // the library changes after the backup…
      await put(STORES.books, { id: "b2", title: "Mới" });
      await put(STORES.tasks, { id: "t1", title: "đã sửa" });
      await files.write("b2", new Blob(["X"]));
      await files.delete("b1.orig");
      await put(STORES.settings, { here: "this device" }, "diagMarker");

      const b = await openBackup(blob, password);
      expect(await verifyBackup(b)).toEqual([]);
      const plan = planRestore([b]);
      expect(plan.books).toBe(1);
      expect(plan.notebooks).toBe(1);
      expect(plan.missing).toEqual([]);
      await applyRestore(plan, files);

      expect(((await all(STORES.books)) as { id: string }[]).map((x) => x.id).sort()).toEqual(["b1", "n1"]);
      expect(await get(STORES.tasks, "t1")).toEqual({ id: "t1", title: "Ôn chương 3" });
      const ink = (await get(STORES.ink, "b1:3")) as { strokes: { pts: Uint8Array }[] };
      expect([...ink.strokes[0].pts]).toEqual([1, 2, 250]);
      const cover = (await get(STORES.covers, "b1")) as Blob;
      expect(await text(cover)).toBe("cover-png");
      expect(cover.type).toBe("image/png");
      expect(await get(STORES.settings, "theme")).toEqual({ a: 1 });
      // this device's own notes are not overwritten by another moment's
      expect(await get(STORES.settings, "diagMarker")).toEqual({ here: "this device" });
      expect((await files.list()).sort()).toEqual(["b1", "b1.orig"]);
      expect(await text(await files.read("b1.orig"))).toBe("DOCX-ONE");
    });
  }

  it("a 'new parts' backup carries only new files; together with the full one it restores all", async () => {
    const files = new MemoryFileStore();
    await library(files);
    const first = await makeBackup({ kind: "full", files, log: empty, app: "t" });
    expect(await pendingSinceLastBackup(files, first.log)).toEqual({ files: 0, bytes: 0 });
    await put(STORES.books, { id: "b2", title: "Sách 2", kind: "pdf" });
    await files.write("b2", new Blob(["PDF-TWO!"]));
    expect(await pendingSinceLastBackup(files, first.log)).toEqual({ files: 1, bytes: 8 });
    const second = await makeBackup({ kind: "new", files, log: first.log, app: "t" });
    const b2 = await openBackup(second.blob);
    expect(b2.manifest.entries.filter((e) => e.name.startsWith("file/")).map((e) => e.name)).toEqual(["file/b2"]);
    expect(second.log.files).toEqual({ b1: 7, "b1.orig": 8, b2: 8 });

    // alone, the new backup says what it lacks
    expect(planRestore([b2]).missing.sort()).toEqual(["b1", "b1.orig"]);
    // with the full one: everything, database from the newest
    await files.delete("b1");
    const plan = planRestore([await openBackup(first.blob), b2]);
    expect(plan.missing).toEqual([]);
    expect(plan.books).toBe(2);
    await applyRestore(plan, files);
    expect((await files.list()).sort()).toEqual(["b1", "b1.orig", "b2"]);
    expect(await text(await files.read("b1"))).toBe("PDF-ONE");
  });

  it("a notes backup has no files and is small", async () => {
    const files = new MemoryFileStore();
    await library(files);
    await files.write("big", new Blob([new Uint8Array(2_000_000)]));
    const { blob } = await makeBackup({ kind: "notes", files, log: empty, app: "t" });
    expect(blob.size).toBeLessThan(10_000);
    const b = await openBackup(blob);
    expect(b.manifest.entries.some((e) => e.name.startsWith("file/"))).toBe(false);
    // on the same device the files are already there: notes come back, files stay
    await put(STORES.tasks, { id: "t1", title: "đã sửa" });
    const local = { b1: 7, "b1.orig": 8, big: 2_000_000 };
    const plan = planRestore([b], local);
    expect(plan.missing).toEqual([]);
    expect(plan.keep.sort()).toEqual(["b1", "b1.orig", "big"]);
    await applyRestore(plan, files);
    expect(await get(STORES.tasks, "t1")).toEqual({ id: "t1", title: "Ôn chương 3" });
    expect((await files.list()).sort()).toEqual(["b1", "b1.orig", "big"]);
    // on another device they are not: refused by the caller via `missing`
    expect(planRestore([b], { b1: 7 }).missing.sort()).toEqual(["b1.orig", "big"]);
  });
});
