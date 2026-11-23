/** A vertical span that must not be cut (a line of text, an image). */
export interface Atom {
  top: number;
  bottom: number;
}

/**
 * Splits a flow of content `total` px tall into pages of at most `pageH` px,
 * cutting only between lines (never through a line of text or an image).
 * Returns the cut positions [start, end) of every page. Content taller than a
 * page (a huge image) is cut at the page height, as Word would clip it.
 */
export function paginate(atoms: Atom[], total: number, pageH: number): [number, number][] {
  const sorted = atoms.filter((a) => a.bottom > a.top).sort((a, b) => a.top - b.top);
  const pages: [number, number][] = [];
  let start = 0;
  let guard = 0;
  while (start < total - 0.5 && guard++ < 100000) {
    const limit = start + pageH;
    if (limit >= total) {
      pages.push([start, total]);
      break;
    }
    const inWindow = sorted.filter((a) => a.bottom > start && a.top < limit);
    const crosses = (y: number) => inWindow.some((a) => a.top < y - 0.5 && a.bottom > y + 0.5);
    let cut = -1;
    if (!crosses(limit)) cut = limit;
    else {
      const candidates = inWindow
        .map((a) => a.bottom)
        .filter((y) => y > start + pageH * 0.25 && y <= limit)
        .sort((a, b) => b - a);
      for (const y of candidates) {
        if (!crosses(y)) {
          cut = y;
          break;
        }
      }
      if (cut < 0) cut = limit; // a single block taller than the page
    }
    pages.push([start, cut]);
    // The next page starts at its first line, not in the gap before it.
    const next = sorted.find((a) => a.bottom > cut + 0.5);
    start = next ? Math.max(cut, Math.min(next.top, cut + pageH * 0.1)) : total;
    if (next && next.top >= total) break;
  }
  if (!pages.length) pages.push([0, Math.max(total, 0)]);
  return pages;
}
