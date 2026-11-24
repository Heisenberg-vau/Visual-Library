/**
 * The study desk: books and notebooks taken off their shelves. At most
 * DESK_MAX items so it never gets cluttered; when full, the one untouched
 * the longest is suggested for putting back. Items left unopened for
 * DUST_DAYS gather dust (and a gentle reminder) — never put back by itself.
 */
export interface DeskItem {
  id: string;
  /** When it was put on the desk. */
  at: number;
}

export const DESK_MAX = 6;
export const DUST_DAYS = 7;
const DAY = 86_400_000;

/** The item to put back to make room: opened least recently. */
export function evictionCandidate(items: readonly DeskItem[], lastOpened: (id: string) => number): DeskItem | null {
  if (!items.length) return null;
  return [...items].sort((a, b) => Math.max(lastOpened(a.id), a.at) - Math.max(lastOpened(b.id), b.at))[0];
}

/** Puts `id` on the desk (or keeps it there). Returns the new list and what had to go. */
export function putOnDesk(items: readonly DeskItem[], id: string, now: number, lastOpened: (id: string) => number): { items: DeskItem[]; evicted: string | null } {
  if (items.some((i) => i.id === id)) return { items: [...items], evicted: null };
  let list = [...items];
  let evicted: string | null = null;
  if (list.length >= DESK_MAX) {
    const c = evictionCandidate(list, lastOpened)!;
    evicted = c.id;
    list = list.filter((i) => i !== c);
  }
  list.push({ id, at: now });
  return { items: list, evicted };
}

export function removeFromDesk(items: readonly DeskItem[], id: string): DeskItem[] {
  return items.filter((i) => i.id !== id);
}

/** Whole days since the item was last opened (or put down). */
export function idleDays(item: DeskItem, lastOpened: number, now: number): number {
  return Math.max(0, Math.floor((now - Math.max(lastOpened, item.at)) / DAY));
}

/** 0 (clean) … 1 (very dusty). */
export function dustLevel(days: number): number {
  if (days < DUST_DAYS) return 0;
  return Math.min(1, 0.35 + ((days - DUST_DAYS) / 30) * 0.65);
}
