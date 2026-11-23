// Generates the PDFs used by the automated tests (not committed).
//   node scripts/make-fixtures.mjs            -> small + 650-page book
//   node scripts/make-fixtures.mjs --heavy    -> also a ~200 MB scan-like PDF
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
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

/** A solid-colour PNG (no image library needed). */
function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A Word report: Vietnamese text long enough to flow over several pages
 * (Word stores no pages), a table, a picture and an explicit page break.
 */
async function wordDoc(file) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, ImageRun, PageBreak, WidthType } = await import("docx");
  const para = (i) =>
    new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: `Đoạn ${i}. Buồng đốt phải đốt cháy một lượng lớn nhiên liệu được cung cấp qua các vòi phun, cùng với không khí từ máy nén, và giải phóng nhiệt sao cho không khí giãn nở và tăng tốc thành dòng khí đều. `.repeat(3), size: 24, font: "Arial" })],
    });
  const doc = new Document({
    creator: "fixtures",
    title: "Báo cáo động cơ",
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Báo cáo động cơ phản lực", font: "Arial" })] }),
          ...Array.from({ length: 14 }, (_, i) => para(i + 1)),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [["Bộ phận", "Nhiệt độ"], ["Máy nén", "600 độ"], ["Tuabin", "1400 độ"]].map(
              (r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, font: "Arial", size: 24 })] })] })) }),
            ),
          }),
          new Paragraph({ children: [new ImageRun({ type: "png", data: solidPng(240, 120, [30, 120, 200]), transformation: { width: 240, height: 120 } })] }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Phụ lục tuabin khí", font: "Arial" })] }),
          para(99),
        ],
      },
    ],
  });
  writeFileSync(file, await Packer.toBuffer(doc));
  console.log("wrote", file);
}

await textBook(3, `${OUT}/small.pdf`);
await scannedBook(`${OUT}/scanned.pdf`);
await garbledBook(`${OUT}/garbled.pdf`);
await textBook(650, `${OUT}/book-650.pdf`, { landscapeAt: [300] });
await wordDoc(`${OUT}/bao-cao.docx`);
writeFileSync(`${OUT}/old.doc`, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...randomBytes(504)]));
writeFileSync(`${OUT}/fake.pdf`, "this is not a pdf at all");
if (process.argv.includes("--heavy")) await heavyBook(`${OUT}/heavy-200mb.pdf`);
