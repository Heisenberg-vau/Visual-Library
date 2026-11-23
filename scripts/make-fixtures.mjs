// Generates the PDFs used by the automated tests (not committed).
//   node scripts/make-fixtures.mjs            -> small + 650-page book
//   node scripts/make-fixtures.mjs --heavy    -> also a ~200 MB scan-like PDF
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  PDFDocument, PDFName, PDFHexString, PDFNumber, PDFNull, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setTextRenderingMode, TextRenderingMode,
} from "pdf-lib";

const OUT = "tests/fixtures";
mkdirSync(OUT, { recursive: true });

function addOutline(doc, tree) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const outlinesRef = ctx.nextRef();
  const build = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    let total = 0;
    items.forEach((it, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of("Title"), PDFHexString.fromText(it.title));
      dict.set(PDFName.of("Parent"), parentRef);
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < items.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      dict.set(PDFName.of("Dest"), ctx.obj([pages[it.page - 1].ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]));
      if (it.children?.length) {
        const sub = build(it.children, refs[i]);
        dict.set(PDFName.of("First"), sub.refs[0]);
        dict.set(PDFName.of("Last"), sub.refs[sub.refs.length - 1]);
        dict.set(PDFName.of("Count"), PDFNumber.of(-sub.total)); // collapsed
      }
      ctx.assign(refs[i], dict);
      total += 1;
    });
    return { refs, total };
  };
  const top = build(tree, outlinesRef);
  ctx.assign(outlinesRef, ctx.obj({
    Type: "Outlines", First: top.refs[0], Last: top.refs[top.refs.length - 1], Count: PDFNumber.of(top.total),
  }));
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

async function textBook(pagesCount, file, { landscapeAt = [] } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Test book ${pagesCount} pages`);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pagesCount; i++) {
    const land = landscapeAt.includes(i);
    const page = doc.addPage(land ? [842, 595] : [595, 842]);
    const { width, height } = page.getSize();
    page.drawText(`Page ${i}`, { x: 60, y: height - 120, size: 64, font, color: rgb(0.12, 0.23, 0.37) });
    for (let l = 0; l < 30; l++) {
      page.drawText(`Line ${l + 1} of page ${i}: turbine compressor combustion nozzle bearing`, {
        x: 60, y: height - 200 - l * 18, size: 11, font: body, color: rgb(0.2, 0.2, 0.2),
      });
    }
    page.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, borderColor: rgb(0.8, 0.5, 0.2), borderWidth: 2 });
  }
  const chapters = [];
  const per = Math.floor(pagesCount / 10);
  for (let c = 0; c < 10; c++) {
    const start = c * per + 1;
    chapters.push({
      title: `Chương ${c + 1}: Động cơ tuabin khí phần ${c + 1}`,
      page: start,
      children: [1, 2, 3].map((s) => ({ title: `Mục ${c + 1}.${s}`, page: start + s * Math.floor(per / 4) })),
    });
  }
  addOutline(doc, chapters);
  writeFileSync(file, await doc.save());
  console.log("wrote", file);
}

async function heavyBook(file, targetMB = 200) {
  const doc = await PDFDocument.create();
  const W = 1600, H = 1250; // 2 MB of 8-bit grey per page, uncompressed noise
  const pages = Math.ceil((targetMB * 1024 * 1024) / (W * H));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    const data = randomBytes(W * H);
    const img = doc.context.stream(data, {
      Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8,
    });
    const ref = doc.context.register(img);
    const name = page.node.newXObject("Im", ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(515, 0, 0, 400, 40, 380), drawObject(name), popGraphicsState());
    page.drawText(`Scan page ${i}`, { x: 40, y: 300, size: 40, font });
  }
  writeFileSync(file, await doc.save({ useObjectStreams: false }));
  console.log("wrote", file, pages, "pages");
}

/** A "scanned" book: each page is only an image of printed text (no text layer). */
async function scannedBook(file) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
  const texts = [
    ["Chapter 7 Combustion", "The combustion chamber must burn a large quantity of fuel supplied through the burners.", "Flame tube cooling air enters through holes in the liner wall."],
    ["Chapter 8 Turbine", "The turbine extracts energy from the hot gas stream to drive the compressor.", "Nozzle guide vanes direct the gas onto the turbine blades."],
  ];
  const doc = await PDFDocument.create();
  for (const [title, ...lines] of texts) {
    await page.setContent(`<html><body style="margin:0;background:#fff;font-family:'DejaVu Serif',Georgia,serif;color:#111">
      <div style="padding:120px 110px"><h1 style="font-size:58px;margin:0 0 50px">${title}</h1>
      ${lines.map((l) => `<p style="font-size:34px;line-height:1.5;margin:0 0 30px">${l}</p>`).join("")}</div></body></html>`);
    const png = await page.screenshot({ type: "png" });
    const img = await doc.embedPng(png);
    const p = doc.addPage([595, 842]);
    p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  await browser.close();
  writeFileSync(file, await doc.save());
  console.log("wrote", file);
}

/**
 * Like a real broken-font PDF: the page LOOKS right (an image of the text),
 * but the selectable text layer has codes shifted by -29.
 */
async function garbledBook(file) {
  const { chromium } = await import("playwright-core");
  const lines = [
    "the combustion chamber must burn a large quantity of fuel",
    "supplied through the fuel nozzles with the air from the compressor",
    "and release the heat in such a manner that the air is expanded",
  ];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
  await page.setContent(`<html><body style="margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#111">
    <div style="position:absolute;left:104px;top:150px;font-size:27px;line-height:50px">${lines.map((l) => `<div>${l}</div>`).join("")}</div></body></html>`);
  const png = await page.screenshot({ type: "png" });
  await browser.close();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
  const shift = (t) => [...t].map((c) => (c === " " ? " " : String.fromCharCode(c.charCodeAt(0) - 29))).join("");
  p.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  lines.forEach((l, i) => p.drawText(shift(l), { x: 50, y: 760 - i * 24, size: 13, font }));
  writeFileSync(file, await doc.save());
  console.log("wrote", file);
}

await textBook(3, `${OUT}/small.pdf`);
await scannedBook(`${OUT}/scanned.pdf`);
await garbledBook(`${OUT}/garbled.pdf`);
await textBook(650, `${OUT}/book-650.pdf`, { landscapeAt: [300] });
writeFileSync(`${OUT}/fake.pdf`, "this is not a pdf at all");
if (process.argv.includes("--heavy")) await heavyBook(`${OUT}/heavy-200mb.pdf`);
