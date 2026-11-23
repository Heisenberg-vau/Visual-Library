import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, countdown, dayKey, daysBetween, friendlyDay, mmss, weekStart } from "../../src/core/study/dates";
import { StudyTimer } from "../../src/core/study/timer";
import { dueCount, groupByDay, todayList, upcomingDeadlines, weekDays, type Task } from "../../src/core/study/tasks";
import { StudyStore } from "../../src/core/study/StudyStore";
import { DB_NAME, resetDbForTests } from "../../src/core/storage/idb";

const MIN = 60_000;

describe("dates", () => {
  it("handles local days, weeks (Mon start) and labels", () => {
    expect(dayKey(new Date(2026, 10, 23))).toBe("2026-11-23");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(daysBetween("2026-11-23", "2026-11-26")).toBe(3);
    expect(weekStart("2026-11-23")).toBe("2026-11-23"); // a Monday
    expect(weekStart("2026-11-29")).toBe("2026-11-23"); // Sunday belongs to the same week
    expect(friendlyDay("2026-11-26", "2026-11-23")).toBe("Thứ Năm 26/11");
    expect(friendlyDay("2026-11-24", "2026-11-23")).toBe("Ngày mai");
    expect(countdown("2026-11-26", "2026-11-23")).toBe("còn 3 ngày");
    expect(countdown("2026-11-21", "2026-11-23")).toBe("quá hạn 2 ngày");
    expect(mmss(65_000)).toBe("01:05");
  });
});

describe("StudyTimer", () => {
  const cfg = { focusMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 2 };

  it("suggests a break when focus ends, keeps counting until answered", () => {
    const t = new StudyTimer(cfg);
    t.startFocus(0);
    expect(t.tick(24 * MIN)).toBeNull();
    expect(t.tick(25 * MIN)).toEqual({ type: "focusDone", longBreak: false });
    expect(t.tick(26 * MIN)).toBeNull(); // only once
    expect(t.state.phase).toBe("focus"); // not forced into a break
    expect(t.startBreak(27 * MIN)).toBe(27 * MIN); // all 27 min of focus are logged
    expect(t.remaining(27 * MIN)).toBe(5 * MIN);
    expect(t.tick(32 * MIN)).toEqual({ type: "breakDone" });
    expect(t.state.phase).toBe("idle");
  });

  it("gives a long break every N blocks; extend and pause work", () => {
    const t = new StudyTimer(cfg);
    t.startFocus(0);
    t.tick(25 * MIN);
    t.startBreak(25 * MIN);
    t.tick(30 * MIN);
    t.startFocus(30 * MIN);
    t.extend(40 * MIN, 10);
    expect(t.remaining(40 * MIN)).toBe(25 * MIN);
    expect(t.pause(41 * MIN)).toBe(11 * MIN);
    expect(t.remaining(50 * MIN)).toBe(24 * MIN); // frozen while paused
    t.resume(50 * MIN);
    expect(t.tick(74 * MIN)).toEqual({ type: "focusDone", longBreak: true });
    t.startBreak(74 * MIN);
    expect(t.remaining(74 * MIN)).toBe(15 * MIN);
  });

  it("'Học thêm 10 phút' after the suggestion reminds again 10 minutes later", () => {
    const t = new StudyTimer(cfg);
    t.startFocus(0);
    expect(t.tick(25 * MIN)?.type).toBe("focusDone");
    t.extend(26 * MIN, 10);
    expect(t.remaining(26 * MIN)).toBe(10 * MIN);
    expect(t.tick(36 * MIN)?.type).toBe("focusDone");
  });

  it("logs focus time on stop, nothing for breaks", () => {
    const t = new StudyTimer(cfg);
    t.startFocus(0);
    expect(t.collect(10 * MIN)).toBe(10 * MIN);
    expect(t.stop(12 * MIN)).toBe(2 * MIN);
    t.startFocus(20 * MIN);
    t.tick(45 * MIN);
    t.startBreak(45 * MIN);
    expect(t.stop(48 * MIN)).toBe(0);
  });
});

describe("tasks", () => {
  const today = "2026-11-23";
  const mk = (id: string, date: string | null, extra: Partial<Task> = {}): Task => ({
    id, title: id, kind: "task", date, subjectId: null, bookId: null, page: null, done: false, doneAt: null, createdAt: 0, ...extra,
  });
  const tasks = [
    mk("overdue", "2026-11-20"),
    mk("today", today),
    mk("nodate", null),
    mk("future", "2026-11-25"),
    mk("doneOld", "2026-11-19", { done: true, doneAt: 0 }),
    mk("exam", "2026-11-26", { kind: "deadline" }),
    mk("pastExam", "2026-11-01", { kind: "deadline" }),
  ];

  it("today shows overdue, today and undated", () => {
    expect(todayList(tasks, today).map((t) => t.id)).toEqual(["pastExam", "overdue", "today", "nodate"]);
    expect(dueCount(tasks, today)).toBe(3); // overdue, today, pastExam
  });

  it("groups a week and lists upcoming deadlines", () => {
    const days = weekDays(today);
    expect(days[0]).toBe("2026-11-23");
    expect(days[6]).toBe("2026-11-29");
    const g = groupByDay(tasks, days);
    expect(g.get("2026-11-25")!.map((t) => t.id)).toEqual(["future"]);
    expect(upcomingDeadlines(tasks, today).map((t) => t.id)).toEqual(["exam"]);
  });
});

describe("StudyStore", () => {
  beforeEach(async () => {
    await resetDbForTests();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => r();
    });
  });

  it("adds study time per day and per book", async () => {
    const st = new StudyStore();
    await st.addTime("2026-11-23", 10 * MIN, "b1");
    const d = await st.addTime("2026-11-23", 5 * MIN, null);
    expect(d.ms).toBe(15 * MIN);
    expect(d.books).toEqual({ b1: 10 * MIN });
    expect((await st.getDay("2026-11-24")).ms).toBe(0);
  });
});
