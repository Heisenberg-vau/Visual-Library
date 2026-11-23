// Copies the offline OCR runtime (Tesseract.js worker, WebAssembly core,
// English + Vietnamese LSTM models) into public/tesseract so the service
// worker can precache them: OCR then works without a network.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const dst = join(root, "public", "tesseract");
rmSync(dst, { recursive: true, force: true });
mkdirSync(join(dst, "lang"), { recursive: true });
cpSync(join(nm, "tesseract.js", "dist", "worker.min.js"), join(dst, "worker.min.js"));
for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) {
  cpSync(join(nm, "tesseract.js-core", f), join(dst, f));
}
for (const lang of ["eng", "vie"]) {
  cpSync(join(nm, "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`), join(dst, "lang", `${lang}.traineddata.gz`));
}
console.log("OCR assets copied to public/tesseract");
