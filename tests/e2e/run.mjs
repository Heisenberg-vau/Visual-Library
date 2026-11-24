// End-to-end tests in real Chrome, at Xiaomi Pad 8 Pro-like size with touch.
// Usage: npm run build && npm run fixtures && npm run test:e2e
//   HEAVY=1 also runs the 200 MB file test (needs `node scripts/make-fixtures.mjs --heavy`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFName, PDFDocument } from "pdf-lib";

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const FIX = "tests/fixtures";
const SHOTS = "tests/e2e/out";
mkdirSync(SHOTS, { recursive: true });

let server, browser, context, page;

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview server did not start");
}

before(async () => {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    // software WebGL so the 3D library renders in headless/CI Chrome
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
    locale: "vi-VN",
  });
  // The older tests drive the list view; the 3D room has its own tests below.
  await context.addInitScript(() => {
    if (!localStorage.getItem("vl.home")) localStorage.setItem("vl.home", "list");
  });
  page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
  await page.goto(URL);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const cards = () => page.locator('[data-testid="book-card"]');
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

/** Fraction of non-white pixels in the canvas of a page slot. */
async function inkOf(pageNo) {
  return page.evaluate((n) => {
    const c = document.querySelector(`.page-slot[data-page="${n}"] canvas`);
    if (!c || !c.width) return -1;
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4 * 16) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) ink++;
    return ink / (d.length / (4 * 16));
  }, pageNo);
}

async function waitRendered(pageNo, timeout = 15000) {
  await page.waitForFunction(
    (n) => {
      const r = window.__reader;
      return r && r.scrollerForTests.renderedPages().includes(n);
    },
    pageNo,
    { timeout },
  );
}

const currentPage = () => page.evaluate(() => window.__reader.scrollerForTests.currentPage);

async function openBook(titlePart) {
  await cards().filter({ hasText: titlePart }).first().click();
  await page.waitForSelector('[data-testid="scroller"]');
}

async function backToShelf3d() {
  await page.click(".tb-back");
  await page.waitForSelector('[data-testid="home3d"][data-ready="1"]');
  await page.waitForTimeout(300);
}

async function backToShelf() {
  await page.click(".tb-back");
  await page.waitForSelector('[data-testid="shelf"]');
}

test("empty shelf on first start", async () => {
  await page.waitForSelector(".shelf-empty:not([hidden])");
  await shot("01-empty");
});

test("imports PDFs, rejects a fake one", async () => {
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/small.pdf`, `${FIX}/book-650.pdf`, `${FIX}/fake.pdf`]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="book-card"]').length === 2, null, { timeout: 30000 });
  await page.waitForSelector(".toast-error");
  assert.match(await page.locator(".toast-error").first().textContent(), /fake\.pdf/);
  await page.waitForSelector(".card-cover img");
  await shot("02-shelf");
});

test("re-importing the same file is detected as duplicate", async () => {
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/book-650.pdf`]);
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("đã có trên kệ")));
  assert.equal(await cards().count(), 2);
});

test("opens the 650-page book and renders page 1", async () => {
  await openBook("650");
  assert.equal(await page.textContent('[data-testid="page-total"]'), "/ 650");
  await waitRendered(1);
  assert.ok((await inkOf(1)) > 0.005, "page 1 should contain ink");
  await shot("03-reader-page1");
});

test("jumps to page 500 by number and keeps DOM small", async () => {
  await page.click('[data-testid="page-input"]');
  await page.keyboard.type("500");
  await page.keyboard.press("Enter");
  await waitRendered(500);
  assert.equal(await currentPage(), 500);
  assert.equal(await page.inputValue('[data-testid="page-input"]'), "500");
  const slots = await page.locator(".page-slot").count();
  assert.ok(slots <= 8, `only nearby pages in DOM, got ${slots}`);
  assert.ok((await inkOf(500)) > 0.005);
});

test("landscape page keeps its own shape", async () => {
  await page.click('[data-testid="page-input"]');
  await page.keyboard.type("300");
  await page.keyboard.press("Enter");
  await waitRendered(300);
  const box = await page.locator('.page-slot[data-page="300"]').boundingBox();
  assert.ok(box.width > box.height, "page 300 is landscape");
});

test("table of contents navigates to a chapter", async () => {
  await page.click(".tb-panel");
  await page.click('.tab[data-tab="outline"]');
  await page.waitForSelector(".outline-item");
  await page.locator(".outline-item", { hasText: "Chương 5" }).click();
  await waitRendered(261);
  assert.equal(await currentPage(), 261);
  // chapters start expanded; the toggle collapses and re-expands them
  const toggle = page.locator(".outline-row", { hasText: "Chương 5" }).locator(".outline-toggle");
  await toggle.click();
  assert.equal(await page.locator(".outline-item", { hasText: "Mục 5.2" }).isVisible(), false);
  await toggle.click();
  await page.locator(".outline-item", { hasText: "Mục 5.2" }).click();
  assert.equal(await currentPage(), 261 + 2 * 16);
  await shot("04-outline");
});

test("thumbnails show the current page and navigate", async () => {
  try {

  await page.click('.tab[data-tab="thumbs"]');
  await page.waitForSelector(".thumb.current .thumb-canvas", { timeout: 30000 }); // queued behind full-resolution page renders
  await page.waitForFunction(() => Number(document.querySelector(".thumb.current")?.dataset.page) === window.__reader.scrollerForTests.currentPage, null, { timeout: 5000 });
  const target = page.locator(".thumb").filter({ has: page.locator(".thumb-canvas") }).last();
  const n = Number(await target.getAttribute("data-page"));
  await target.click();
  await page.waitForFunction((k) => window.__reader.scrollerForTests.currentPage === k, n, { timeout: 5000 });
  await shot("05-thumbs");
  await page.click(".tb-panel");
  } catch (e) {
    const diag = await page.evaluate(() => ({
      current: window.__reader?.scrollerForTests.currentPage,
      thumbCurrent: document.querySelector(".thumb.current")?.dataset.page,
      thumbs: [...document.querySelectorAll(".thumb")].map((t) => t.dataset.page + (t.querySelector("canvas") ? "c" : "")).join(","),
      sidebar: document.querySelector(".sidebar") && getComputedStyle(document.querySelector(".sidebar")).display,
      thumbsHidden: document.querySelector(".thumbs")?.hidden,
      scrollTop: document.querySelector(".thumbs")?.scrollTop,
    }));
    console.log("THUMB DIAG", JSON.stringify(diag));
    await shot("fail-thumbs");
    throw e;
  }
});

test("zoom buttons and pinch zoom", async () => {
  await page.click('[data-testid="zoom-label"]'); // fit width
  assert.equal(await page.textContent('[data-testid="zoom-label"]'), "100%");
  await page.click('button[aria-label="Phóng to"]');
  assert.equal(await page.textContent('[data-testid="zoom-label"]'), "120%");
  const before = await currentPage();

  // Two-finger pinch-out through the DevTools protocol.
  const cdp = await context.newCDPSession(page);
  const box = await page.locator('[data-testid="scroller"]').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const pts = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(60) });
  for (let d = 70; d <= 150; d += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const z = parseInt(await page.textContent('[data-testid="zoom-label"]'), 10);
  assert.ok(z >= 250 && z <= 320, `pinch zoom ~2.5x of 120%, got ${z}%`);
  assert.ok(Math.abs((await currentPage()) - before) <= 1, "pinch keeps you on the same page");
  await page.waitForTimeout(800);
  await shot("06-zoomed");
  await page.click('[data-testid="zoom-label"]');
});

test("remembers the reading position", async () => {
  await page.click('[data-testid="page-input"]');
  await page.keyboard.type("123");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000); // debounce save
  await backToShelf();
  assert.match(await cards().filter({ hasText: "650" }).textContent(), /trang 123/i);
  await openBook("650");
  await waitRendered(123);
  assert.equal(await currentPage(), 123);
});

test("reload while reading reopens the book; back returns to shelf", async () => {
  await page.reload();
  await page.waitForSelector('[data-testid="scroller"]');
  await waitRendered(123);
  await page.goBack();
  await page.waitForSelector('[data-testid="shelf"]');
});

// ---- milestone 3: handwriting (stylus simulated through DevTools) ----

let cdpSession;
async function cdp() {
  cdpSession ??= await context.newCDPSession(page);
  return cdpSession;
}
/** Draws with a simulated pen. pts are [x, y] fractions of the page slot box. */
const BOOK = ".reader-main > .pages-scroller:first-child";
const NB = ".nb-pane";
async function penStroke(pageNo, pts, opts = {}) {
  const c = await cdp();
  const box = await page.locator(`${opts.root ?? BOOK} .page-slot[data-page="${pageNo}"]`).boundingBox();
  const at = ([fx, fy]) => ({ x: box.x + fx * box.width, y: box.y + fy * box.height });
  const pointerType = opts.pointerType ?? "pen";
  const steps = [];
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k < 8; k++) {
      const t = k / 8;
      steps.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    }
  }
  steps.push(pts[pts.length - 1]);
  const first = at(steps[0]);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...first, button: "left", buttons: 1, clickCount: 1, pointerType });
  for (const p of steps.slice(1)) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(p), button: "left", buttons: 1, pointerType });
  }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(steps[steps.length - 1]), button: "left", buttons: 0, clickCount: 1, pointerType });
  await page.evaluate(() => window.__reader?.inkLayerForTests.settled());
}
const strokesOn = (pageNo) => page.evaluate((n) => window.__reader.inkForTests.strokes(n - 1).map((s) => ({ tool: s.tool, n: s.points.length, points: s.points, rects: s.rects })), pageNo);
/** Amount of drawn ink (SVG path data length) on a page. */
const inkPixels = (pageNo) => page.evaluate((n) => {
  let len = 0;
  for (const p of document.querySelectorAll(`.page-slot[data-page="${n}"] .ink-svg path`)) len += (p.getAttribute("d") || "").length;
  return len;
}, pageNo);
const settled = () => page.evaluate(() => window.__reader.inkLayerForTests.settled());
async function gotoPage(n) {
  await page.click('[data-testid="page-input"]');
  await page.keyboard.type(String(n));
  await page.keyboard.press("Enter");
  await waitRendered(n);
}
async function tool(name) {
  await page.click(`[data-testid="tools"] [data-tool="${name}"]`);
}

test("milestone 3: pen writes on the page, finger still scrolls", async () => {
  await openBook("650");
  await gotoPage(10);
  await tool("pen");
  await penStroke(10, [[0.2, 0.3], [0.4, 0.35], [0.6, 0.3], [0.7, 0.4]]);
  const s = await strokesOn(10);
  assert.equal(s.length, 1);
  assert.equal(s[0].tool, "pen");
  assert.ok(s[0].n >= 6, "freehand keeps its shape");
  assert.ok((await inkPixels(10)) > 50, "ink is visible");

  // A single finger drag scrolls and does not draw (after the 250 ms palm guard).
  await page.waitForTimeout(400);
  const c = await cdp();
  const box = await page.locator('[data-testid="scroller"]').boundingBox();
  const before = await page.evaluate(() => document.querySelector('[data-testid="scroller"]').scrollTop);
  const x = box.x + box.width / 2;
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + 600 }] });
  for (let y = 590; y >= 300; y -= 10) await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + y }] });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector('[data-testid="scroller"]').scrollTop);
  assert.ok(after > before + 100, `finger scrolled (${before} -> ${after})`);
  assert.equal((await strokesOn(10)).length, 1);
  await gotoPage(10);
});

test("milestone 3: hand tool lets the pen scroll instead of writing", async () => {
  await tool("hand");
  await page.waitForTimeout(400);
  await penStroke(10, [[0.5, 0.5], [0.55, 0.6]]);
  assert.equal((await strokesOn(10)).length, 1);
  await tool("pen");
  await gotoPage(10); // the pen may have scrolled the page, as intended
});

test("milestone 3: highlighter straightens, underline is a straight line", async () => {
  await tool("highlighter");
  await penStroke(10, [[0.5, 0.15], [0.65, 0.151], [0.8, 0.149]]);
  await tool("underline");
  await penStroke(10, [[0.5, 0.2], [0.65, 0.203], [0.8, 0.201]]);
  const s = await strokesOn(10);
  const hl = s.find((x) => x.tool === "highlighter");
  const ul = s.find((x) => x.tool === "underline");
  assert.equal(hl.n, 4, "highlight became one straight segment");
  assert.equal(ul.n, 4);
  assert.equal(ul.points[1], ul.points[3], "underline snapped horizontal");
  await shot("09-ink");
});

test("milestone 3: eraser removes strokes; undo and redo", async () => {
  await tool("eraser");
  await penStroke(10, [[0.3, 0.1], [0.3, 0.38]]); // crosses the pen stroke only
  let s = await strokesOn(10);
  assert.deepEqual(s.map((x) => x.tool).sort(), ["highlighter", "underline"]);
  await page.click('[data-testid="undo"]');
  s = await strokesOn(10);
  assert.equal(s.length, 3);
  assert.equal(s[0].tool, "pen", "erased stroke comes back in its original order");
  await page.click('[data-testid="redo"]');
  assert.equal((await strokesOn(10)).length, 2);
  await page.click('[data-testid="undo"]');
  assert.equal((await strokesOn(10)).length, 3);
  await tool("pen");
});

test("v0.3.1: highlight snaps to the characters of the line, even when drawn slanted", async () => {
  await gotoPage(11);
  await tool("highlighter");
  // Fixture text: 11pt lines with baselines at 200, 218, 236 pt from the top, starting at x=60.
  // Slanted stroke across "Line 1 ..." (fractions of a 595 x 842 pt page).
  await penStroke(11, [[0.15, 0.231], [0.35, 0.236], [0.55, 0.243]]);
  const [hl] = await strokesOn(11);
  assert.ok(hl.rects, "stored as text rectangles");
  assert.equal(hl.rects.length, 4, "one line only");
  const [x, y, w, h] = hl.rects;
  assert.ok(Math.abs(y - (200 - 11 * 0.82)) < 0.6, `top at the ascent line, got ${y}`);
  assert.ok(Math.abs(h - 11 * 1.02) < 0.6, `height of the text line, got ${h}`);
  assert.ok(x <= 0.15 * 595 + 6 && x + w >= 0.55 * 595 - 6, `spans the dragged characters (${x}..${x + w})`);
});

test("v0.3.1: underline sits the same distance under the text wherever the pen is", async () => {
  await tool("underline");
  await penStroke(11, [[0.15, 224 / 842], [0.5, 224 / 842]]); // ~6pt under line 2 (baseline 218)
  await penStroke(11, [[0.15, 265 / 842], [0.5, 265 / 842]]); // ~11pt under line 4 (baseline 254)
  const uls = (await strokesOn(11)).filter((s) => s.tool === "underline");
  assert.equal(uls.length, 2);
  const off1 = uls[0].points[1] - 218;
  const off2 = uls[1].points[1] - 254;
  assert.ok(Math.abs(off1 - off2) < 0.05, `same offset (${off1} vs ${off2})`);
  assert.ok(off1 > 0.5 && off1 < 3, `just under the baseline, got ${off1}`);
  await shot("11-text-snap");
  await tool("pen");
  await gotoPage(10);
});

test("milestone 3: ink stays sharp after zoom and survives reopening", async () => {
  await page.click('button[aria-label="Phóng to"]');
  await waitRendered(10);
  assert.ok((await inkPixels(10)) > 50);
  await page.click('[data-testid="zoom-label"]');
  await page.waitForTimeout(1000);
  await backToShelf();
  await openBook("650");
  await waitRendered(10);
  assert.equal((await strokesOn(10)).length, 3);
  assert.ok((await inkPixels(10)) > 50);
});

test("milestone 3: widened margin gives space to write beside the page", async () => {
  const before = await page.locator('.page-slot[data-page="10"]').boundingBox();
  await page.click('[data-testid="margin-btn"]');
  await page.locator(".menu-item", { hasText: "Lề phải rộng 30%" }).click();
  await gotoPage(10);
  const after = await page.locator('.page-slot[data-page="10"]').boundingBox();
  assert.ok(after.width / after.height > (before.width / before.height) * 1.25, "slot is wider than the page");
  await penStroke(10, [[0.85, 0.3], [0.9, 0.35], [0.95, 0.3]]);
  const s = await strokesOn(10);
  const margin = s[s.length - 1];
  assert.ok(margin.points[0] > 595, `stroke sits right of the page edge (x=${margin.points[0]})`);
  assert.equal(await page.getAttribute('.page-slot[data-page="10"]', "data-pattern"), "lines");
  await page.click('[data-testid="margin-btn"]');
  await page.locator(".menu-item", { hasText: "Nền lề: ô vuông" }).click();
  assert.equal(await page.getAttribute('.page-slot[data-page="10"]', "data-pattern"), "grid");
  await shot("10-margin");
  await backToShelf();
  await openBook("650");
  await waitRendered(10);
  const again = await page.locator('.page-slot[data-page="10"]').boundingBox();
  assert.ok(again.width / again.height > 0.9, "margin setting remembered");
  await page.click('[data-testid="margin-btn"]');
  await page.locator(".menu-item", { hasText: "Không nới lề" }).click();
  await backToShelf();
});

// ---- milestone 4: export an annotated copy ----

async function exportVia(scopeLabel) {
  await page.click('[data-testid="export-btn"]');
  await page.waitForSelector('[data-testid="export-dialog"]');
  await page.locator('[data-testid="export-dialog"] .radio', { hasText: scopeLabel }).click();
  const t0 = Date.now();
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-save"]', { timeout: 120000 });
  const ms = Date.now() - t0;
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-save"]')]);
  const path = `${SHOTS}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  await page.locator('[data-testid="export-dialog"] .btn', { hasText: "Đóng" }).click();
  return { path, ms, name: dl.suggestedFilename() };
}

test("milestone 4: export only annotated pages to a new PDF", async () => {
  await openBook("650");
  const { path, ms, name } = await exportVia("Chỉ các trang có ghi chú");
  assert.equal(name, "Test book 650 pages (ghi chu).pdf");
  const doc = await PDFDocument.load(readFileSync(path));
  assert.equal(doc.getPageCount(), 2, "pages 10 and 11");
  const p10 = doc.getPage(0).getMediaBox();
  const p11 = doc.getPage(1).getMediaBox();
  assert.ok(p10.width > 595 + 20, `page with a margin note is widened (${p10.width})`);
  assert.equal(p11.width, 595);
  console.log(`  export (2 pages of 650): ${ms} ms`);
});

test("milestone 4: the original stored copy is byte-for-byte unchanged", async () => {
  await backToShelf();
  const id = await cards().filter({ hasText: "650" }).first().getAttribute("data-id");
  const stored = await page.evaluate(async (bookId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("originals");
    const f = await (await dir.getFileHandle(bookId)).getFile();
    const d = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, id);
  const fixture = createHash("sha256").update(readFileSync(`${FIX}/book-650.pdf`)).digest("hex");
  assert.equal(stored, fixture);
});

test("milestone 4: whole-document export, then the result opens with the notes baked in", async () => {
  await openBook("650");
  const { path, ms } = await exportVia("Toàn bộ tài liệu");
  const doc = await PDFDocument.load(readFileSync(path));
  assert.equal(doc.getPageCount(), 650);
  console.log(`  export (all 650 pages): ${ms} ms`);
  await backToShelf();
  await page.setInputFiles('[data-testid="file-input"]', [path]);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("ghi chú")), null, { timeout: 60000 });
  await cards().filter({ hasText: "ghi chú" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  await gotoPage(11);
  await page.waitForTimeout(500);
  await shot("12-exported-page11");
  await gotoPage(10);
  await page.waitForTimeout(500);
  await shot("13-exported-page10");
  // The exported book has no app-side ink: everything is inside the PDF now.
  assert.equal((await strokesOn(10)).length, 0);
  assert.ok((await inkOf(10)) > 0.005);
  const box = await page.locator('.page-slot[data-page="10"]').boundingBox();
  const box9 = await page.locator('.page-slot[data-page="9"]').boundingBox();
  assert.ok(box.width > box9.width * 1.2, "page with a margin note is wider in the exported file");
  await backToShelf();
  await cards().filter({ hasText: "ghi chú" }).locator(".card-more").click();
  await page.locator(".menu-item", { hasText: "Xóa" }).click();
  await page.locator(".modal .btn-primary").click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("ghi chú")));
});

// ---- milestone 5: notebooks and split view ----

const nbStrokes = (pageNo) => page.evaluate((n) => window.__reader.notebookPaneForTests.inkModel.strokes(n - 1).map((s) => ({ tool: s.tool, link: s.link, rects: s.rects })), pageNo);

test("milestone 5: create a notebook; it grows when you write on the last page", async () => {
  await page.click('[data-testid="new-notebook"]');
  await prompt("Vở M15 – Động cơ");
  await page.waitForSelector('[data-testid="scroller"]');
  assert.equal(await page.textContent('[data-testid="page-total"]'), "/ 2");
  await gotoPage(2);
  await tool("pen");
  await penStroke(2, [[0.2, 0.15], [0.5, 0.2], [0.7, 0.15]]);
  await page.waitForFunction(() => document.querySelector('[data-testid="page-total"]').textContent === "/ 3");
  await shot("14-notebook");
  // v0.9.1: no toolbar buttons; "+" in the gap under a page inserts right there
  assert.equal(await page.locator('[data-testid="add-page"], [data-testid="del-page"]').count(), 0, "no page buttons in the toolbar");
  await gotoPage(1);
  await page.click('.page-slot[data-page="1"] [data-testid="gap-add"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="page-total"]').textContent === "/ 4");
  assert.equal(await currentPage(), 2);
  assert.equal((await strokesOn(2)).length, 0, "new page is blank");
  assert.equal((await strokesOn(3)).length, 1, "old page 2 moved to page 3");
  // v0.9.2: nothing but writing on the page itself; delete from the page menu (thumbnails).
  assert.equal(await page.locator('.page-slot [data-testid="page-del"]').count(), 0, "no delete button on pages");
  await page.click(".tb-panel");
  await page.click('.tab[data-tab="thumbs"]');
  await page.click('.thumb[data-page="2"] [data-testid="thumb-more"]');
  await page.locator(".menu-item", { hasText: "Xóa trang 2" }).click();
  await page.waitForSelector('.page-slot[data-page="2"].deleting');
  assert.equal(await page.locator(".page-slot.deleting").count(), 1, "only the chosen page is marked");
  assert.match(await page.textContent(".modal"), /Xóa trang 2\?/);
  await shot("29-delete-page");
  await page.locator(".modal .btn", { hasText: "Xóa trang" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="page-total"]').textContent === "/ 3");
  assert.equal(await page.locator(".page-slot.deleting").count(), 0);
  assert.equal((await strokesOn(2)).length, 1);
  // Deleting a written page, then "Hoàn tác" brings it back with its writing.
  await page.click('.thumb[data-page="2"] [data-testid="thumb-more"]');
  await page.locator(".menu-item", { hasText: "Xóa trang 2" }).click();
  await page.locator(".modal .btn", { hasText: "Xóa trang" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="page-total"]').textContent === "/ 2");
  await page.locator('[data-testid="toast-action"]').last().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="page-total"]').textContent === "/ 3");
  assert.equal((await strokesOn(2)).length, 1, "writing restored");
  // cancel keeps a page
  await page.click('.thumb[data-page="2"] [data-testid="thumb-more"]');
  await page.locator(".menu-item", { hasText: "Xóa trang 2" }).click();
  await page.locator(".modal .btn", { hasText: "Hủy" }).click();
  assert.equal(await page.textContent('[data-testid="page-total"]'), "/ 3");
  await page.click(".tb-panel");
  await backToShelf();
  assert.match(await cards().filter({ hasText: "Vở M15" }).textContent(), /Vở · 3 trang/);
});

test("milestone 5: open the notebook beside a book (split view)", async () => {
  await openBook("650");
  await page.click('[data-testid="nb-btn"]');
  await page.locator('[data-testid="nb-choice"]', { hasText: "Vở M15" }).click();
  await page.waitForSelector(`${NB} .page-slot[data-page="1"] canvas`);
  const book = await page.locator(BOOK).boundingBox();
  const nb = await page.locator(`${NB} .pages-scroller`).boundingBox();
  assert.ok(Math.abs(book.width - nb.width) < 30, `50/50 by default (${book.width} vs ${nb.width})`);
  assert.ok(nb.x > book.x + book.width - 5, "notebook on the right in landscape");
});

test("milestone 5: pin the current book page into the notebook, tap it to jump back", async () => {
  await gotoPage(123);
  await page.evaluate(() => window.__reader.notebookPaneForTests.scroller.goToPage(1));
  await page.waitForSelector(`${NB} .page-slot[data-page="1"] canvas`);
  await page.click('[data-testid="nb-link"]');
  await penStroke(1, [[0.3, 0.12], [0.3, 0.12]], { root: NB });
  const [link] = (await nbStrokes(1)).filter((s) => s.tool === "link");
  assert.ok(link, "link tag placed");
  assert.equal(link.link.page, 123);
  assert.match(link.link.label, /tr\. 123$/);
  await gotoPage(5);
  // Finger tap on the tag
  const slot = await page.locator(`${NB} .page-slot[data-page="1"]`).boundingBox();
  const k = slot.width / 595;
  const x = slot.x + (link.rects[0] + link.rects[2] / 2) * k;
  const y = slot.y + (link.rects[1] + link.rects[3] / 2) * k;
  const c = await cdp();
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => window.__reader.scrollerForTests.currentPage === 123, null, { timeout: 5000 });
  await shot("15-split-link");
});

test("milestone 5: undo acts on the pane you last wrote in", async () => {
  const bookBefore = (await strokesOn(123)).length;
  await penStroke(1, [[0.2, 0.4], [0.6, 0.45]], { root: NB });
  const nbCount = (await nbStrokes(1)).length;
  await page.click('[data-testid="undo"]');
  assert.equal((await nbStrokes(1)).length, nbCount - 1);
  assert.equal((await strokesOn(123)).length, bookBefore);
});

test("milestone 5: the divider resizes the panes and is remembered", async () => {
  const d = await page.locator('[data-testid="divider"]').boundingBox();
  const c = await cdp();
  const y = d.y + d.height / 2;
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: d.x + d.width / 2, y, button: "left", buttons: 1, clickCount: 1 });
  for (let x = d.x; x >= 450; x -= 40) await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 450, y, button: "left", buttons: 1 });
  assert.ok(await page.evaluate(() => document.querySelector('[data-testid="divider"]').classList.contains("dragging")), "divider lights up while dragged");
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 450, y, button: "left", buttons: 0, clickCount: 1 });
  const book = await page.locator(BOOK).boundingBox();
  assert.ok(Math.abs(book.width - 450) < 30, `book pane now ~450px (${book.width})`);
  await backToShelf();
  await openBook("650");
  await page.waitForSelector(NB);
  const again = await page.locator(BOOK).boundingBox();
  assert.ok(Math.abs(again.width - book.width) < 5, "notebook reopened beside the book with the same split");
  await page.click('[data-testid="nb-close"]');
  await page.waitForFunction(() => !document.querySelector(".nb-pane"));
  await backToShelf();
});

test("milestone 5: a link inside a full-screen notebook opens the book beside it", async () => {
  await cards().filter({ hasText: "Vở M15" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  await gotoPage(1);
  await page.waitForTimeout(300);
  const link = await page.evaluate(() => window.__reader.inkForTests.strokes(0).find((s) => s.tool === "link"));
  const slot = await page.locator(`${BOOK} .page-slot[data-page="1"]`).boundingBox();
  const k = slot.width / 595;
  const c = await cdp();
  const x = slot.x + (link.rects[0] + link.rects[2] / 2) * k;
  const y = slot.y + (link.rects[1] + link.rects[3] / 2) * k;
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => document.querySelector(".reader-title")?.textContent.includes("650") && document.querySelector(".nb-pane"), null, { timeout: 10000 });
  await waitRendered(123);
  assert.equal(await currentPage(), 123);
  await page.click('[data-testid="nb-close"]');
  await backToShelf();
});

test("milestone 5: export a notebook to PDF", async () => {
  await cards().filter({ hasText: "Vở M15" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  const { path, name } = await exportVia("Toàn bộ");
  assert.equal(name, "Vo M15 - Dong co (ghi chu).pdf");
  const doc = await PDFDocument.load(readFileSync(path));
  assert.equal(doc.getPageCount(), 3);
  await backToShelf();
});

// ---- milestone 6: study experience ----

const todayKey = () => page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
async function addTask({ title, kind = "task", date, book, pageNo }) {
  await page.click('[data-testid="add-task"]');
  await page.fill('[data-testid="task-title"]', title);
  await page.selectOption('[data-testid="task-kind"]', kind);
  if (date !== undefined) await page.fill('[data-testid="task-date"]', date);
  if (book) await page.selectOption('[data-testid="task-book"]', { label: book });
  if (pageNo) await page.fill('[data-testid="task-page"]', String(pageNo));
  await page.click('[data-testid="task-save"]');
  await page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="task"]')].some((e) => e.textContent.includes(t)) || [...document.querySelectorAll('[data-testid="deadline"]')].some((e) => e.textContent.includes(t)), title);
}

test("milestone 6: plan tasks and a deadline with a countdown", async () => {
  await page.click('[data-testid="planner-btn"]');
  await page.waitForSelector('[data-testid="planner"]');
  const today = await todayKey();
  const in3 = await page.evaluate((t) => { const [y, m, d] = t.split("-").map(Number); const x = new Date(y, m - 1, d + 3); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }, today);
  await addTask({ title: "Ôn chương 12 Rolls-Royce", date: today, book: "Test book 650 pages", pageNo: 77 });
  await addTask({ title: "Thi M11", kind: "deadline", date: in3 });
  assert.match(await page.textContent('[data-testid="deadline"]'), /còn 3 ngày.*Thi M11/);
  await page.click('.tab[data-tab="week"]');
  assert.equal(await page.locator(".day-col").count(), 7);
  assert.ok(await page.locator(".day-col.is-today").textContent().then((t) => t.includes("Ôn chương 12")));
  await shot("16-planner-week");
  await page.click('.tab[data-tab="today"]');
  await shot("17-planner-today");
  await page.goBack();
  await page.waitForSelector('[data-testid="shelf"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="planner-badge"]')?.textContent === "1", null, { timeout: 5000 });
});

test("milestone 6: a task opens its book at the planned page", async () => {
  await page.click('[data-testid="planner-btn"]');
  await page.locator('[data-testid="task"]', { hasText: "Ôn chương 12" }).locator('[data-testid="task-open"]').click();
  await page.waitForSelector('[data-testid="scroller"]');
  await waitRendered(77);
  assert.equal(await currentPage(), 77);
});

test("milestone 6: study timer suggests a break and never forces it", async () => {
  await page.click('.reader-toolbar [data-testid="timer-chip"]');
  await page.click('[data-testid="timer-start"]');
  await page.mouse.click(5, 400); // close the panel
  assert.equal(await page.getAttribute('.reader-toolbar [data-testid="timer-chip"]', "data-phase"), "focus");
  await page.evaluate(() => window.__app.study.debugAdvance(25 * 60_000));
  await page.waitForSelector('[data-testid="break-suggest"]');
  await shot("18-break-suggest");
  await page.click('[data-testid="plus10"]'); // keep studying 10 more minutes
  assert.equal(await page.getAttribute('.reader-toolbar [data-testid="timer-chip"]', "data-phase"), "focus");
  await page.evaluate(() => window.__app.study.debugAdvance(10 * 60_000));
  await page.waitForSelector('[data-testid="break-suggest"]');
  await page.click('[data-testid="take-break"]');
  assert.equal(await page.getAttribute('.reader-toolbar [data-testid="timer-chip"]', "data-phase"), "break");
  await page.evaluate(() => window.__app.study.debugAdvance(5 * 60_000));
  await page.waitForSelector('[data-testid="break-over"]');
  await page.locator('[data-testid="break-over"] .btn', { hasText: "Để sau" }).click();
  assert.equal(await page.getAttribute('.reader-toolbar [data-testid="timer-chip"]', "data-phase"), "idle");
  await page.click('.reader-toolbar [data-testid="timer-chip"]');
  const total = await page.textContent('[data-testid="today-total"]');
  assert.match(total, /Hôm nay đã học: 3\d phút/, total);
  await page.mouse.click(5, 400);
});

test("milestone 6: paper tone, dimming and relaxing sound", async () => {
  await page.click('.reader-toolbar [data-testid="ambience-btn"]');
  await page.click('[data-testid="amb-tone"] [data-value="sepia"]');
  assert.equal(await page.evaluate(() => document.body.dataset.tone), "sepia");
  await page.locator('[data-testid="amb-warm"]').fill("0.3");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".amb-warm")).opacity === "0.3"); // after the fade
  await page.click('[data-testid="amb-sound"] [data-value="rain"]');
  await page.waitForTimeout(300);
  await shot("19-ambience");
  await page.click('[data-testid="amb-sound"] [data-value="off"]');
  await page.click('[data-testid="amb-tone"] [data-value="white"]');
  await page.locator('[data-testid="amb-warm"]').fill("0");
  await page.mouse.click(5, 400);
});

test("milestone 6: focus mode hides the chrome; back gesture leaves it, not the book", async () => {
  await page.click('[data-testid="focus-btn"]');
  await page.waitForSelector('.reader.focus [data-testid="focus-pill"]');
  assert.equal(await page.isVisible(".reader-toolbar"), false);
  await shot("20-focus");
  await page.goBack(); // Android back gesture
  await page.waitForFunction(() => !document.querySelector(".reader.focus"));
  assert.ok(await page.isVisible('[data-testid="scroller"]'), "still reading");
  await page.click('[data-testid="focus-btn"]');
  await page.waitForSelector(".reader.focus");
  await page.click('[data-testid="focus-exit"]');
  await page.waitForFunction(() => !document.querySelector(".reader.focus"));
  await page.waitForTimeout(300);
  assert.ok(await page.isVisible('[data-testid="scroller"]'), "exit button keeps you in the book");
  await backToShelf();
});

// ---- v0.6.1: real reading progress, goal, favorites, bookmarks, recurring tasks ----

test("v0.6.1: progress counts pages actually read, in any order", async () => {
  await page.evaluate(() => (window.__dwellMs = 300));
  await openBook("650");
  const before = await page.evaluate(async () => {
    const id = window.__reader.inkForTests && document.querySelector(".reader-title").textContent;
    return id;
  });
  void before;
  for (const n of [400, 401, 402, 200, 401]) {
    await gotoPage(n);
    await page.waitForTimeout(600);
  }
  await backToShelf();
  const text = await cards().filter({ hasText: "650" }).first().locator('[data-testid="read-progress"]').textContent();
  const m = text.match(/Đã đọc (\d+)% · (\d+)\/650 trang/);
  assert.ok(m, text);
  assert.ok(Number(m[2]) >= 4, "pages 200, 400, 401, 402 counted once each");
  const lit = await cards().filter({ hasText: "650" }).first().locator('[data-testid="read-strip"] span').evaluateAll((els) => els.filter((e) => Number(e.style.opacity) > 0).length);
  assert.ok(lit >= 2, "the strip shows where you read");
});

test("v0.6.1: optional daily goal ring", async () => {
  await page.click('[data-testid="goal-ring"]');
  await page.selectOption('[data-testid="goal-kind"]', "pages");
  await page.fill('[data-testid="goal-target"]', "3");
  await page.click('[data-testid="goal-save"]');
  await page.waitForFunction(() => /\d+\/3 trang/.test(document.querySelector('[data-testid="goal-ring"]').textContent));
  assert.equal(await page.getAttribute('[data-testid="goal-ring"]', "data-state"), "done", "4 pages read today >= 3");
});

test("v0.6.1: starred books come first and have their own view", async () => {
  const small = cards().filter({ hasText: "3 pages" });
  await small.locator('[data-testid="star"]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="book-card"]').textContent.includes("3 pages"));
  await page.click('[data-testid="view-favorites"]');
  assert.equal(await cards().count(), 1);
  await shot("21-favorites");
  await page.click('[data-testid="view-all"]');
});

test("v0.6.1: bookmark pages and jump back from the list", async () => {
  await openBook("650");
  await gotoPage(42);
  await page.click('[data-testid="bookmark-btn"]');
  assert.equal(await page.getAttribute('[data-testid="bookmark-btn"]', "aria-pressed"), "true");
  await gotoPage(300);
  await page.click(".tb-panel");
  await page.click('.tab[data-tab="marks"]');
  await page.locator('[data-testid="marks"] .outline-item', { hasText: "Trang 42" }).click();
  await waitRendered(42);
  assert.equal(await currentPage(), 42);
  await page.click(".tb-panel");
  await backToShelf();
  await openBook("650");
  await page.click(".tb-panel");
  await page.click('.tab[data-tab="marks"]');
  assert.equal(await page.locator('[data-testid="marks"] .outline-item').count(), 1, "remembered");
  await page.click(".tb-panel");
  await backToShelf();
});

test("v0.6.1: a recurring task comes back after you tick it", async () => {
  await page.click('[data-testid="planner-btn"]');
  await page.click('[data-testid="add-task"]');
  await page.fill('[data-testid="task-title"]', "Ôn 30 từ HSK");
  await page.selectOption('[data-testid="task-repeat"]', "daily");
  await page.click('[data-testid="task-save"]');
  const row = page.locator('[data-testid="task"]', { hasText: "Ôn 30 từ HSK" });
  await row.first().waitFor();
  assert.match(await row.first().textContent(), /Hằng ngày/);
  await row.first().locator('[data-testid="task-check"]').check();
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Lần tới: Ngày mai")));
  await page.click('.tab[data-tab="all"]');
  const open = page.locator('[data-testid="task"]:not(.done)', { hasText: "Ôn 30 từ HSK" });
  assert.equal(await open.count(), 1, "next occurrence is waiting");
  assert.match(await open.textContent(), /Ngày mai/);
  await page.goBack();
  await page.waitForSelector('[data-testid="shelf"]');
});

// ---- milestone 7: search, broken encodings, OCR ----

async function openSearch() {
  if (!(await page.isVisible('[data-testid="sidebar"]'))) await page.click(".tb-panel");
  await page.click('.tab[data-tab="search"]');
}
async function searchFor(q) {
  await page.fill('[data-testid="doc-search"]', q);
  await page.press('[data-testid="doc-search"]', "Enter");
}

test("milestone 7: search the whole book and jump to the hit", async () => {
  await openBook("650");
  await openSearch();
  await page.waitForFunction(() => /sẵn sàng tìm trong 650/.test(document.querySelector('[data-testid="index-status"]').textContent), null, { timeout: 60000 });
  await searchFor("line 7 of PAGE 123");
  await page.waitForSelector('[data-testid="search-result"]');
  assert.equal(await page.locator('[data-testid="search-result"]').count(), 1);
  await waitRendered(123);
  assert.equal(await currentPage(), 123);
  assert.ok(await page.locator('.page-slot[data-page="123"] .search-hit').count() >= 1, "hit outlined on the page");
  await shot("22-search");
  await page.click(".tb-panel");
  await backToShelf();
});

test("milestone 7: a PDF with a broken font encoding is repaired, then OCR'd to be sure", async () => {
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/garbled.pdf`]);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("garbled")));
  const id = await cards().filter({ hasText: "garbled" }).getAttribute("data-id");
  // OCR starts by itself after import, without opening the book.
  await page.waitForFunction((bid) => { const s = window.__app.index.statusOf(bid); return s && s.ocrTotal === 1 && s.ocrDone === 1; }, id, { timeout: 120000 });
  await cards().filter({ hasText: "garbled" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  await openSearch();
  await searchFor("combustion chamber");
  await page.waitForSelector('[data-testid="search-result"]');
  assert.match(await page.textContent('[data-testid="search-result"]'), /combustion chamber/i);
  await page.click(".tb-panel");
  await backToShelf();
});

test("milestone 7: scanned pages are OCR'd in the background, then searchable and highlightable", async () => {
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/scanned.pdf`]);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("scanned")));
  const t0 = Date.now();
  // Progress shows on the cover while OCR runs in the background, then disappears.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("scanned") && /OCR/.test(c.querySelector('[data-testid="ocr-status"]')?.textContent ?? "")), null, { timeout: 60000 });
  await page.waitForFunction(() => { const c = [...document.querySelectorAll('[data-testid="book-card"]')].find((x) => x.textContent.includes("scanned")); return c && c.querySelector('[data-testid="ocr-status"]').hidden; }, null, { timeout: 180000 });
  console.log(`  OCR of 2 scanned pages (at import): ${Date.now() - t0} ms`);
  await cards().filter({ hasText: "scanned" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  await openSearch();
  await page.waitForFunction(() => /Đã OCR 2 trang/.test(document.querySelector('[data-testid="index-status"]').textContent));
  await searchFor("nozzle guide vanes");
  await page.waitForSelector('[data-testid="search-result"]');
  assert.equal(await page.getAttribute('[data-testid="search-result"]', "data-page"), "2");
  await searchFor("flame tube");
  await page.waitForSelector('[data-testid="search-result"][data-page="1"]');
  await page.click('[data-testid="search-result"][data-page="1"]');
  await shot("23-ocr-hit");
  // Highlighter snaps to OCR'd words on the scan.
  await page.click(".tb-panel");
  await gotoPage(1);
  const hitBox = await page.locator('.page-slot[data-page="1"] .search-hit').first().boundingBox();
  const slot = await page.locator(`${BOOK} .page-slot[data-page="1"]`).boundingBox();
  await tool("highlighter");
  const fy = (hitBox.y + hitBox.height / 2 - slot.y) / slot.height;
  const fx0 = (hitBox.x - slot.x) / slot.width;
  const fx1 = (hitBox.x + hitBox.width - slot.x) / slot.width;
  await penStroke(1, [[fx0 + 0.005, fy - 0.004], [fx1 - 0.005, fy + 0.004]]);
  const [hl] = (await strokesOn(1)).filter((x) => x.tool === "highlighter");
  assert.ok(hl && hl.rects, "highlight snapped to OCR words");
  await tool("pen");
  await shot("24-ocr-highlight");
  await backToShelf();
});

test("v0.9.1: pause OCR from the book card, resume later", async () => {
  await page.evaluate(() => window.__app.index.setPaused(true));
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/scan-pause.pdf`]);
  const card = () => cards().filter({ hasText: "scan-pause" });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("scan-pause") && /tạm dừng OCR \(0\/1\)/.test(c.textContent)), null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  assert.match(await card().locator('[data-testid="ocr-status"]').textContent(), /Đã tạm dừng OCR \(0\/1\)/, "nothing OCR'd while paused");
  assert.equal(await page.evaluate(() => localStorage.getItem("vl.ocrPaused")), "1", "remembered");
  await shot("31-ocr-paused");
  await card().locator('[data-testid="card-ocr-toggle"]').click();
  assert.equal(await page.locator('[data-testid="scroller"]').count(), 0, "the button does not open the book");
  await page.waitForFunction(() => { const c = [...document.querySelectorAll('[data-testid="book-card"]')].find((x) => x.textContent.includes("scan-pause")); return c && c.querySelector('[data-testid="ocr-status"]').hidden; }, null, { timeout: 120000 });
  // The reader's search panel has the same switch.
  await page.evaluate(() => window.__app.index.setPaused(true));
  await openBook("650");
  await openSearch();
  assert.equal(await page.isVisible('[data-testid="ocr-toggle"]'), false, "nothing left to OCR in this book");
  await page.evaluate(() => window.__app.index.setPaused(false));
  await page.click(".tb-panel");
  await backToShelf();
});

// ---- milestone 8: Word documents ----

test("milestone 8: a .docx is laid out into pages, searchable without OCR, and exports", async () => {
  const t0 = Date.now();
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/bao-cao.docx`, `${FIX}/old.doc`]);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="book-card"]')].some((c) => c.textContent.includes("Báo cáo động cơ")), null, { timeout: 120000 });
  console.log(`  .docx import + layout: ${Date.now() - t0} ms`);
  await page.waitForSelector(".toast-error");
  assert.match(await page.locator(".toast-error").first().textContent(), /\.docx/, "old .doc gets a helpful message");
  const card = cards().filter({ hasText: "Báo cáo động cơ" });
  assert.equal(await card.locator('[data-testid="word-chip"]').count(), 1);
  const id = await card.getAttribute("data-id");
  const meta = await page.evaluate((bid) => window.__app.library.get(bid), id);
  assert.ok(meta.pageCount >= 3, `text flows over several pages (got ${meta.pageCount})`);
  // The original .docx is kept as it was.
  const orig = await page.evaluate(async (bid) => { const f = await window.__app.library.readOriginal(bid); const b = new Uint8Array(await f.slice(0, 2).arrayBuffer()); return { size: f.size, magic: String.fromCharCode(...b) }; }, id);
  assert.equal(orig.magic, "PK");
  assert.equal(orig.size, readFileSync(`${FIX}/bao-cao.docx`).length);
  // Words come from the layout: indexing finishes with nothing to OCR.
  await page.waitForFunction((bid) => { const s = window.__app.index.statusOf(bid); return s && s.scanned === s.total; }, id, { timeout: 60000 });
  assert.equal((await page.evaluate((bid) => window.__app.index.statusOf(bid), id)).ocrTotal, 0);

  await card.click();
  await page.waitForSelector('[data-testid="scroller"]');
  await waitRendered(1);
  assert.ok((await inkOf(1)) > 0.01, "page 1 shows the text");
  await shot("25-docx-page1");
  await openSearch();
  await searchFor("Phụ lục tuabin");
  await page.waitForSelector('[data-testid="search-result"]');
  const last = String(meta.pageCount);
  assert.equal(await page.getAttribute('[data-testid="search-result"]', "data-page"), last, "explicit page break starts the last page");
  await searchFor("Đoạn 14");
  await page.waitForSelector('[data-testid="search-result"]');
  const p14 = Number(await page.getAttribute('[data-testid="search-result"]', "data-page"));
  assert.ok(p14 >= 2 && p14 < meta.pageCount, "later paragraphs land on later pages");
  await page.click('[data-testid="search-result"]');
  await page.click(".tb-panel");
  await waitRendered(p14);
  await shot("26-docx-hit");
  // Highlighter snaps to the Word text.
  const hitBox = await page.locator(`.page-slot[data-page="${p14}"] .search-hit`).first().boundingBox();
  const slot = await page.locator(`${BOOK} .page-slot[data-page="${p14}"]`).boundingBox();
  await tool("highlighter");
  const fy = (hitBox.y + hitBox.height / 2 - slot.y) / slot.height;
  await penStroke(p14, [[(hitBox.x - slot.x) / slot.width + 0.003, fy - 0.003], [(hitBox.x + hitBox.width - slot.x) / slot.width - 0.003, fy + 0.003]]);
  const [hl] = (await strokesOn(p14)).filter((x) => x.tool === "highlighter");
  assert.ok(hl && hl.rects, "highlight snapped to the Word text");
  await tool("pen");
  const { path, name } = await exportVia("Chỉ các trang có ghi chú");
  assert.equal(name, "Bao cao dong co (ghi chu).pdf");
  assert.equal((await PDFDocument.load(readFileSync(path))).getPageCount(), 1);
  await backToShelf();
});

// ---- cut text and pictures from a book into a notebook ----

const nbClips = (pageNo) => page.evaluate((n) => window.__reader.notebookPaneForTests.inkModel.strokes(n - 1).filter((s) => s.tool === "clip").map((s) => ({ id: s.id, kind: s.clip.kind, lines: s.clip.lines, src: (s.clip.src || "").slice(0, 22), rects: s.rects, link: s.link })), pageNo);

/** Drags the clip card (with the pen) onto a point of a notebook page. */
async function dragClipTo(nbPage, fx, fy) {
  const c = await cdp();
  const from = await page.locator('[data-testid="clip-drag"]').boundingBox();
  const slot = await page.locator(`${NB} .page-slot[data-page="${nbPage}"]`).boundingBox();
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = { x: slot.x + fx * slot.width, y: slot.y + fy * slot.height };
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1, pointerType: "pen" });
  for (let i = 1; i <= 12; i++) {
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12, button: "left", buttons: 1, pointerType: "pen" });
  }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
}

test("clip: frame text in the book, drag it into the notebook as text", async () => {
  await openBook("650");
  if (!(await page.evaluate(() => !!window.__reader.notebookPaneForTests))) {
    await page.click('[data-testid="nb-btn"]');
    await page.locator('[data-testid="nb-choice"]', { hasText: "Vở M15" }).click();
  }
  await page.waitForFunction(() => !!window.__reader.notebookPaneForTests);
  await page.waitForSelector(`${NB} .page-slot`);
  await page.evaluate(() => window.__reader.notebookPaneForTests.scroller.goToPage(2));
  await page.waitForSelector(`${NB} .page-slot[data-page="2"] canvas`);
  await gotoPage(40);
  await waitRendered(40);
  await tool("clip");
  // Lines 1–3 of the body text.
  await penStroke(40, [[0.08, 0.222], [0.92, 0.292]]);
  await page.waitForSelector('[data-testid="clip-card"][data-ready="1"]');
  assert.equal(await page.locator('[data-testid="clip-select"]').count(), 1, "dashed frame shown");
  assert.match(await page.getAttribute('[data-testid="clip-mode-text"]', "class"), /active/, "text by default");
  const preview = await page.textContent('[data-testid="clip-drag"]');
  assert.match(preview, /^Line 1 of page 40: turbine .* Line 3 of page 40/);
  assert.doesNotMatch(preview, /Line 4/);
  await shot("27-clip-card");
  await dragClipTo(2, 0.12, 0.1);
  await page.waitForSelector('[data-testid="clip-card"]', { state: "detached" });
  const [clip] = await nbClips(2);
  assert.equal(clip.kind, "text");
  assert.match(clip.lines.join(" "), /Line 1 of page 40: turbine compressor combustion nozzle bearing Line 2/);
  assert.equal(clip.link.page, 40, "remembers where it came from");
  assert.equal(await page.locator('[data-testid="clip-select"]').count(), 0);
  await page.waitForSelector(`${NB} .page-slot[data-page="2"] .ink-clip text`);
});

test("clip: a picture of the page, moved with the pen, undo, tap to go back", async () => {
  // The big "Page 40" heading as a picture.
  await penStroke(40, [[0.08, 0.06], [0.6, 0.165]]);
  await page.waitForSelector('[data-testid="clip-card"][data-ready="1"]');
  await page.click('[data-testid="clip-mode-image"]');
  await page.waitForSelector('[data-testid="clip-drag"] img');
  await dragClipTo(2, 0.12, 0.5);
  await page.waitForFunction(() => window.__reader.notebookPaneForTests.inkModel.strokes(1).filter((s) => s.tool === "clip").length === 2);
  const img = (await nbClips(2)).find((c) => c.kind === "image");
  assert.match(img.src, /^data:image\/(png|jpeg)/);
  assert.ok(img.rects[2] > 250, "keeps its size");
  await page.waitForSelector(`${NB} .page-slot[data-page="2"] .ink-clip image`);
  await shot("28-clip-notebook");

  // Move it down with the pen (clip tool), then undo.
  const before = img.rects;
  const k = 1 / 842;
  const cx = (before[0] + before[2] / 2) / 595;
  const cy = (before[1] + before[3] / 2) * k;
  await penStroke(2, [[cx, cy], [cx, cy + 0.15]], { root: NB });
  const moved = (await nbClips(2)).find((c) => c.kind === "image").rects;
  assert.ok(moved[1] > before[1] + 80, `moved down (${before[1]} → ${moved[1]})`);
  await page.click('[data-testid="undo"]');
  assert.deepEqual((await nbClips(2)).find((c) => c.kind === "image").rects, before);

  // Pen writes on top of a clip.
  await tool("pen");
  const pens = () => page.evaluate(() => window.__reader.notebookPaneForTests.inkModel.strokes(1).filter((s) => s.tool === "pen").length);
  const pen0 = await pens();
  await penStroke(2, [[cx - 0.1, cy], [cx + 0.1, cy + 0.01]], { root: NB });
  assert.equal(await pens(), pen0 + 1);

  // A finger tap on the clip goes back to its page in the book.
  await gotoPage(7);
  const slot = await page.locator(`${NB} .page-slot[data-page="2"]`).boundingBox();
  const s = slot.width / 595;
  const c = await cdp();
  const txt = (await nbClips(2)).find((x) => x.kind === "text");
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: slot.x + (txt.rects[0] + 20) * s, y: slot.y + (txt.rects[1] + 6) * s }] });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => window.__reader.scrollerForTests.currentPage === 40, null, { timeout: 5000 });
  await backToShelf();
});

test("clip: resize with the corner handle, edit text with a pen tap", async () => {
  await openBook("650");
  await page.waitForFunction(() => !!window.__reader.notebookPaneForTests);
  await page.waitForSelector(`${NB} .page-slot[data-page="2"]`);
  await page.evaluate(() => window.__reader.notebookPaneForTests.scroller.goToPage(2));
  await tool("clip");
  await page.waitForSelector(`${NB} .page-slot[data-page="2"] .ink-clip .clip-handle`, { state: "visible" });
  const img = (await nbClips(2)).find((c) => c.kind === "image");
  const [x, y, w, h] = img.rects;
  const W = 595, H = 842;
  // Drag the bottom-right handle inwards: half the size, same shape.
  await penStroke(2, [[(x + w) / W, (y + h) / H], [(x + w * 0.5) / W, (y + h * 0.5) / H]], { root: NB });
  const small = (await nbClips(2)).find((c) => c.kind === "image").rects;
  assert.ok(Math.abs(small[2] / w - 0.5) < 0.06, `half as wide (${small[2]} vs ${w})`);
  assert.ok(Math.abs(small[2] / small[3] - w / h) < 0.02, "keeps its shape");
  assert.deepEqual(small.slice(0, 2), [x, y], "top-left stays put");
  // Text grows: font size follows.
  const txt = (await nbClips(2)).find((c) => c.kind === "text");
  const [tx, ty, tw, th] = txt.rects;
  await penStroke(2, [[(tx + tw) / W, (ty + th) / H], [(tx + tw * 0.8) / W, (ty + th * 0.8) / H]], { root: NB });
  const fs = await page.evaluate(() => window.__reader.notebookPaneForTests.inkModel.strokes(1).find((s) => s.clip?.kind === "text").clip.fontSize);
  assert.ok(fs < 10 && fs > 8, `font scaled down (${fs})`);
  await page.click('[data-testid="undo"]');
  // A pen tap on the text opens the editor.
  await penStroke(2, [[(tx + 40) / W, (ty + 8) / H], [(tx + 40) / W, (ty + 8) / H]], { root: NB });
  await page.waitForSelector('[data-testid="clip-edit"]');
  assert.match(await page.inputValue('[data-testid="clip-edit"]'), /^Line 1 of page 40/);
  await page.fill('[data-testid="clip-edit"]', "Ý chính: buồng đốt cần trộn đều nhiên liệu.\nGhi chú thêm của mình.");
  await page.click('[data-testid="clip-edit-save"]');
  await page.waitForFunction(() => window.__reader.notebookPaneForTests.inkModel.strokes(1).find((s) => s.clip?.kind === "text").clip.text.startsWith("Ý chính"));
  const edited = (await nbClips(2)).find((c) => c.kind === "text");
  assert.deepEqual(edited.lines, ["Ý chính: buồng đốt cần trộn đều nhiên liệu.", "Ghi chú thêm của mình."]);
  assert.ok(edited.rects[3] < th, "box shrinks to the shorter text");
  await page.waitForSelector(`${NB} .page-slot[data-page="2"] .ink-clip text`);
  await shot("30-clip-edited");
  // Split notebook: page actions from the page number in its header.
  await page.click('[data-testid="nb-page"]');
  assert.equal(await page.locator(".menu-item", { hasText: "Xóa trang 2" }).count(), 1);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);
  await tool("pen");
  await backToShelf();
});

test("clip: notebook export keeps the pasted text and picture", async () => {
  await cards().filter({ hasText: "Vở M15" }).click();
  await page.waitForSelector('[data-testid="scroller"]');
  const { path } = await exportVia("Chỉ các trang có ghi chú");
  const doc = await PDFDocument.load(readFileSync(path));
  const p2 = doc.getPages().find((pg) => {
    const xo = pg.node.Resources()?.lookup(PDFName.of("XObject"));
    return xo && xo.keys().length >= 2;
  });
  assert.ok(p2, "a page with the two clips as images");
  await backToShelf();
});

test("v1.0: Giấy da / Ánh nến theme, remembered after reload", async () => {
  await shot("40-theme-day-library");
  await page.click('[data-testid="theme-btn"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "night");
  await shot("41-theme-night-library");
  await page.reload();
  await page.waitForSelector('[data-testid="book-card"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "night", "kept after reload");
  await openBook("650");
  await waitRendered(await currentPage());
  await shot("42-theme-night-reader");
  await backToShelf();
  await page.click('[data-testid="theme-btn"]');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  // Fonts are bundled (offline) and in use.
  assert.ok(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "EB Garamond"', "Thư viện") && document.fonts.check('700 16px "Cormorant Garamond"', "Đọc"); }));
});

// ---- v1.1: the 3D library room ----

const W = (fn, arg) => page.evaluate(fn, arg);

test("v1.1: the 3D room shows every shelf as a stack, cheaply", async () => {
  const nBooks = await cards().count();
  const nRoots = await W(async () => (await window.__app.library.listCategories()).filter((c) => !c.parentId).length);
  const loose = await W(async () => {
    const [books, cats] = await Promise.all([window.__app.library.list(), window.__app.library.listCategories()]);
    const ids = new Set(cats.map((c) => c.id));
    return books.some((b) => !b.categoryId || !ids.has(b.categoryId));
  });
  // earlier tests opened many books (they all landed on the desk): start clean
  await W(() => window.__app.meta.setSetting("desk", []));
  await page.click('[data-testid="to-3d"]');
  await page.waitForSelector('[data-testid="home3d"][data-ready="1"]', { timeout: 60000 });
  const info = await W(() => window.__world.info());
  assert.equal(info.books, nBooks, "every book and notebook is on a shelf");
  assert.equal(await W(() => window.__world.stackCount()), nRoots + (loose ? 1 : 0));
  assert.ok(info.calls < 250, `draw calls stay low (${info.calls})`);
  assert.ok(info.textures < 80, `few textures (${info.textures})`);
  await page.waitForTimeout(800);
  await shot("50-room-hall");
});

test("v1.1/1.2: walk to a stack, pull a book out by its spine, open it: it lies on the desk, its gap holds a slip", async () => {
  const target = await W(async () => {
    const all = await window.__app.library.list();
    return all.find((b) => b.title.includes("650")) ?? all[0];
  });
  const si = await W((id) => {
    const w = window.__world;
    for (let i = 0; i < w.stackCount(); i++) if (w.stackAt(i).tiers.some((t) => t.books.some((b) => b.id === id))) return i;
    return -1;
  }, target.id);
  assert.ok(si >= 0);
  await W((i) => window.__world.goTo({ kind: "stack", index: i }, true), si);
  await page.waitForFunction((i) => document.querySelector('[data-testid="home3d"]').dataset.view === `stack:${i}`, si);
  // bring the book into view, then tap its spine like a user would
  await W((id) => { const w = window.__world; w.pullById(id); w.putBack(); }, target.id);
  await page.waitForFunction(() => window.__world.idle, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  const pt = await W((id) => window.__world.spineScreenPoint(id), target.id);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('[data-testid="h3-panel"]:not([hidden])');
  assert.equal(await page.textContent('[data-testid="h3-title"]'), target.title);
  await page.waitForFunction(() => window.__world.idle, null, { timeout: 15000 });
  await shot("51-room-pulled");
  await page.click('[data-testid="h3-open"]');
  await page.waitForSelector('[data-testid="scroller"]');
  await backToShelf3d();
  assert.equal(await page.getAttribute('[data-testid="home3d"]', "data-view"), "desk", "back at the desk, where the book now lies");
  assert.deepEqual(await W(() => window.__world.deskIds), [target.id]);
  assert.equal(await W((id) => window.__world.onShelf(id), target.id), false, "its place on the shelf is empty (with a slip)");
  assert.equal(await page.textContent('[data-testid="desk-count"]'), "TRÊN BÀN · 1/6");
  await page.waitForFunction(() => window.__world.idle);
  await shot("52-desk");
  // remembered across restarts
  await page.reload();
  await page.waitForSelector('[data-testid="home3d"][data-ready="1"]', { timeout: 60000 });
  assert.equal(await page.getAttribute('[data-testid="home3d"]', "data-view"), "desk");
  assert.deepEqual(await W(() => window.__world.deskIds), [target.id]);
  // put it back: it flies into its gap
  await page.click('[data-testid="desk-back"]');
  await page.waitForFunction((id) => window.__world.idle && window.__world.onShelf(id), target.id, { timeout: 15000 });
  assert.equal(await page.textContent('[data-testid="desk-count"]'), "TRÊN BÀN · 0/6");
  // whole stack in view: all 4 tiers' books project inside the screen
  await W((i) => window.__world.goTo({ kind: "stack", index: i }, true), si);
  const stack = await W((i) => window.__world.stackAt(i), si);
  const firstPerTier = stack.tiers.map((t) => t.books[0]).filter(Boolean).map((b) => b.id);
  for (const id of firstPerTier) {
    await W((x) => { window.__world.pullById(x); window.__world.putBack(); }, id);
    await page.waitForFunction(() => window.__world.idle);
    await W((i) => window.__world.goTo({ kind: "stack", index: i }, true), si);
    const p = await W((x) => window.__world.spineScreenPoint(x), id);
    assert.ok(p.y > 58 && p.y < 800, `tier visible without swiping (y=${Math.round(p.y)})`);
  }
});

test("v1.2: the desk holds 6 at most; dusty books get a reminder", async () => {
  const all = await W(async () => (await window.__app.library.list()).map((b) => b.id));
  assert.ok(all.length >= 7);
  const now = Date.now();
  const six = all.slice(0, 6).map((id, i) => ({ id, at: now - (i === 2 ? 20 : 0) * 86400000 }));
  await W(async ([items, old]) => {
    await window.__app.meta.setSetting("desk", items);
    await window.__app.library.meta.update(old, { lastOpenedAt: Date.now() - 20 * 86400000 });
  }, [six, six[2].id]);
  await W(() => window.__world.goTo({ kind: "desk" }, true));
  await page.click('[data-testid="h3-hall"]');
  await page.click('[data-testid="h3-list"]');
  await page.click('[data-testid="to-3d"]');
  await page.waitForSelector('[data-testid="home3d"][data-ready="1"]');
  await W(() => window.__world.goTo({ kind: "desk" }));
  await page.waitForFunction(() => window.__world.idle);
  assert.equal(await page.textContent('[data-testid="desk-count"]'), "TRÊN BÀN · 6/6");
  assert.equal(await page.locator('[data-testid="desk-dust"]').count(), 1, "one dusty book");
  assert.match(await page.locator('[data-testid="desk-dust"]').textContent(), /20 ngày chưa mở/);
  await shot("53-desk-full-dusty");
  // a 7th book: asks to put back the one untouched the longest
  const seventh = all[6];
  await W((id) => window.__world.pullById(id), seventh);
  await page.waitForSelector('[data-testid="h3-open"]');
  await page.click('[data-testid="h3-open"]');
  await page.waitForSelector(".modal");
  assert.match(await page.textContent(".modal"), /Bàn học đã đủ 6 cuốn/);
  await page.locator(".modal .btn", { hasText: "Cất và lấy sách" }).click();
  await page.waitForSelector('[data-testid="scroller"]', { timeout: 30000 });
  await backToShelf3d();
  const desk = await W(() => window.__world.deskIds);
  assert.equal(desk.length, 6);
  assert.ok(desk.includes(seventh) && !desk.includes(six[2].id), "the dusty one went back to its shelf");
  await W(() => window.__app.meta.setSetting("desk", []));
});

test("v1.3: the pinboard shows the plan; add, tick, goals and events from the room", async () => {
  await page.click('[data-testid="h3-board"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home3d"]').dataset.view === "board" && window.__world.idle);
  await page.waitForSelector('[data-testid="board-tab-today"]');
  // a task for today
  await page.click('[data-testid="board-add"]');
  await page.fill('[data-testid="task-title"]', "Ôn ATA 72-30 sơ đồ dòng khí");
  await page.click('[data-testid="task-save"]');
  await page.waitForFunction(() => window.__world.noteLines("today").includes("Ôn ATA 72-30 sơ đồ dòng khí"));
  const row = page.locator(".board-row", { hasText: "Ôn ATA 72-30" });
  await row.locator('[data-testid="board-check"]').check();
  await page.waitForFunction(() => document.querySelector(".board-row .board-item.done"));
  // tapping the events note opens that section
  const pt = await W(() => window.__world.noteScreenPoint("events"));
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('[data-testid="board-tab-events"].on');
  await page.click('[data-testid="board-add"]');
  assert.equal(await page.inputValue('[data-testid="task-kind"]'), "deadline");
  await page.fill('[data-testid="task-title"]', "Thi An toàn sân đỗ");
  const in3 = await W(() => { const d = new Date(); d.setDate(d.getDate() + 3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await page.fill('[data-testid="task-date"]', in3);
  await page.click('[data-testid="task-save"]');
  await page.waitForFunction(() => window.__world.noteLines("events").includes("Thi An toàn sân đỗ"));
  assert.match(await page.locator(".board-row", { hasText: "Thi An toàn sân đỗ" }).textContent(), /còn 3 ngày/);
  // a goal: its own note, not in today's list
  await page.click('[data-testid="board-tab-goals"]');
  await page.click('[data-testid="board-add"]');
  assert.equal(await page.inputValue('[data-testid="task-kind"]'), "goal");
  assert.equal(await page.inputValue('[data-testid="task-date"]'), "");
  await page.fill('[data-testid="task-title"]', "Hoàn thành CMT Level I");
  await page.click('[data-testid="task-save"]');
  await page.waitForFunction(() => window.__world.noteLines("goals").some((l) => l.includes("Hoàn thành CMT Level I")));
  assert.ok(!(await W(() => window.__world.noteLines("today"))).some((l) => l.includes("CMT")));
  await page.waitForFunction(() => window.__world.idle);
  await page.waitForTimeout(400);
  await shot("54-pinboard");
});

test("v1.1: favourite from the pulled-out book; import lands on the stack you stand at", async () => {
  const si = 0;
  await W(() => window.__world.goTo({ kind: "stack", index: 0 }, true));
  const stack = await W((i) => window.__world.stackAt(i), si);
  const book = stack.tiers.flatMap((t) => t.books).find((b) => !b.cloth);
  await W((id) => window.__world.pullById(id), book.id);
  await page.waitForSelector('[data-testid="h3-panel"]:not([hidden])');
  const before = await W(async (id) => (await window.__app.library.get(id)).favorite ?? false, book.id);
  await page.click('[data-testid="h3-fav"]');
  await page.waitForFunction(async ([id, b]) => ((await window.__app.library.get(id)).favorite ?? false) !== b, [book.id, before]);
  await W((id) => window.__app.library.setFavorite(id, false), book.id);
  // import while standing at this stack
  const n0 = await W(() => window.__world.info().books);
  await page.setInputFiles('[data-testid="h3-file-input"]', [`${FIX}/scan-pause.pdf`, `${FIX}/small.pdf`]);
  await page.waitForSelector(".toast");
  await page.waitForTimeout(1500);
  assert.equal(await W(() => window.__world.info().books), n0, "both already on a shelf: duplicates are not added twice");
  // back to the list view for the remaining tests
  await page.click('[data-testid="h3-list"]');
  await page.waitForSelector('[data-testid="book-card"]');
  assert.equal(await W(() => localStorage.getItem("vl.home")), "list");
});

test("works offline after the first visit", async () => {
  await page.waitForFunction(async () => (await navigator.serviceWorker?.getRegistration())?.active, null, { timeout: 20000 });
  await page.reload(); // let the service worker control the page
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-testid="book-card"]');
  await openBook("650");
  await waitRendered(await currentPage());
  assert.ok((await inkOf(await currentPage())) > 0.005, "page renders offline");
  await backToShelf();
  await context.setOffline(false);
});

test("200 MB file imports and reads smoothly", { skip: !process.env.HEAVY || !existsSync(`${FIX}/heavy-200mb.pdf`) }, async () => {
  const n0 = await cards().count();
  const t0 = Date.now();
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/heavy-200mb.pdf`]);
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="book-card"]').length === k, n0 + 1, { timeout: 180000 });
  const importMs = Date.now() - t0;
  const t1 = Date.now();
  await openBook("heavy");
  await waitRendered(1, 30000);
  const openMs = Date.now() - t1;
  const t2 = Date.now();
  await page.click('[data-testid="page-input"]');
  await page.keyboard.type("100");
  await page.keyboard.press("Enter");
  await waitRendered(100, 30000);
  const jumpMs = Date.now() - t2;
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  console.log(`  heavy: import ${importMs} ms, open ${openMs} ms, jump ${jumpMs} ms, JS heap ${(heap / 1e6).toFixed(0)} MB`);
  assert.ok(heap < 200e6, "file must not be held in JS memory");
  await shot("07-heavy");
  await backToShelf();
});

async function prompt(text) {
  await page.waitForSelector(".modal .text-input");
  await page.fill(".modal .text-input", text);
  await page.click(".modal .btn-primary");
}
const crumbsText = async () => (await page.textContent('[data-testid="crumbs"] .crumb-path')).replace(/\s+/g, " ").trim();

test("milestone 2: create nested shelves", async () => {
  await page.click('[data-testid="new-shelf"]');
  await prompt("Hàng không");
  await page.waitForFunction(() => document.querySelector('[data-testid="crumbs"]').textContent.includes("Hàng không"));
  await page.click('[data-testid="new-subshelf"]');
  await prompt("Động cơ");
  await page.waitForFunction(() => document.querySelector('[data-testid="crumbs"]').textContent.includes("Động cơ"));
  assert.match(await crumbsText(), /Tất cả\s*Hàng không\s*Động cơ/);
  await page.click('.crumb:has-text("Hàng không")');
  await page.click('[data-testid="new-subshelf"]');
  await prompt("Khí động");
  await page.click('.crumb:has-text("Hàng không")');
  // duplicate sibling name is refused with a message
  await page.click('[data-testid="new-subshelf"]');
  await prompt("động CƠ");
  await page.waitForFunction(() => [...document.querySelectorAll(".toast-error")].some((t) => t.textContent.includes("Đã có")));
  assert.equal(await page.locator('[data-testid="shelf-tile"]').count(), 2);
});

test("milestone 2: select several books and move them onto a shelf", async () => {
  await page.click('[data-testid="view-all"]');
  await page.click('[data-testid="select-btn"]');
  await cards().filter({ hasText: "650" }).click();
  await cards().filter({ hasText: "heavy" }).first().click().catch(() => {});
  const n = await page.locator(".card.selected").count();
  assert.ok(n >= 1);
  await page.click('[data-testid="bulk-move"]');
  await page.locator('[data-testid="shelf-picker"] .picker-row', { hasText: "Động cơ" }).click();
  await page.click('[data-testid="shelf-picker"] .btn-primary');
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Đã chuyển")));
  // shown under the parent shelf too (counts include sub-shelves)
  await page.locator('[data-testid="shelf-item"]', { hasText: "Hàng không" }).click();
  assert.equal(await cards().count(), n);
  assert.match(await cards().first().textContent(), /Hàng không › Động cơ/);
  await page.click('[data-testid="view-unsorted"]');
  assert.equal(await cards().filter({ hasText: "650" }).count(), 0);
});

test("milestone 2: tags, tag filter and accent-free search", async () => {
  await page.click('[data-testid="view-all"]');
  await cards().filter({ hasText: "650" }).locator(".card-more").click();
  await page.locator(".menu-item", { hasText: "Gắn thẻ" }).click();
  await page.fill('[data-testid="tag-input"]', "M15");
  await page.keyboard.press("Enter");
  await page.fill('[data-testid="tag-input"]', "#Động cơ, ATA 72");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="tag-dialog"] .chip[data-tag="ATA 72"]');
  await page.click('[data-testid="tag-dialog"] .btn-primary');
  await page.waitForSelector('.sp-tags .tag-chip[data-tag="M15"]');
  assert.match(await cards().filter({ hasText: "650" }).textContent(), /#M15.*#Động cơ.*#ATA 72/);
  await page.click('.sp-tags .tag-chip[data-tag="M15"]');
  assert.equal(await cards().count(), 1);
  await page.click('.sp-tags .tag-chip[data-tag="M15"]');
  await page.fill('[data-testid="search"]', "#dong co");
  assert.equal(await cards().count(), 1);
  await page.fill('[data-testid="search"]', "");
  await shot("08-shelves");
});

test("milestone 2: importing while on a shelf puts the file there; view survives reload", async () => {
  await page.locator('[data-testid="shelf-item"]', { hasText: "Khí động" }).click();
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/small.pdf`]);
  await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Khí động|đã có/.test(t.textContent)));
  await page.reload();
  await page.waitForSelector('[data-testid="crumbs"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="crumbs"]').textContent.includes("Khí động"));
});

test("milestone 2: deleting a shelf keeps its books", async () => {
  await page.locator('[data-testid="shelf-item"]', { hasText: "Động cơ" }).click();
  const before = await cards().count();
  await page.click('[data-testid="shelf-menu"]');
  await page.locator(".menu-item", { hasText: "Xóa danh mục" }).click();
  await page.click(".modal .btn-primary");
  await page.waitForFunction(() => !document.querySelector('[data-testid="crumbs"]').textContent.includes("Động cơ"));
  const names = await page.locator('[data-testid="shelf-item"] .sp-label').allTextContents();
  assert.ok(!names.includes("Động cơ"), `shelves now: ${names.join(", ")}`);
  assert.ok((await cards().count()) >= before);
  await page.click('[data-testid="view-all"]');
});

test("milestone 2: data saved by v0.1.0 still loads", async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => localStorage.setItem("vl.home", "list"));
  const p = await ctx.newPage();
  await p.goto(URL + "icons/icon.svg");
  await p.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("visual-library", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("books", { keyPath: "id" }).createIndex("fingerprint", "fingerprint");
      db.createObjectStore("covers"); db.createObjectStore("blobs"); db.createObjectStore("settings");
    };
    req.onsuccess = () => {
      const t = req.result.transaction("books", "readwrite");
      t.objectStore("books").put({ id: "old1", kind: "pdf", title: "Sách từ bản 0.1", fileName: "a.pdf", size: 10, pageCount: 5,
        fingerprint: "x", addedAt: 1, lastOpenedAt: 2, lastPage: 3, zoom: 1 });
      t.oncomplete = () => { req.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  }));
  await p.goto(URL);
  await p.waitForSelector('[data-testid="book-card"]');
  assert.match(await p.textContent('[data-testid="book-card"]'), /Sách từ bản 0\.1/);
  assert.match(await p.textContent('[data-testid="view-unsorted"]'), /1/);
  await ctx.close();
});

test("deletes a book from the shelf", async () => {
  const n = await cards().count();
  await cards().filter({ hasText: "3 pages" }).locator(".card-more").click();
  await page.locator(".menu-item", { hasText: "Xóa" }).click();
  await page.locator(".modal .btn-primary").click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="book-card"]').length === k, n - 1);
});
