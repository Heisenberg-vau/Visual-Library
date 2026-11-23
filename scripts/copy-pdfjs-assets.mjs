// Copies the pdf.js runtime assets (worker is bundled by Vite) that pdf.js
// fetches at run time: CMaps (CJK/legacy fonts), standard fonts, wasm decoders
// (JPEG2000, JBIG2 for scanned PDFs, colour management) and ICC profiles.
// They are precached by the service worker so the app works fully offline.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dst = join(root, "public", "pdfjs");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(src, dir), join(dst, dir), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
