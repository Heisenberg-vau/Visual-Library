// End-to-end tests in real Chrome, at Xiaomi Pad 8 Pro-like size with touch.
// Usage: npm run build && npm run fixtures && npm run test:e2e
//   HEAVY=1 also runs the 200 MB file test (needs `node scripts/make-fixtures.mjs --heavy`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

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
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
    locale: "vi-VN",
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
  await page.click('.tab[data-tab="thumbs"]');
  await page.waitForSelector(".thumb.current .thumb-canvas", { timeout: 15000 });
  const cur = await page.getAttribute(".thumb.current", "data-page");
  assert.equal(Number(cur), await currentPage());
  const target = page.locator(".thumb").filter({ has: page.locator(".thumb-canvas") }).last();
  const n = Number(await target.getAttribute("data-page"));
  await target.click();
  assert.equal(await currentPage(), n);
  await shot("05-thumbs");
  await page.click(".tb-panel");
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
  assert.match(await cards().filter({ hasText: "650" }).textContent(), /Trang 123/);
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

test("works offline after the first visit", async () => {
  await page.waitForFunction(async () => (await navigator.serviceWorker?.getRegistration())?.active, null, { timeout: 20000 });
  await page.reload(); // let the service worker control the page
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-testid="book-card"]');
  await openBook("650");
  await waitRendered(123);
  await backToShelf();
  await context.setOffline(false);
});

test("200 MB file imports and reads smoothly", { skip: !process.env.HEAVY || !existsSync(`${FIX}/heavy-200mb.pdf`) }, async () => {
  const t0 = Date.now();
  await page.setInputFiles('[data-testid="file-input"]', [`${FIX}/heavy-200mb.pdf`]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="book-card"]').length === 3, null, { timeout: 180000 });
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

test("deletes a book from the shelf", async () => {
  const n = await cards().count();
  await cards().filter({ hasText: "3 pages" }).locator(".card-more").click();
  await page.locator(".menu-item", { hasText: "Xóa" }).click();
  await page.locator(".modal .btn-primary").click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="book-card"]').length === k, n - 1);
});
