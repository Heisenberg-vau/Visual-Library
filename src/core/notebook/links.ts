import type { PageLink, Stroke } from "../annotations/types";

/** Geometry of a page-link chip (PDF points), shared by screen and export. */
export const LINK_FONT = 11;
/** Tall enough to hit with a fingertip at normal zoom. */
export const LINK_H = 22;

export function linkLabel(bookTitle: string, page: number): string {
  const t = bookTitle.length > 34 ? bookTitle.slice(0, 33).trimEnd() + "…" : bookTitle;
  return `${t} · tr. ${page}`;
}

/** Rough width of the label in points (Helvetica-like proportions). */
export function linkWidth(label: string): number {
  let w = 0;
  for (const ch of label) w += /[iIl.,:;'·|]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.52;
  return Math.round((w * LINK_FONT + 26) * 10) / 10;
}

export function makeLinkStroke(id: string, x: number, y: number, link: PageLink): Stroke {
  const w = linkWidth(link.label);
  const top = Math.round((y - LINK_H / 2) * 10) / 10;
  return {
    id,
    tool: "link",
    color: "#1f5fbf",
    width: 1,
    points: [Math.round(x * 10) / 10, Math.round(y * 10) / 10],
    rects: [Math.round(x * 10) / 10, top, w, LINK_H],
    link,
  };
}

/** Link chip under a point, if any (topmost first). */
export function linkAt(strokes: readonly Stroke[], x: number, y: number, pad = 2): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (s.tool !== "link" || !s.rects) continue;
    const [rx, ry, rw, rh] = s.rects;
    if (x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad) return s;
  }
  return null;
}

/** For export with standard PDF fonts: strip Vietnamese diacritics. */
export function asciiFold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/·/g, "-")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, "?");
}
