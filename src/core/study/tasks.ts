import { addDays, daysBetween, weekStart, type DayKey } from "./dates";

/** A study task or a deadline/exam set by the user. */
export interface Task {
  id: string;
  title: string;
  kind: "task" | "deadline";
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
}

export function isOverdue(t: Task, today: DayKey): boolean {
  return !t.done && t.date !== null && daysBetween(today, t.date) < 0;
}

const byDateThenCreated = (a: Task, b: Task) =>
  (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.createdAt - b.createdAt;

/** "Hôm nay": overdue + due today + undated, open first then done-today. */
export function todayList(tasks: Task[], today: DayKey): Task[] {
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
  for (const t of tasks) if (t.date && m.has(t.date)) m.get(t.date)!.push(t);
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
  return tasks.filter((t) => !t.done && t.date !== null && daysBetween(today, t.date) <= 0).length;
}
