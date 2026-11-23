import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { InkModel } from "../../src/core/annotations/InkModel";
import { strokeHit } from "../../src/core/annotations/geometry";
import { strokeSvg } from "../../src/core/annotations/path";
import { exportAnnotatedPdf } from "../../src/core/export/exportPdf";
import { buildNotebookJobs } from "../../src/core/export/ExportService";
import { asciiFold, linkAt, linkLabel, makeLinkStroke } from "../../src/core/notebook/links";

const link = makeLinkStroke("L1", 100, 200, { bookId: "b1", page: 245, label: linkLabel("Rolls-Royce: The Jet Engine", 245) });

describe("page links", () => {
  it("builds a chip centred vertically on the tap and finds it again", () => {
    expect(link.rects![1]).toBe(189);
    expect(link.rects![2]).toBeGreaterThan(100);
    expect(linkAt([link], 110, 200)?.id).toBe("L1");
    expect(linkAt([link], 90, 230)).toBeNull();
    expect(strokeHit(link, 110, 200, 1)).toBe(true); // the eraser can remove it
  });

  it("shortens long titles and renders escaped SVG", () => {
    expect(linkLabel("A".repeat(60), 3)).toMatch(/^A{33}… · tr\. 3$/);
    const svg = strokeSvg({ ...link, link: { ...link.link!, label: 'x<y & "z"' } });
    expect(svg).toContain("x&lt;y &amp; &quot;z&quot;");
  });

  it("folds Vietnamese for standard PDF fonts", () => {
    expect(asciiFold("Động cơ · tr. 5…")).toBe("Dong co - tr. 5...");
  });
});

describe("notebook export", () => {
  it("creates blank ruled pages with ink and link chips", async () => {
    const ink = new InkModel(new Map(), { savePage: async () => {} }, 0);
    ink.add(1, { id: "p", tool: "pen", color: "#1d2430", width: 1.6, points: [80, 100, 200, 140] });
    ink.add(1, link);
    const all = buildNotebookJobs(3, { width: 595, height: 842 }, "grid", ink, "all");
    const out = await exportAnnotatedPdf({ bytes: null, blank: all.blank, jobs: all.jobs, keepPages: all.keepPages, title: "Vở M15" });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe("Vở M15 (ghi chú)");
    const some = buildNotebookJobs(3, { width: 595, height: 842 }, "lines", ink, "annotated");
    const out2 = await exportAnnotatedPdf({ bytes: null, blank: some.blank, jobs: some.jobs, keepPages: some.keepPages, title: "x" });
    expect((await PDFDocument.load(out2)).getPageCount()).toBe(1);
  });
});
