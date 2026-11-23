/** Local-calendar helpers (the device's time zone), weeks start on Monday. */

export type DayKey = string; // "YYYY-MM-DD"

export function dayKey(d: Date): DayKey {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseDay(k: DayKey): Date {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(k: DayKey, n: number): DayKey {
  const d = parseDay(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** Whole days from a to b (b - a), DST-safe. */
export function daysBetween(a: DayKey, b: DayKey): number {
  const utc = (k: DayKey) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export function weekStart(k: DayKey): DayKey {
  const dow = (parseDay(k).getDay() + 6) % 7; // Monday = 0
  return addDays(k, -dow);
}

const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

export function weekdayName(k: DayKey): string {
  return WEEKDAYS[parseDay(k).getDay()];
}

/** "Thứ Năm 26/11". */
export function longDate(k: DayKey): string {
  const d = parseDay(k);
  return `${weekdayName(k)} ${d.getDate()}/${d.getMonth() + 1}`;
}

/** "Hôm nay", "Ngày mai", "Hôm qua", or "Thứ Năm 26/11". */
export function friendlyDay(k: DayKey, today: DayKey): string {
  const diff = daysBetween(today, k);
  if (diff === 0) return "Hôm nay";
  if (diff === 1) return "Ngày mai";
  if (diff === -1) return "Hôm qua";
  const d = parseDay(k);
  return `${weekdayName(k)} ${d.getDate()}/${d.getMonth() + 1}`;
}

/** "còn 3 ngày", "hôm nay", "quá hạn 2 ngày". */
export function countdown(k: DayKey, today: DayKey): string {
  const diff = daysBetween(today, k);
  if (diff === 0) return "hôm nay";
  if (diff === 1) return "ngày mai";
  if (diff > 0) return `còn ${diff} ngày`;
  return `quá hạn ${-diff} ngày`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} phút`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
