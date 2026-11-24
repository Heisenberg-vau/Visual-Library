import { addDays, daysBetween, parseDay, weekStart, type DayKey } from "./dates";

export type Repeat = "daily" | "weekdays" | "weekly";

export const REPEAT_LABEL: Record<Repeat, string> = {
  daily: "Hằng ngày",
  weekdays: "Thứ Hai – Thứ Sáu",
  weekly: "Hằng tuần",
};

/** A study task, a deadline/exam, or a longer-term goal ("dự định"). */
export interface Task {
  id: string;
  title: string;
  kind: "task" | "deadline" | "goal";
  /** Due day, or null for "no date". */
  date: DayKey | null;
  /** Subject = a shelf (category) id, optional. */
  subjectId: string | null;
  /** Optional book (or notebook) and 1-based page to open. */
  bookId: string | null;
  page: number | null;
  done: boolean;
  doneAt: number | null;
  createdAt: number;
  /** Recurring task: when ticked, the next occurrence appears. */
  repeat?: Repeat | null;
}

/**
 * Next due day of a recurring task after it is done. Never in the past:
 * a daily task ticked late comes back tomorrow, not on a day already gone.
 */
export function nextOccurrence(repeat: Repeat, due: DayKey | null, today: DayKey): DayKey {
  const from = due && daysBetween(today, due) > 0 ? due : today;
  if (repeat === "daily") return addDays(from, 1);
  if (repeat === "weekly") {
    let d = addDays(due ?? today, 7);
    while (daysBetween(today, d) <= 0) d = addDays(d, 7);
    return d;
  }
  let d = addDays(from, 1);
  while ([0, 6].includes(parseDay(d).getDay())) d = addDays(d, 1);
  return d;
}

export function isOverdue(t: Task, today: DayKey): boolean {
  return !t.done && t.date !== null && daysBetween(today, t.date) < 0;
}

const byDateThenCreated = (a: Task, b: Task) =>
  (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.createdAt - b.createdAt;

/** "Hôm nay": overdue + due today + undated, open first then done-today. */
export function todayList(tasks: Task[], today: DayKey): Task[] {
  tasks = tasks.filter((t) => t.kind !== "goal"); // goals live on their own
  const open = tasks.filter((t) => !t.done && (t.date === null || daysBetween(today, t.date) <= 0));
  const doneToday = tasks.filter((t) => t.done && (t.date === today || (t.doneAt && sameLocalDay(t.doneAt, today))));
  return [...open.sort(byDateThenCreated), ...doneToday.sort(byDateThenCreated)];
}

function sameLocalDay(ms: number, day: DayKey): boolean {
  const d = new Date(ms);
  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return k === day;
}

/** Seven days Monday..Sunday of the week containing `anyDay`. */
export function weekDays(anyDay: DayKey): DayKey[] {
  const start = weekStart(anyDay);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function groupByDay(tasks: Task[], days: DayKey[]): Map<DayKey, Task[]> {
  const m = new Map<DayKey, Task[]>(days.map((d) => [d, []]));
  for (const t of tasks) if (t.kind !== "goal" && t.date && m.has(t.date)) m.get(t.date)!.push(t);
  for (const list of m.values()) list.sort((a, b) => Number(a.done) - Number(b.done) || byDateThenCreated(a, b));
  return m;
}

/** Upcoming deadlines/exams, nearest first (today included). */
export function upcomingDeadlines(tasks: Task[], today: DayKey, limit = 6): Task[] {
  return tasks
    .filter((t) => t.kind === "deadline" && !t.done && t.date && daysBetween(today, t.date) >= 0)
    .sort(byDateThenCreated)
    .slice(0, limit);
}

/** Badge number: open tasks that are overdue or due today. */
export function dueCount(tasks: Task[], today: DayKey): number {
  return tasks.filter((t) => t.kind !== "goal" && !t.done && t.date !== null && daysBetween(today, t.date) <= 0).length;
}

/** The four notes of the pinboard. */
export interface BoardSections {
  today: Task[];
  /** Later this week (not today), open, not deadlines. */
  week: Task[];
  goals: Task[];
  events: Task[];
}

export function boardSections(tasks: Task[], today: DayKey): BoardSections {
  const end = addDays(weekStart(today), 6);
  return {
    today: todayList(tasks, today),
    week: tasks
      .filter((t) => t.kind === "task" && !t.done && t.date && daysBetween(today, t.date) > 0 && daysBetween(t.date, end) >= 0)
      .sort(byDateThenCreated),
    goals: tasks.filter((t) => t.kind === "goal" && !t.done).sort(byDateThenCreated),
    events: upcomingDeadlines(tasks, today, 8),
  };
}

/** Ticking a task (or un-ticking it). A repeating task also yields its next occurrence. */
export function toggled(t: Task, today: DayKey, now = Date.now(), newId: () => string = () => crypto.randomUUID()): { update: Task; next: Task | null } {
  const update = { ...t, done: !t.done, doneAt: t.done ? null : now };
  const next = update.done && t.repeat ? { ...t, id: newId(), date: nextOccurrence(t.repeat, t.date, today), done: false, doneAt: null, createdAt: now } : null;
  return { update, next };
}
