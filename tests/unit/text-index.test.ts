import { describe, expect, it } from "vitest";
import { findShift, looksGarbled, shiftText, textScore } from "../../src/core/text/encoding";
import { layoutChars } from "../../src/core/text/textGeometry";
import { fold, runsFromWords, searchWords, wordsFromChars } from "../../src/core/text/words";

const prose =
  "The combustion chamber must burn a large quantity of fuel supplied through the fuel nozzles with the air from the compressor and release the heat";

describe("broken font encoding", () => {
  it("recognises readable and garbled text", () => {
    expect(textScore(prose)).toBeGreaterThan(0.35);
    expect(looksGarbled(prose)).toBe(false);
    const garbled = shiftText(prose, -29); // what subset fonts with glyph ids look like
    expect(looksGarbled(garbled)).toBe(true);
    expect(looksGarbled("  ".repeat(10))).toBe(true);
  });

  it("finds the constant shift and repairs the text", () => {
    const garbled = shiftText(prose, -29);
    const d = findShift(garbled);
    expect(d).toBe(29);
    expect(shiftText(garbled, d!)).toBe(prose);
  });

  it("leaves short or already-good text alone", () => {
    expect(findShift(prose)).toBeNull();
    expect(looksGarbled("Fig. 12-3")).toBe(false);
  });
});

describe("words and search", () => {
  const chars = layoutChars([
    { str: "Động cơ tuabin khí", m: [12, 0, 0, 12, 50, 100], width: 110 },
    { str: "Combustion chamber liner", m: [12, 0, 0, 12, 50, 120], width: 150 },
  ]);
  const words = wordsFromChars(chars);

  it("groups characters into words with boxes", () => {
    expect(words.map((w) => w.t)).toEqual(["Động", "cơ", "tuabin", "khí", "Combustion", "chamber", "liner"]);
    expect(words[0].x).toBeCloseTo(50);
    expect(words[4].y).toBeLessThan(120);
  });

  it("searches without accents, across words and lines", () => {
    expect(fold("Động Cơ")).toBe("dong co");
    const h = searchWords(words, "dong co");
    expect(h).toHaveLength(1);
    expect([h[0].from, h[0].to]).toEqual([0, 1]);
    const h2 = searchWords(words, "CHAMBER lin");
    expect([h2[0].from, h2[0].to]).toEqual([5, 6]);
    expect(h2[0].snippet.slice(h2[0].at, h2[0].at + h2[0].len)).toBe("chamber liner");
    expect(searchWords(words, "boeing")).toEqual([]);
  });

  it("turns OCR words back into runs that rebuild the same boxes", () => {
    const back = wordsFromChars(layoutChars(runsFromWords(words)));
    expect(back.map((w) => w.t)).toEqual(words.map((w) => w.t));
    expect(back[4].x).toBeCloseTo(words[4].x, 0);
    expect(back[4].y).toBeCloseTo(words[4].y, 0);
  });
});
