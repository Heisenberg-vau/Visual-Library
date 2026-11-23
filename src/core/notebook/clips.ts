import type { PageLink, Stroke } from "../annotations/types";
import type { WordBox } from "../text/words";

/** Layout of text clips (PDF points), shared by screen and export. */
export const CLIP_FONT = 11;
export const CLIP_LINE = 1.4; // line height, × font size
export const CLIP_PAD = 7; // left padding after the quote bar
export const CLIP_BAR = 2.2;
export const CLIP_BAR_COLOR = "#9db7e0";
export const CLIP_TEXT_COLOR = "#1d2430";
export const CLIP_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

export type Rect = [number, number, number, number];

/** Words whose middle lies inside the rectangle. */
export function wordsInRect(words: readonly WordBox[], [x, y, w, h]: Rect): WordBox[] {
  return words.filter((wd) => {
    const cx = wd.x + wd.w / 2;
    const cy = wd.y + wd.h / 2;
    return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
  });
}

/**
 * Words back into readable text: lines top to bottom, words left to right,
 * line breaks inside a paragraph become spaces (hyphenated words are joined),
 * and a larger gap starts a new paragraph.
 */
export function textFromWords(words: readonly WordBox[]): string {
  const sorted = [...words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines: WordBox[][] = [];
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const line = lines[lines.length - 1];
    if (line) {
      const ly = line.reduce((s, x) => s + x.y + x.h / 2, 0) / line.length;
      const lh = Math.max(...line.map((x) => x.h));
      if (Math.abs(cy - ly) < Math.max(lh, w.h) * 0.5) {
        line.push(w);
        continue;
      }
    }
    lines.push([w]);
  }
  let out = "";
  let prevBottom = 0;
  let prevH = 0;
  lines.forEach((line, i) => {
    line.sort((a, b) => a.x - b.x);
    const top = Math.min(...line.map((w) => w.y));
    const h = Math.max(...line.map((w) => w.h));
    const text = line.map((w) => w.t).join(" ");
    if (i > 0) {
      const gap = top - prevBottom;
      if (gap > Math.max(h, prevH) * 0.9) out += "\n";
      else if (/[A-Za-zÀ-ỹ]-$/.test(out) && /^[a-zà-ỹ]/.test(text)) out = out.slice(0, -1);
      else out += " ";
    }
    out += text;
    prevBottom = top + h;
    prevH = h;
  });
  return out.trim();
}

/** Greedy word wrap; `measure` returns a width in the same units as maxWidth. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (!line || measure(next) <= maxWidth) {
        line = next;
        continue;
      }
      out.push(line);
      line = w;
    }
    // A single word wider than the box: break it by characters.
    while (measure(line) > maxWidth && line.length > 1) {
      let k = line.length - 1;
      while (k > 1 && measure(line.slice(0, k)) > maxWidth) k--;
      out.push(line.slice(0, k));
      line = line.slice(k);
    }
    out.push(line);
  }
  return out;
}

export function textClipSize(lines: string[], width: number, fontSize = CLIP_FONT): { w: number; h: number } {
  return { w: width, h: Math.round((lines.length * fontSize * CLIP_LINE + fontSize * 0.5) * 10) / 10 };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function makeClipStroke(id: string, rect: Rect, clip: NonNullable<Stroke["clip"]>, from: PageLink | null): Stroke {
  const [x, y, w, h] = rect.map(r1) as Rect;
  const s: Stroke = { id, tool: "clip", color: CLIP_TEXT_COLOR, width: 1, points: [x, y], rects: [x, y, w, h], clip };
  if (from) s.link = from;
  return s;
}

/** The same clip moved by (dx, dy). */
export function movedClip(s: Stroke, dx: number, dy: number): Stroke {
  const [x, y, w, h] = s.rects!;
  return { ...s, points: [r1(x + dx), r1(y + dy)], rects: [r1(x + dx), r1(y + dy), w, h] };
}

/** Topmost clip under a point. */
export function clipAt(strokes: readonly Stroke[], x: number, y: number): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (s.tool !== "clip" || !s.rects) continue;
    const [rx, ry, rw, rh] = s.rects;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return s;
  }
  return null;
}

/** Keeps a box of size w×h on a page, near (x, y). */
export function placeOnPage(x: number, y: number, w: number, h: number, pageW: number, pageH: number): [number, number] {
  return [Math.max(0, Math.min(x, pageW - w)), Math.max(0, Math.min(y, pageH - h))];
}

/** Padding before text scales with the font, so a resized clip looks the same. */
export function clipPad(fontSize = CLIP_FONT): number {
  return (CLIP_PAD * fontSize) / CLIP_FONT;
}

/** Size of the resize handle at a clip's bottom-right corner, in points at zoom 1. */
export const CLIP_HANDLE = 12;

/** The clip scaled by k from its top-left corner (text: the font grows too). */
export function scaledClip(s: Stroke, k: number): Stroke {
  const [x, y, w, h] = s.rects!;
  const clip = s.clip!.kind === "text" ? { ...s.clip!, fontSize: r1((s.clip!.fontSize ?? CLIP_FONT) * k * 100) / 100 } : s.clip!;
  return { ...s, rects: [x, y, r1(w * k), r1(h * k)], clip };
}

/** Text of a clip for editing (older clips only kept the wrapped lines). */
export function clipText(s: Stroke): string {
  return s.clip?.text ?? (s.clip?.lines ?? []).join(" ");
}

/** The clip with new text, re-wrapped to its width at its font size. */
export function rewrappedClip(s: Stroke, text: string, measureAt11: (t: string) => number): Stroke {
  const fs = s.clip?.fontSize ?? CLIP_FONT;
  const [x, y, w] = s.rects!;
  const k = fs / CLIP_FONT;
  const lines = wrapLines(text, w - clipPad(fs) - 2 * k, (t) => measureAt11(t) * k);
  const size = textClipSize(lines, w, fs);
  return { ...s, rects: [x, y, w, size.h], clip: { ...s.clip!, kind: "text", text, lines } };
}
