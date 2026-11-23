/// <reference lib="webworker" />
import { ExportError, exportAnnotatedPdf, type ExportRequest } from "./exportPdf";

/** Builds the annotated PDF off the main thread so the app stays responsive. */
self.onmessage = async (e: MessageEvent<{ file: Blob | null } & Omit<ExportRequest, "bytes">>) => {
  try {
    const { file, ...rest } = e.data;
    const bytes = file ? await file.arrayBuffer() : null;
    const out = await exportAnnotatedPdf({ ...rest, bytes }, (fraction, phase) =>
      self.postMessage({ type: "progress", fraction, phase }),
    );
    self.postMessage({ type: "done", bytes: out }, { transfer: [out.buffer] });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof ExportError ? err.message : "Xuất file thất bại. Thử lại, hoặc báo lỗi kèm tên file.",
      detail: String(err),
    });
  }
};
