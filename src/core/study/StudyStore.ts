import { STORES, tx, updateRecords } from "../storage/idb";
import type { DayKey } from "./dates";
import type { Task } from "./tasks";

/** Minutes studied per day (and per book), for "hôm nay đã học …". */
export interface StudyDay {
  date: DayKey;
  ms: number;
  books: Record<string, number>;
}

export class StudyStore {
  async getDay(date: DayKey): Promise<StudyDay> {
    return (await tx<StudyDay | undefined>(STORES.study, "readonly", (s) => s.get(date))) ?? { date, ms: 0, books: {} };
  }

  async addTime(date: DayKey, ms: number, bookId: string | null): Promise<StudyDay> {
    if (ms <= 0) return this.getDay(date);
    // one transaction: time added from two places at once is never lost
    const out = await updateRecords<StudyDay>(STORES.study, [date], (cur) => {
      const d: StudyDay = cur ? { ...cur, books: { ...cur.books } } : { date, ms: 0, books: {} };
      d.ms += ms;
      if (bookId) d.books[bookId] = (d.books[bookId] ?? 0) + ms;
      return d;
    });
    return out.get(date)!;
  }

  // ---- tasks ----

  listTasks(): Promise<Task[]> {
    return tx<Task[]>(STORES.tasks, "readonly", (s) => s.getAll());
  }

  async putTask(t: Task): Promise<void> {
    await tx(STORES.tasks, "readwrite", (s) => s.put(t));
  }

  async deleteTask(id: string): Promise<void> {
    await tx(STORES.tasks, "readwrite", (s) => s.delete(id));
  }
}
