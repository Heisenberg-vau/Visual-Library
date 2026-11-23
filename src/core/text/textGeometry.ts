/**
 * Character boxes of a page, in the same coordinates as handwriting
 * (PDF points, origin top-left of the displayed page). Pure: the PDF layer
 * feeds text runs in; highlight/underline snapping reads boxes out.
 *
 * Works for horizontal, vertical and rotated text (chart axes, side labels),
 * and for PDFs whose text copies as garbage: only the geometry is used.
 */

export interface TextRun {
  str: string;
  /** Run transform already in page (viewport, y-down) space at scale 1. */
  m: [number, number, number, number, number, number];
  /** Advance length of the whole run along its direction, in points. */
  width: number;
  /** CSS font family hint from the PDF ("sans-serif", "serif", "monospace"…). */
  family?: string;
  /** PDF font id (to repair broken encodings per font). */
  font?: string;
}

export interface CharBox {
  /** Axis-aligned box. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Run index: chars of one run share a line and direction. */
  run: number;
  /** Position inside the run. */
  idx: number;
  /** Direction of the line: unit vector along the text. */
  ux: number;
  uy: number;
  /** Font size (line height basis) in points. */
  size: number;
  /** Baseline point at the char's start. */
  bx: number;
  by: number;
  ch: string;
}

const ASCENT = 0.82;
const DESCENT = 0.2;

/** Relative advance of a character (only ratios within a run matter). */
export type CharWidthEstimator = (ch: string, family?: string) => number;

export const defaultCharWidth: CharWidthEstimator = (ch) => {
  if (ch === " ") return 0.28;
  if (/[iIl.,:;'!|]/.test(ch)) return 0.3;
  if (/[mwMW]/.test(ch)) return 0.85;
  if (/[A-Z0-9]/.test(ch)) return 0.65;
  if (/[　-鿿가-힯]/.test(ch)) return 1; // CJK
  return 0.52;
};

export function layoutChars(runs: TextRun[], estimate: CharWidthEstimator = defaultCharWidth): CharBox[] {
  const out: CharBox[] = [];
  runs.forEach((r, run) => {
    const chars = [...r.str];
    if (!chars.length || !r.str.trim()) return;
    const [a, b, c, d, e, f] = r.m;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    if (!(size > 0.5)) return;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len;
    const uy = b / len;
    // "Up" for the text (toward ascenders), in y-down page space.
    const vx = uy;
    const vy = -ux;
    const est = chars.map((ch) => estimate(ch, r.family));
    const total = est.reduce((s, w) => s + w, 0) || 1;
    const width = r.width > 0 ? r.width : total * size;
    let s = 0;
    chars.forEach((ch, idx) => {
      const w = (est[idx] / total) * width;
      const bx = e + ux * s;
      const by = f + uy * s;
      const pts = [
        [bx - vx * DESCENT * size, by - vy * DESCENT * size],
        [bx + vx * ASCENT * size, by + vy * ASCENT * size],
        [bx + ux * w - vx * DESCENT * size, by + uy * w - vy * DESCENT * size],
        [bx + ux * w + vx * ASCENT * size, by + uy * w + vy * ASCENT * size],
      ];
      s += w;
      if (ch === " ") return;
      out.push({
        x0: Math.min(...pts.map((p) => p[0])),
        y0: Math.min(...pts.map((p) => p[1])),
        x1: Math.max(...pts.map((p) => p[0])),
        y1: Math.max(...pts.map((p) => p[1])),
        run,
        idx,
        ux,
        uy,
        size,
        bx,
        by,
        ch,
      });
    });
  });
  return out;
}

/**
 * Highlight snapped to text: rectangles covering the characters the stroke
 * passed over, one per line (gaps between hit characters are filled).
 * Returns [] when the stroke did not cross any text.
 */
export function highlightRects(chars: CharBox[], stroke: number[]): number[][] {
  if (!chars.length || stroke.length < 2) return [];
  // Resample the stroke evenly so every part of it gets the same say.
  const step = Math.max(1, Math.min(...chars.map((c) => c.size)) / 3);
  const samples: number[] = [stroke[0], stroke[1]];
  for (let i = 0; i + 3 < stroke.length; i += 2) {
    const ax = stroke[i];
    const ay = stroke[i + 1];
    const bx = stroke[i + 2];
    const by = stroke[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) samples.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
  }
  // Each sample votes for the character box it is over (boxes slightly padded,
  // more vertically, since hands drift off the line). If it is over several,
  // the nearest centre wins, so a stroke between two lines never grabs both.
  const centres = chars.map((c) => [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2]);
  const votes = new Map<number, number>();
  const hitChars = new Map<number, CharBox[]>();
  let onText = 0;
  for (let i = 0; i < samples.length; i += 2) {
    const px = samples[i];
    const py = samples[i + 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < chars.length; j++) {
      const c = chars[j];
      const horiz = Math.abs(c.uy) < 0.3;
      const padAlong = Math.min(c.size * 0.3, 4);
      const padAcross = Math.min(c.size * 0.4, 6);
      const px0 = c.x0 - (horiz ? padAlong : padAcross);
      const px1 = c.x1 + (horiz ? padAlong : padAcross);
      const py0 = c.y0 - (horiz ? padAcross : padAlong);
      const py1 = c.y1 + (horiz ? padAcross : padAlong);
      if (px < px0 || px > px1 || py < py0 || py > py1) continue;
      const d = Math.hypot(px - centres[j][0], py - centres[j][1]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) continue;
    onText++;
    const c = chars[best];
    votes.set(c.run, (votes.get(c.run) ?? 0) + 1);
    const l = hitChars.get(c.run) ?? [];
    l.push(c);
    hitChars.set(c.run, l);
  }
  // Mostly over blank paper (a margin note, a drawing): not a text highlight.
  if (onText < (samples.length / 2) * 0.5) return [];
  const maxVotes = Math.max(0, ...votes.values());
  const hitsByRun = new Map<number, CharBox[]>();
  for (const [run, n] of votes) {
    // Ignore lines only grazed at the stroke's ends.
    if (n >= Math.max(2, maxVotes * 0.2) || votes.size === 1) hitsByRun.set(run, hitChars.get(run)!);
  }
  if (!hitsByRun.size) return [];
  // Fill from first to last hit char within each run.
  const byRun = new Map<number, CharBox[]>();
  for (const c of chars) {
    if (!hitsByRun.has(c.run)) continue;
    const l = byRun.get(c.run) ?? [];
    l.push(c);
    byRun.set(c.run, l);
  }
  let rects: { x0: number; y0: number; x1: number; y1: number; horiz: boolean; size: number }[] = [];
  for (const [run, hits] of hitsByRun) {
    const lo = Math.min(...hits.map((h) => h.idx));
    const hi = Math.max(...hits.map((h) => h.idx));
    const span = byRun.get(run)!.filter((c) => c.idx >= lo && c.idx <= hi);
    const h0 = span[0];
    rects.push({
      x0: Math.min(...span.map((c) => c.x0)),
      y0: Math.min(...span.map((c) => c.y0)),
      x1: Math.max(...span.map((c) => c.x1)),
      y1: Math.max(...span.map((c) => c.y1)),
      horiz: Math.abs(h0.uy) < 0.3,
      size: h0.size,
    });
  }
  // Merge pieces of the same line (runs split by font changes).
  rects.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.horiz !== b.horiz) continue;
        const gap = a.size * 0.8;
        const sameLine = a.horiz
          ? overlap(a.y0, a.y1, b.y0, b.y1) > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) &&
            (b.x0 <= a.x1 + gap && a.x0 <= b.x1 + gap)
          : overlap(a.x0, a.x1, b.x0, b.x1) > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) &&
            (b.y0 <= a.y1 + gap && a.y0 <= b.y1 + gap);
        if (sameLine) {
          rects[i] = {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
            horiz: a.horiz,
            size: Math.max(a.size, b.size),
          };
          rects.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  rects = rects.filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  return rects.map((r) => [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0]);
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Underline snapped to text like a word processor: the line sits a fixed
 * distance under the baseline of the nearest line ABOVE the pen, and spans
 * exactly the characters it covers. Returns null if no text is near.
 */
export function snapUnderline(chars: CharBox[], seg: [number, number, number, number]): number[] | null {
  const [ax, ay, bx, by] = seg;
  const xa = Math.min(ax, bx);
  const xb = Math.max(ax, bx);
  const y = (ay + by) / 2;
  // Horizontal text only; group by run.
  const runs = new Map<number, CharBox[]>();
  for (const c of chars) {
    if (Math.abs(c.uy) > 0.2 || c.ux < 0) continue;
    const covered = overlap(c.x0, c.x1, xa, xb) / Math.max(0.01, c.x1 - c.x0);
    if (covered < 0.5) continue;
    const l = runs.get(c.run) ?? [];
    l.push(c);
    runs.set(c.run, l);
  }
  let best: { baseline: number; size: number; d: number } | null = null;
  for (const list of runs.values()) {
    const baseline = list[0].by;
    const size = list[0].size;
    // Pen must be below the middle of the text and not further than ~1.1 lines below the baseline.
    if (y < baseline - size * 0.45 || y > baseline + size * 1.1) continue;
    const d = Math.abs(y - baseline);
    if (!best || d < best.d) best = { baseline, size, d };
  }
  if (!best) return null;
  // Same baseline: include chars from other runs on that line.
  const line: CharBox[] = [];
  for (const list of runs.values()) if (Math.abs(list[0].by - best.baseline) < best.size * 0.2) line.push(...list);
  const x0 = Math.min(...line.map((c) => c.x0));
  const x1 = Math.max(...line.map((c) => c.x1));
  const yy = Math.round((best.baseline + Math.max(1.2, best.size * 0.16)) * 10) / 10;
  return [Math.round(x0 * 10) / 10, yy, Math.round(x1 * 10) / 10, yy];
}
