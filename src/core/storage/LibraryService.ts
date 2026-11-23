import type { BookMeta } from "../types";
import { UserFacingError } from "../types";
import type { FileStore } from "./FileStore";
import type { MetaStore } from "./MetaStore";

/** What importing needs to learn about a file. Injected so tests can fake it. */
export interface DocInspector {
  accepts(file: File): Promise<boolean>;
  inspect(file: File): Promise<{
    pageCount: number;
    fingerprint: string;
    title: string | null;
    cover: Blob | null;
  }>;
}

export type ImportResult =
  | { status: "added"; book: BookMeta }
  | { status: "duplicate"; book: BookMeta }
  | { status: "error"; fileName: string; message: string };

export interface ImportProgress {
  fileName: string;
  index: number;
  total: number;
  phase: "copy" | "inspect";
  /** 0..1 within the current file */
  fraction: number;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || name;
}

/** Library use-cases: import, list, rename, delete, reading position. */
export class LibraryService {
  constructor(
    private readonly meta: MetaStore,
    private readonly files: FileStore,
    private readonly inspector: DocInspector,
  ) {}

  list(): Promise<BookMeta[]> {
    return this.meta.list();
  }

  get(id: string): Promise<BookMeta | undefined> {
    return this.meta.get(id);
  }

  getCover(id: string): Promise<Blob | undefined> {
    return this.meta.getCover(id);
  }

  readFile(id: string): Promise<File> {
    return this.files.read(id);
  }

  async importFiles(
    list: File[],
    onProgress?: (p: ImportProgress) => void,
  ): Promise<ImportResult[]> {
    const out: ImportResult[] = [];
    for (let i = 0; i < list.length; i++) {
      out.push(await this.importOne(list[i], i, list.length, onProgress));
    }
    return out;
  }

  private async importOne(
    file: File,
    index: number,
    total: number,
    onProgress?: (p: ImportProgress) => void,
  ): Promise<ImportResult> {
    const report = (phase: ImportProgress["phase"], fraction: number) =>
      onProgress?.({ fileName: file.name, index, total, phase, fraction });
    if (!(await this.inspector.accepts(file))) {
      return { status: "error", fileName: file.name, message: "Không phải file PDF." };
    }
    const id = newId();
    try {
      report("copy", 0);
      // Copy first, then inspect the stored copy: the original the user
      // picked is never touched again.
      await this.files.write(id, file, (done) => report("copy", file.size ? done / file.size : 1));
      report("inspect", 0);
      const stored = await this.files.read(id);
      const info = await this.inspector.inspect(stored);
      const dup = info.fingerprint ? await this.meta.findByFingerprint(info.fingerprint) : undefined;
      if (dup) {
        await this.files.delete(id);
        return { status: "duplicate", book: dup };
      }
      const book: BookMeta = {
        id,
        kind: "pdf",
        title: info.title || titleFromFileName(file.name),
        fileName: file.name,
        size: file.size,
        pageCount: info.pageCount,
        fingerprint: info.fingerprint,
        addedAt: Date.now(),
        lastOpenedAt: null,
        lastPage: 1,
        zoom: 1,
      };
      await this.meta.put(book);
      if (info.cover) await this.meta.putCover(id, info.cover);
      report("inspect", 1);
      return { status: "added", book };
    } catch (e) {
      await this.files.delete(id).catch(() => {});
      const message =
        e instanceof UserFacingError
          ? e.message
          : e instanceof DOMException && e.name === "QuotaExceededError"
            ? "Máy không còn đủ dung lượng để lưu file này."
            : "Không đọc được file này.";
      if (!(e instanceof UserFacingError)) console.error("import failed", e);
      return { status: "error", fileName: file.name, message };
    }
  }

  async rename(id: string, title: string): Promise<void> {
    const t = title.trim();
    if (t) await this.meta.update(id, { title: t });
  }

  async delete(id: string): Promise<void> {
    await this.files.delete(id);
    await this.meta.delete(id);
  }

  async markOpened(id: string): Promise<void> {
    await this.meta.update(id, { lastOpenedAt: Date.now() });
  }

  async savePosition(id: string, lastPage: number, zoom: number): Promise<void> {
    await this.meta.update(id, { lastPage, zoom });
  }
}
