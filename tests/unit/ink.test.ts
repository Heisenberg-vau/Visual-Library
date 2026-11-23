import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { simplify, snapHorizontal, straighten, strokeHit, strokeHitSegment } from "../../src/core/annotations/geometry";
import { InkModel } from "../../src/core/annotations/InkModel";
import { InkStore } from "../../src/core/annotations/InkStore";
import type { Stroke } from "../../src/core/annotations/types";
import { DB_NAME, resetDbForTests } from "../../src/core/storage/idb";

const stroke = (id: string, points: number[], width = 2): Stroke => ({ id, tool: "pen", color: "#000", width, points });

describe("geometry", () => {
  it("hit-tests a polyline with its width", () => {
    const s = stroke("a", [0, 0, 100, 0], 4);
    expect(strokeHit(s, 50, 2, 1)).toBe(true);
    expect(strokeHit(s, 50, 10, 1)).toBe(false);
    expect(strokeHit(stroke("dot", [5, 5]), 6, 6, 1)).toBe(true);
  });

  it("does not miss a stroke crossed by a fast eraser swipe", () => {
    const s = stroke("v", [50, 0, 50, 100], 1);
    expect(strokeHitSegment(s, 0, 50, 100, 50, 3)).toBe(true);
  });

  it("straightens near-straight strokes and snaps to horizontal", () => {
    const wobbly = [0, 100, 30, 101, 60, 99.5, 100, 101];
    expect(straighten(wobbly, 3)).toEqual([0, 100.5, 100, 100.5]);
    const curve = [0, 0, 50, 30, 100, 0];
    expect(straighten(curve, 3)).toBeNull();
    expect(snapHorizontal([0, 0, 100, 50])).toEqual([0, 0, 100, 50]);
  });

  it("simplifies dense input but keeps the end point", () => {
    const pts = [0, 0, 0.1, 0, 0.2, 0, 5, 0, 5.1, 0];
    expect(simplify(pts, 1)).toEqual([0, 0, 5, 0, 5.1, 0]);
  });
});

describe("InkModel", () => {
  const saved = new Map<number, Stroke[]>();
  const persistence = { savePage: async (p: number, s: Stroke[]) => void saved.set(p, s) };

  it("adds, removes and undoes/redoes in order", async () => {
    const m = new InkModel(new Map(), persistence, 0);
    const changes: number[] = [];
    m.onChange((p) => changes.push(p));
    m.add(3, stroke("a", [0, 0, 1, 1]));
    m.add(3, stroke("b", [0, 0, 1, 1]));
    m.add(3, stroke("c", [0, 0, 1, 1]));
    m.remove(3, ["a", "c"]);
    expect(m.strokes(3).map((s) => s.id)).toEqual(["b"]);
    m.undo();
    expect(m.strokes(3).map((s) => s.id)).toEqual(["a", "b", "c"]); // original paint order restored
    m.undo();
    expect(m.strokes(3).map((s) => s.id)).toEqual(["a", "b"]);
    m.redo();
    expect(m.strokes(3).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(m.canRedo).toBe(true);
    m.add(4, stroke("d", [1, 1]));
    expect(m.canRedo).toBe(false); // a new action clears redo
    expect(m.pagesWithInk()).toEqual([3, 4]);
    expect(changes.length).toBeGreaterThan(0);
    // listeners see the final undo/redo state
    let seen = false;
    m.onChange(() => (seen = m.canRedo));
    m.undo();
    expect(seen).toBe(true);
    m.redo();
    await m.flush();
    expect(saved.get(3)?.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("empties a page completely", async () => {
    const m = new InkModel(new Map([[0, [stroke("x", [1, 1])]]]), persistence, 0);
    m.remove(0, ["x"]);
    expect(m.pagesWithInk()).toEqual([]);
    await m.flush();
    expect(saved.get(0)).toEqual([]);
  });
});

describe("InkStore", () => {
  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
  });

  it("saves per page, loads per book, deletes a book's ink", async () => {
    const st = new InkStore();
    await st.savePage("b1", 0, [stroke("a", [1, 2])]);
    await st.savePage("b1", 7, [stroke("b", [3, 4])]);
    await st.savePage("b2", 0, [stroke("c", [5, 6])]);
    const m = await st.load("b1");
    expect([...m.keys()].sort()).toEqual([0, 7]);
    await st.savePage("b1", 7, []);
    expect(await st.countPages("b1")).toBe(1);
    await st.deleteBook("b1");
    expect(await st.countPages("b1")).toBe(0);
    expect(await st.countPages("b2")).toBe(1);
  });
});
