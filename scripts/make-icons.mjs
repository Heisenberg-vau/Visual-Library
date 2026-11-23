// Renders public/icons/icon.svg to the PNG sizes the web manifest needs.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const svg = readFileSync("public/icons/icon.svg", "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icons/icon-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written");
