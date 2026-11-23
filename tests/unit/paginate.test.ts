import { describe, expect, it } from "vitest";
import { paginate } from "../../src/core/docx/paginate";

const lines = (n: number, h = 20, gap = 4) => Array.from({ length: n }, (_, i) => ({ top: i * (h + gap), bottom: i * (h + gap) + h }));

describe("paginate (Word → pages)", () => {
  it("keeps short content on one page", () => {
    expect(paginate(lines(3), 68, 500)).toEqual([[0, 68]]);
  });
  it("never cuts through a line", () => {
    const atoms = lines(100);
    const pages = paginate(atoms, 100 * 24, 500);
    expect(pages.length).toBeGreaterThan(4);
    for (const [, end] of pages.slice(0, -1)) {
      expect(atoms.some((a) => a.top < end - 0.5 && a.bottom > end + 0.5)).toBe(false);
    }
    for (const [s, e] of pages) expect(e - s).toBeLessThanOrEqual(500);
    // Every line is on some page.
    for (const a of atoms) expect(pages.some(([s, e]) => a.top >= s - 0.5 && a.bottom <= e + 0.5)).toBe(true);
  });
  it("clips a block taller than a page instead of looping", () => {
    const pages = paginate([{ top: 0, bottom: 1200 }], 1200, 500);
    expect(pages[0]).toEqual([0, 500]);
    expect(pages[pages.length - 1][1]).toBe(1200);
  });
});
