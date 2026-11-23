import type { CharBox, TextRun } from "./textGeometry";

/** A word on a page with its box (PDF points, top-left origin). */
export interface WordBox {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Groups character boxes into words (split on spaces and run changes). */
export function wordsFromChars(chars: CharBox[]): WordBox[] {
  const out: WordBox[] = [];
  let cur: CharBox[] = [];
  const flush = () => {
    if (!cur.length) return;
    const x0 = Math.min(...cur.map((c) => c.x0));
    const y0 = Math.min(...cur.map((c) => c.y0));
    const x1 = Math.max(...cur.map((c) => c.x1));
    const y1 = Math.max(...cur.map((c) => c.y1));
    out.push({ t: cur.map((c) => c.ch).join(""), x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) });
    cur = [];
  };
  let prev: CharBox | null = null;
  for (const c of chars) {
    // layoutChars skips spaces, so a gap in idx means a space.
    if (prev && (c.run !== prev.run || c.idx !== prev.idx + 1)) flush();
    if (/\s/.test(c.ch)) {
      flush();
    } else {
      cur.push(c);
    }
    prev = c;
  }
  flush();
  return out;
}

/** OCR words back into text runs, so highlight/underline snapping works on scans. */
export function runsFromWords(words: WordBox[]): TextRun[] {
  return words.map((w) => {
    const size = w.h / 1.02; // layoutChars: ascent 0.82 + descent 0.2
    const baseline = w.y + size * 0.82;
    return { str: w.t, m: [size, 0, 0, size, w.x, baseline], width: w.w };
  });
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Accent/case-insensitive form used for searching ("Động" -> "dong"). */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export interface Hit {
  /** Word index range [from, to] inclusive. */
  from: number;
  to: number;
  snippet: string;
  /** Offset/length of the match inside the snippet, for bolding. */
  at: number;
  len: number;
}

/** Finds a (multi-word) query in a page's words, accent-insensitively. */
export function searchWords(words: WordBox[], query: string, maxHits = 50): Hit[] {
  const q = fold(query).replace(/\s+/g, " ").trim();
  if (!q) return [];
  // Page text with a map from character offset to word index.
  let text = "";
  const owner: number[] = [];
  words.forEach((w, i) => {
    if (i > 0) {
      text += " ";
      owner.push(i - 1);
    }
    const f = fold(w.t);
    text += f;
    for (let k = 0; k < f.length; k++) owner.push(i);
  });
  const hits: Hit[] = [];
  let pos = text.indexOf(q);
  while (pos >= 0 && hits.length < maxHits) {
    const from = owner[pos];
    const to = owner[Math.min(owner.length - 1, pos + q.length - 1)];
    const s0 = Math.max(0, from - 6);
    const s1 = Math.min(words.length - 1, to + 6);
    const before = words.slice(s0, from).map((w) => w.t).join(" ");
    const match = words.slice(from, to + 1).map((w) => w.t).join(" ");
    const after = words.slice(to + 1, s1 + 1).map((w) => w.t).join(" ");
    const snippet = `${s0 > 0 ? "… " : ""}${before}${before ? " " : ""}${match}${after ? " " : ""}${after}${s1 < words.length - 1 ? " …" : ""}`;
    const at = (s0 > 0 ? 2 : 0) + before.length + (before ? 1 : 0);
    hits.push({ from, to, snippet, at, len: match.length });
    pos = text.indexOf(q, pos + q.length);
  }
  return hits;
}
