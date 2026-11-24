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

import { boardSections, toggled, type Task } from "../../src/core/study/tasks";

const T = (p: Partial<Task>): Task => ({ id: Math.random().toString(36), title: "x", kind: "task", date: null, subjectId: null, bookId: null, page: null, done: false, doneAt: null, createdAt: 1, ...p });

describe("pinboard sections", () => {
  // 2026-11-24 is a Tuesday; the week ends Sunday 2026-11-29
  const today = "2026-11-24";
  it("splits tasks into today / later this week / goals / events", () => {
    const tasks = [
      T({ title: "today", date: today }),
      T({ title: "late", date: "2026-11-20" }),
      T({ title: "thu", date: "2026-11-26" }),
      T({ title: "next week", date: "2026-12-02" }),
      T({ title: "goal", kind: "goal" }),
      T({ title: "exam", kind: "deadline", date: "2026-11-27" }),
    ];
    const s = boardSections(tasks, today);
    expect(s.today.map((t) => t.title)).toEqual(["late", "today"]);
    expect(s.week.map((t) => t.title)).toEqual(["thu"]);
    expect(s.goals.map((t) => t.title)).toEqual(["goal"]);
    expect(s.events.map((t) => t.title)).toEqual(["exam"]);
  });
  it("ticking a repeating task yields the next one", () => {
    const r = toggled(T({ date: today, repeat: "daily" }), today, 5, () => "n");
    expect(r.update.done).toBe(true);
    expect(r.next?.date).toBe("2026-11-25");
    expect(toggled(r.update, today).update.done).toBe(false);
  });
});
