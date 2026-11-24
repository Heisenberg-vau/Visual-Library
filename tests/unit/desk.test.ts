import { describe, expect, it } from "vitest";
import { DESK_MAX, dustLevel, evictionCandidate, idleDays, putOnDesk, removeFromDesk } from "../../src/core/desk";

const DAY = 86_400_000;

describe("desk", () => {
  it("holds at most 6, and makes room by putting back the least recently opened", () => {
    let items = [] as ReturnType<typeof putOnDesk>["items"];
    const opened: Record<string, number> = { a: 50, b: 10, c: 60, d: 70, e: 80, f: 90 };
    for (const id of ["a", "b", "c", "d", "e", "f"]) items = putOnDesk(items, id, 1, (x) => opened[x] ?? 0).items;
    expect(items).toHaveLength(DESK_MAX);
    expect(evictionCandidate(items, (x) => opened[x])?.id).toBe("b");
    const r = putOnDesk(items, "g", 100, (x) => opened[x] ?? 0);
    expect(r.evicted).toBe("b");
    expect(r.items.map((i) => i.id)).toEqual(["a", "c", "d", "e", "f", "g"]);
  });
  it("taking something already on the desk changes nothing", () => {
    const items = [{ id: "a", at: 1 }];
    expect(putOnDesk(items, "a", 5, () => 0)).toEqual({ items, evicted: null });
    expect(removeFromDesk(items, "a")).toEqual([]);
  });
  it("dust after a week untouched, thicker with time", () => {
    const now = 100 * DAY;
    expect(idleDays({ id: "a", at: now - 3 * DAY }, 0, now)).toBe(3);
    expect(idleDays({ id: "a", at: 0 }, now - 13 * DAY, now)).toBe(13);
    expect(dustLevel(6)).toBe(0);
    expect(dustLevel(7)).toBeCloseTo(0.35);
    expect(dustLevel(100)).toBe(1);
  });
});
