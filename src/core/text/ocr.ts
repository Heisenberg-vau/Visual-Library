import { OEM, createWorker, type Worker } from "tesseract.js";
import type { WordBox } from "./words";

/**
 * Offline OCR (Tesseract, English + Vietnamese). Everything is served from
 * the app's own files, precached by the service worker.
 */
function asset(path: string): string {
  return new URL(`tesseract/${path}`, document.baseURI).href;
}

export class OcrEngine {
  private worker: Promise<Worker> | null = null;

  private create(simd: boolean): Promise<Worker> {
    return createWorker(["eng", "vie"], OEM.LSTM_ONLY, {
      workerPath: asset("worker.min.js"),
      corePath: asset(simd ? "tesseract-core-simd-lstm.wasm.js" : "tesseract-core-lstm.wasm.js"),
      langPath: asset("lang"),
      gzip: true,
      cacheMethod: "none",
      workerBlobURL: false,
    });
  }

  private get(): Promise<Worker> {
    if (!this.worker) {
      this.worker = this.create(true).catch(() => this.create(false));
      this.worker.catch(() => (this.worker = null));
    }
    return this.worker;
  }

  /**
   * Recognises words in an image. `scale` = image pixels per PDF point, so
   * boxes come back in PDF points.
   */
  async recognize(image: HTMLCanvasElement, scale: number): Promise<WordBox[]> {
    const w = await this.get();
    const { data } = await w.recognize(image, {}, { blocks: true, text: false });
    const out: WordBox[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          for (const word of l.words) {
            const t = word.text.trim();
            if (!t || word.confidence < 30) continue;
            const { x0, y0, x1, y1 } = word.bbox;
            out.push({
              t,
              x: round1(x0 / scale),
              y: round1(y0 / scale),
              w: round1((x1 - x0) / scale),
              h: round1((y1 - y0) / scale),
            });
          }
        }
      }
    }
    return out;
  }

  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => {});
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
