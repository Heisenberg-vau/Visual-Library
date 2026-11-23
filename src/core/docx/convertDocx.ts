import { PDFDocument } from "pdf-lib";
import { UserFacingError } from "../types";
import type { WordBox } from "../text/words";
import { paginate, type Atom } from "./paginate";

/**
 * Word (.docx) → a reading copy as PDF.
 *
 * The .docx is laid out by docx-preview inside an isolated frame, split into
 * pages at line boundaries (Word stores no pages, it paginates when it opens a
 * file; we do the same), and each page is drawn to an image. The original
 * .docx is kept untouched; everything else in the app (pen, notes, export)
 * works on the PDF copy. Word positions are captured from the layout, so the
 * copy is searchable and highlights snap to its words without OCR.
 */
export interface DocxConversion {
  pdf: Blob;
  /** Words per page, PDF points, top-left origin. */
  pageWords: WordBox[][];
  title: string | null;
}

const PX_TO_PT = 0.75;
/** Image pixels per CSS pixel: ~190 dpi, sharp on a 2.8K tablet at fit-width. */
const RASTER_SCALE = 2;

const OVERRIDES = `
.docx-wrapper{display:block!important;padding:0!important;margin:0!important;background:#fff!important}
.docx-wrapper>section.docx{margin:0!important;box-shadow:none!important}
`;

interface PageSlice {
  section: number;
  start: number;
  end: number;
}

export async function convertDocx(file: Blob, onProgress?: (f: number) => void): Promise<DocxConversion> {
  const { renderAsync } = await import("docx-preview");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-40000px;top:0;width:2400px;height:1200px;border:0;visibility:hidden;pointer-events:none";
  frame.srcdoc = "<!doctype html><html><head></head><body style=\"margin:0\"></body></html>";
  document.body.append(frame);
  try {
    await new Promise<void>((r) => frame.addEventListener("load", () => r(), { once: true }));
    const doc = frame.contentDocument!;
    const body = doc.createElement("div");
    const styles = doc.createElement("div");
    doc.head.append(styles);
    doc.body.append(body);
    try {
      await renderAsync(file, body, styles, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        renderHeaders: false,
        renderFooters: false,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderChanges: false,
        useBase64URL: true, // the page images can only use inline resources
        experimental: true,
      });
    } catch (e) {
      console.error("docx render failed", e);
      throw new UserFacingError("Không đọc được file Word này (có thể file bị hỏng).");
    }
    const override = doc.createElement("style");
    override.textContent = OVERRIDES;
    doc.head.append(override);
    await settle(doc);
    onProgress?.(0.05);

    const sections = [...body.querySelectorAll<HTMLElement>("section.docx")];
    if (!sections.length) throw new UserFacingError("File Word này không có nội dung.");
    const css = [...doc.head.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");

    // 1) Paginate every section (sections only break at explicit page breaks).
    const slices: PageSlice[] = [];
    const geo = sections.map((sec, si) => {
      const cs = doc.defaultView!.getComputedStyle(sec);
      const rect = sec.getBoundingClientRect();
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const pageH = parseFloat(cs.minHeight) || rect.height;
      const width = rect.width;
      const contentTop = rect.top + padTop;
      const atoms = collectAtoms(sec, contentTop);
      const total = Math.max(0, ...atoms.map((a) => a.bottom));
      const usable = Math.max(40, pageH - padTop - padBottom);
      const empty = atoms.length === 0;
      if (!empty || sections.length === 1) {
        for (const [start, end] of paginate(atoms, total, usable)) slices.push({ section: si, start, end });
      }
      return { el: sec, rect, padTop, pageH, width, contentTop };
    });
    if (!slices.length) slices.push({ section: 0, start: 0, end: 0 });

    // 2) Words, assigned to the page holding their middle.
    const pageWords: WordBox[][] = slices.map(() => []);
    geo.forEach((g, si) => {
      const mine = slices.map((s, i) => [s, i] as const).filter(([s]) => s.section === si);
      for (const { t, r } of collectWords(g.el)) {
        const mid = (r.top + r.bottom) / 2 - g.contentTop;
        const hit = mine.find(([s]) => mid >= s.start && mid < s.end) ?? null;
        if (!hit) continue;
        const [s, i] = hit;
        const y = g.padTop + (r.top - g.contentTop - s.start);
        pageWords[i].push({
          t,
          x: round1((r.left - g.rect.left) * PX_TO_PT),
          y: round1(y * PX_TO_PT),
          w: round1(r.width * PX_TO_PT),
          h: round1(r.height * PX_TO_PT),
        });
      }
    });

    // 3) Draw every page and assemble the PDF.
    const pdf = await PDFDocument.create();
    const serial = new XMLSerializer();
    const sectionHtml = new Map<number, string>();
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const g = geo[s.section];
      let html = sectionHtml.get(s.section);
      if (!html) {
        html = serial.serializeToString(g.el);
        sectionHtml.set(s.section, html);
      }
      const png = await drawPage(css, html, g.width, g.pageH, g.padTop, s.start, s.end);
      const img = await pdf.embedPng(png);
      const page = pdf.addPage([g.width * PX_TO_PT, g.pageH * PX_TO_PT]);
      page.drawImage(img, { x: 0, y: 0, width: g.width * PX_TO_PT, height: g.pageH * PX_TO_PT });
      onProgress?.(0.05 + (0.9 * (i + 1)) / slices.length);
    }
    const title = await docxTitle(file);
    pdf.setProducer("App đọc sách (từ Word)");
    const bytes = await pdf.save({ useObjectStreams: true });
    return { pdf: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), pageWords, title };
  } finally {
    frame.remove();
  }
}

/** The title stored in the document properties (File › Info in Word). */
async function docxTitle(file: Blob): Promise<string | null> {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(file);
    const xml = await zip.file("docProps/core.xml")?.async("string");
    if (!xml) return null;
    const t = new DOMParser().parseFromString(xml, "application/xml").getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0];
    return t?.textContent?.trim() || null;
  } catch {
    return null;
  }
}

/** Waits for fonts and images inside the frame. */
async function settle(doc: Document): Promise<void> {
  const imgs = [...doc.images].filter((i) => !i.complete);
  await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
  await doc.fonts.ready.catch(() => {});
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function collectAtoms(sec: HTMLElement, contentTop: number): Atom[] {
  const atoms: Atom[] = [];
  const doc = sec.ownerDocument;
  const walker = doc.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.height > 0 && r.width > 0) atoms.push({ top: r.top - contentTop, bottom: r.bottom - contentTop });
    }
  }
  for (const el of sec.querySelectorAll("img, svg, canvas, hr, td, th")) {
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    if (el.tagName === "TD" || el.tagName === "TH") {
      // Empty table cells still have a visible box: keep tiny rows whole.
      if (r.height < 40 && !el.textContent?.trim()) atoms.push({ top: r.top - contentTop, bottom: r.bottom - contentTop });
      continue;
    }
    atoms.push({ top: r.top - contentTop, bottom: r.bottom - contentTop });
  }
  // Empty paragraphs still take space at the end of the flow.
  const article = sec.querySelector("article");
  if (article && !atoms.length) {
    const r = article.getBoundingClientRect();
    if (r.height > 0 && article.querySelector("p")) atoms.push({ top: r.top - contentTop, bottom: r.top - contentTop + 1 });
  }
  return atoms;
}

function collectWords(sec: HTMLElement): { t: string; r: DOMRect }[] {
  const out: { t: string; r: DOMRect }[] = [];
  const doc = sec.ownerDocument;
  const walker = doc.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    for (const m of text.matchAll(/\S+/g)) {
      range.setStart(n, m.index!);
      range.setEnd(n, m.index! + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      if (rects.length === 1) out.push({ t: m[0], r: rects[0] });
      else {
        // A word split over two lines (hyphenation): index each part's box with the whole word.
        for (const r of rects) out.push({ t: m[0], r });
      }
    }
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function drawPage(css: string, sectionHtml: string, w: number, h: number, padTop: number, start: number, end: number): Promise<Uint8Array> {
  const clipH = Math.max(0, Math.min(end - start, h - padTop));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:#fff;position:relative;overflow:hidden;margin:0">` +
    `<style>${escapeXml(css)}</style>` +
    `<div style="position:absolute;left:0;top:${padTop}px;width:${w}px;height:${clipH}px;overflow:hidden">` +
    `<div style="position:absolute;left:0;top:${-(padTop + start)}px;width:${w}px"><div class="docx-wrapper">${sectionHtml}</div></div>` +
    `</div></div></foreignObject></svg>`;
  // A data: URL (not blob:) keeps the canvas exportable in Chrome.
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * RASTER_SCALE);
    canvas.height = Math.round(h * RASTER_SCALE);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    canvas.width = 0;
    if (!blob) throw new Error("page image failed");
    return new Uint8Array(await blob.arrayBuffer());
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
