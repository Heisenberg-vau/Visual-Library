import { STORES, tx } from "../storage/idb";
import type { DayKey } from "./dates";

/**
 * Which pages of a book were actually read (non-linear reading friendly).
 * A page counts once it has been the main page on screen for DWELL_MS.
 */
export const DWELL_MS = 8000;

export interface BookReading {
  bookId: string;
  /** Bitset, bit i = page i (0-based) read. */
  bits: Uint8Array;
  count: number;
  updatedAt: number;
}

export interface ReadingDay {
  date: DayKey;
  /** "bookId:page" read that day (re-reads included). */
  keys: string[];
}

export function hasBit(bits: Uint8Array, i: number): boolean {
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}

/** Returns a (possibly grown) bitset with bit i set, and whether it was new. */
export function setBit(bits: Uint8Array, i: number): { bits: Uint8Array; added: boolean } {
  let b = bits;
  if (b.length <= i >> 3) {
    const g = new Uint8Array((i >> 3) + 1);
    g.set(b);
    b = g;
  }
  if (hasBit(b, i)) return { bits: b, added: false };
  b[i >> 3] |= 1 << (i & 7);
  return { bits: b, added: true };
}

export function countBits(bits: Uint8Array): number {
  let n = 0;
  for (const byte of bits) {
    let v = byte;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

/** Fraction read in each of `segments` equal slices of the book (for the strip). */
export function coverage(bits: Uint8Array, pageCount: number, segments: number): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.min(segments, pageCount));
  for (let s = 0; s < n; s++) {
    const a = Math.floor((s * pageCount) / n);
    const b = Math.floor(((s + 1) * pageCount) / n);
    let read = 0;
    for (let i = a; i < b; i++) if (hasBit(bits, i)) read++;
    out.push(b > a ? read / (b - a) : 0);
  }
  return out;
}

export class ReadingStore {
  async get(bookId: string): Promise<BookReading> {
    const r = await tx<BookReading | undefined>(STORES.reading, "readonly", (s) => s.get(bookId));
    return r ?? { bookId, bits: new Uint8Array(0), count: 0, updatedAt: 0 };
  }

  async all(): Promise<Map<string, BookReading>> {
    const rows = await tx<BookReading[]>(STORES.reading, "readonly", (s) => s.getAll());
    return new Map(rows.map((r) => [r.bookId, r]));
  }

  /** Marks a page read for the book and for the day. */
  async markRead(bookId: string, page: number, day: DayKey): Promise<{ book: BookReading; todayCount: number }> {
    const r = await this.get(bookId);
    const { bits, added } = setBit(r.bits, page);
    const book: BookReading = { bookId, bits, count: added ? r.count + 1 : r.count, updatedAt: Date.now() };
    if (added) await tx(STORES.reading, "readwrite", (s) => s.put(book));
    const d = await this.getDay(day);
    const key = `${bookId}:${page}`;
    if (!d.keys.includes(key)) {
      d.keys.push(key);
      await tx(STORES.readingDays, "readwrite", (s) => s.put(d));
    }
    return { book, todayCount: d.keys.length };
  }

  async getDay(day: DayKey): Promise<ReadingDay> {
    return (await tx<ReadingDay | undefined>(STORES.readingDays, "readonly", (s) => s.get(day))) ?? { date: day, keys: [] };
  }

  async deleteBook(bookId: string): Promise<void> {
    await tx(STORES.reading, "readwrite", (s) => s.delete(bookId));
  }
}
