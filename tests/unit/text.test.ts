import { describe, expect, it } from "vitest";
import { highlightRects, layoutChars, snapUnderline, type TextRun } from "../../src/core/text/textGeometry";
import { strokeHit } from "../../src/core/annotations/geometry";

// Two horizontal lines of 10pt text, baselines y=100 and y=114, and a vertical
// label (rotated 90°, reading bottom-to-top) at x=300.
const runs: TextRun[] = [
  { str: "Compressor blades", m: [10, 0, 0, 10, 50, 100], width: 85 },
  { str: "Turbine nozzle", m: [10, 0, 0, 10, 50, 114], width: 70 },
  { str: "Pressure", m: [0, -10, 10, 0, 300, 200], width: 40 },
];
const chars = layoutChars(runs);

describe("layoutChars", () => {
  it("builds boxes along each run, skipping spaces", () => {
    const line1 = chars.filter((c) => c.run === 0);
    expect(line1.length).toBe("Compressorblades".length);
    expect(line1[0].x0).toBeCloseTo(50);
    expect(Math.max(...line1.map((c) => c.x1))).toBeCloseTo(135, 0);
    expect(line1[0].y1).toBeCloseTo(102); // descent below baseline
    expect(line1[0].y0).toBeCloseTo(91.8); // ascent above
  });

  it("handles vertical text", () => {
    const v = chars.filter((c) => c.run === 2);
    expect(Math.min(...v.map((c) => c.y0))).toBeCloseTo(160, 0);
    expect(Math.max(...v.map((c) => c.y1))).toBeCloseTo(200, 0);
    expect(v.every((c) => c.x1 - c.x0 < 12)).toBe(true);
  });
});

describe("highlightRects", () => {
  it("covers whole characters of the line the stroke crosses, even if the stroke is slanted", () => {
    // Slanted stroke across line 1 (from just above to just below its middle).
    const r = highlightRects(chars, [60, 93, 90, 99, 120, 97]);
    expect(r).toHaveLength(1);
    const [x, y, w, h] = r[0];
    expect(y).toBeCloseTo(91.8);
    expect(h).toBeCloseTo(10.2);
    expect(x).toBeLessThanOrEqual(61);
    expect(x + w).toBeGreaterThanOrEqual(119);
  });

  it("covers two lines with two rectangles when dragged across both", () => {
    const r = highlightRects(chars, [55, 97, 100, 98, 55, 110, 100, 111]);
    expect(r).toHaveLength(2);
  });

  it("highlights vertical labels vertically", () => {
    const r = highlightRects(chars, [297, 195, 297, 165]); // glyphs of text rotated 90° CCW extend to the left of the baseline
    expect(r).toHaveLength(1);
    expect(r[0][3]).toBeGreaterThan(r[0][2]); // taller than wide
  });

  it("returns nothing on blank space", () => {
    expect(highlightRects(chars, [400, 400, 450, 400])).toEqual([]);
  });
});

describe("snapUnderline", () => {
  it("puts the line at a fixed distance under the baseline, spanning the covered characters", () => {
    const near = snapUnderline(chars, [60, 101, 110, 101])!;
    const far = snapUnderline(chars, [60, 108, 110, 108])!;
    expect(near[1]).toBe(far[1]); // same offset whatever the pen height
    expect(near[1]).toBeCloseTo(101.6);
    expect(near[0]).toBeGreaterThanOrEqual(58);
    expect(near[2]).toBeLessThanOrEqual(116);
  });

  it("chooses the line above the pen, not the one below", () => {
    const u = snapUnderline(chars, [55, 104, 100, 104])!;
    expect(u[1]).toBeCloseTo(101.6);
  });

  it("returns null away from text", () => {
    expect(snapUnderline(chars, [400, 300, 450, 300])).toBeNull();
  });
});

describe("eraser on text highlights", () => {
  it("hits rectangles", () => {
    const s = { id: "h", tool: "highlighter" as const, color: "#ff0", width: 12, points: [0, 0, 1, 1], rects: [50, 90, 40, 12] };
    expect(strokeHit(s, 70, 95, 1)).toBe(true);
    expect(strokeHit(s, 70, 130, 1)).toBe(false);
  });
});

describe("highlight over blank space next to a big title", () => {
  it("does not grab a character the stroke never crossed", () => {
    const title = layoutChars([{ str: "Page 10", m: [64, 0, 0, 64, 60, 120], width: 220 }]);
    // Stroke to the right of the title, at its height.
    expect(highlightRects(title, [300, 100, 400, 101, 470, 100])).toEqual([]);
  });
});
