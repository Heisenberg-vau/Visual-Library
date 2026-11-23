import { describe, expect, it } from "vitest";
import { clipAt, makeClipStroke, movedClip, placeOnPage, textFromWords, wordsInRect, wrapLines } from "../../src/core/notebook/clips";
import { InkModel } from "../../src/core/annotations/InkModel";
import type { WordBox } from "../../src/core/text/words";

const W = (t: string, x: number, y: number, w = t.length * 5, h = 10): WordBox => ({ t, x, y, w, h });

describe("clips: taking text from a page area", () => {
  const words = [
    W("Buồng", 10, 10), W("đốt", 50, 10), W("phải", 80, 10),
    W("đốt", 10, 24), W("combus-", 40, 24),
    W("tion", 10, 38), W("liệu.", 50, 38),
    W("Đoạn", 10, 70), W("mới", 50, 70),
    W("ngoài", 300, 10),
  ];
  it("keeps only words inside the box", () => {
    expect(wordsInRect(words, [0, 0, 200, 100]).map((w) => w.t)).not.toContain("ngoài");
  });
  it("joins lines, mends hyphenation, keeps paragraphs", () => {
    const text = textFromWords(wordsInRect(words, [0, 0, 200, 100]).reverse());
    expect(text).toBe("Buồng đốt phải đốt combustion liệu.\nĐoạn mới");
  });
  it("wraps to a width", () => {
    const lines = wrapLines("một hai ba bốn năm sáu", 30, (s) => s.length * 3);
    expect(lines.every((l) => l.length * 3 <= 30)).toBe(true);
    expect(lines.join(" ")).toBe("một hai ba bốn năm sáu");
    expect(wrapLines("a\n\nb", 100, (s) => s.length)).toEqual(["a", "", "b"]);
  });
  it("breaks a word longer than the box", () => {
    expect(wrapLines("abcdefghij", 4, (s) => s.length)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("clips: placing and moving", () => {
  it("stays on the page", () => {
    expect(placeOnPage(500, 800, 200, 100, 595, 842)).toEqual([395, 742]);
    expect(placeOnPage(-20, -5, 50, 50, 595, 842)).toEqual([0, 0]);
  });
  it("moves as one undo step", async () => {
    const saved: unknown[] = [];
    const model = new InkModel(new Map(), { savePage: async (_p, s) => void saved.push(s) }, 0);
    const c = makeClipStroke("c1", [10, 20, 100, 40], { kind: "text", lines: ["x"] }, null);
    model.add(0, c);
    expect(clipAt(model.strokes(0), 50, 30)?.id).toBe("c1");
    model.replace(0, c, movedClip(c, 30, 5));
    expect(model.strokes(0)[0].rects).toEqual([40, 25, 100, 40]);
    model.undo();
    expect(model.strokes(0)[0].rects).toEqual([10, 20, 100, 40]);
    model.redo();
    expect(model.strokes(0)[0].points).toEqual([40, 25]);
  });
});
