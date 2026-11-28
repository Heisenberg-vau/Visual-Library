import type { BookMeta, Category } from "../types";
import type { WordBox } from "../text/words";
import { compareNames, mergeTags, sameTag, subtreeIds } from "../library/shelves";
import { UserFacingError } from "../types";
import type { FileStore } from "./FileStore";
import type { MetaStore } from "./MetaStore";

/** What importing needs to learn about a file. Injected so tests can fake it. */
export interface DocInspector {
  /** true/"pdf" = a PDF, "docx" = a Word document, false = not supported. */
  accepts(file: File): Promise<boolean | "pdf" | "docx">;
  inspect(
    file: File,
    onProgress?: (fraction: number) => void,
    kind?: "pdf" | "docx",
  ): Promise<{
    pageCount: number;
    fingerprint: string;
    title: string | null;
    cover: Blob | null;
    /** Reading copy for formats that are converted (Word → PDF). */
    converted?: Blob;
    /** Words per page of the converted copy (no OCR needed). */
    pageWords?: WordBox[][];
  }>;
}

/** Where the untouched original of a converted book (e.g. the .docx) is kept. */
export const originalKey = (id: string) => `${id}.orig`;
export const TRASH_DAYS = 30;

export type ImportResult =
  | { status: "added"; book: BookMeta }
  | { status: "duplicate"; book: BookMeta }
  /** The same book was in the trash or in cold storage: it is back, notes and all. */
  | { status: "returned"; book: BookMeta; from: "trash" | "cold" }
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

  /** Books and notebooks on the shelves (not in the trash). */
  async list(): Promise<BookMeta[]> {
    return (await this.meta.list()).filter((b) => !b.trashedAt);
  }

  /** Everything, trash included. */
  listAll(): Promise<BookMeta[]> {
    return this.meta.list();
  }

  async listTrash(): Promise<BookMeta[]> {
    return (await this.meta.list()).filter((b) => b.trashedAt).sort((a, b) => b.trashedAt! - a.trashedAt!);
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

  /** Imports onto `categoryId` (null = "Chưa phân loại"). */
  async importFiles(
    list: File[],
    onProgress?: (p: ImportProgress) => void,
    categoryId: string | null = null,
  ): Promise<ImportResult[]> {
    const out: ImportResult[] = [];
    for (let i = 0; i < list.length; i++) {
      out.push(await this.importOne(list[i], i, list.length, onProgress, categoryId));
    }
    return out;
  }

  private async importOne(
    file: File,
    index: number,
    total: number,
    onProgress?: (p: ImportProgress) => void,
    categoryId: string | null = null,
  ): Promise<ImportResult> {
    const report = (phase: ImportProgress["phase"], fraction: number) =>
      onProgress?.({ fileName: file.name, index, total, phase, fraction });
    const kind = await this.inspector.accepts(file);
    if (!kind) {
      const message = /\.doc$/i.test(file.name)
        ? "File Word đời cũ (.doc) chưa mở được – hãy mở bằng Word, lưu lại thành .docx rồi nhập lại."
        : "Chỉ mở được file PDF hoặc Word (.docx).";
      return { status: "error", fileName: file.name, message };
    }
    const id = newId();
    const converted = kind === "docx";
    // A converted book keeps its original separately; the reading copy is `id`.
    const key = converted ? originalKey(id) : id;
    try {
      report("copy", 0);
      // Copy first, then inspect the stored copy: the original the user
      // picked is never touched again.
      await this.files.write(key, file, (done) => report("copy", file.size ? done / file.size : 1));
      report("inspect", 0);
      const stored = await this.files.read(key);
      const info = await this.inspector.inspect(stored, (f) => report("inspect", Math.min(0.99, f)), converted ? "docx" : "pdf");
      const dup = info.fingerprint ? await this.meta.findByFingerprint(info.fingerprint) : undefined;
      if (dup && (dup.cold || dup.trashedAt)) {
        // the original of a book in cold storage or the trash: it comes back to its place
        const from = dup.cold ? ("cold" as const) : ("trash" as const);
        if (dup.cold) {
          const dkey = dup.source ? originalKey(dup.id) : dup.id;
          if (converted !== !!dup.source) throw new UserFacingError("File này khác loại với bản đã cất (PDF/Word).");
          await this.files.write(dkey, stored);
          if (converted) {
            if (!info.converted) throw new UserFacingError("Không chuyển được file Word này.");
            await this.files.write(dup.id, info.converted);
          }
        }
        await this.files.delete(key).catch(() => {});
        if (converted) await this.files.delete(id).catch(() => {});
        await this.meta.update(dup.id, { cold: undefined, trashedAt: undefined });
        const book = (await this.meta.get(dup.id))!;
        if (from === "cold") for (const fn of this.onAddedHooks) fn(book);
        return { status: "returned", book, from };
      }
      if (dup) {
        await this.files.delete(key);
        return { status: "duplicate", book: dup };
      }
      if (converted) {
        if (!info.converted) throw new UserFacingError("Không chuyển được file Word này.");
        await this.files.write(id, info.converted);
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
        categoryId,
        tags: [],
        margins: { left: 0, right: 0 },
        favorite: false,
        bookmarks: [],
        ...(converted ? { source: "docx" as const } : {}),
      };
      // Words of converted pages first, so indexing never OCRs them.
      for (const fn of this.onImportHooks) await fn(book, { pageWords: info.pageWords });
      await this.meta.put(book);
      if (info.cover) await this.meta.putCover(id, info.cover);
      report("inspect", 1);
      for (const fn of this.onAddedHooks) fn(book);
      return { status: "added", book };
    } catch (e) {
      await this.files.delete(id).catch(() => {});
      if (converted) await this.files.delete(key).catch(() => {});
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

  // ---- notebooks ----------------------------------------------------

  /** A new exercise book on `categoryId`, starting with two blank pages. */
  async createNotebook(
    name: string,
    categoryId: string | null,
    paper: NonNullable<BookMeta["paper"]> = "lines",
  ): Promise<BookMeta> {
    const title = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) throw new UserFacingError("Tên vở không được để trống.");
    const id = newId();
    const nb: BookMeta = {
      id,
      kind: "notebook",
      title,
      fileName: "",
      size: 0,
      pageCount: 2,
      fingerprint: `notebook:${id}`,
      addedAt: Date.now(),
      lastOpenedAt: null,
      lastPage: 1,
      zoom: 1,
      categoryId,
      tags: [],
      margins: { left: 0, right: 0 },
      paper,
      favorite: false,
      bookmarks: [],
    };
    await this.meta.put(nb);
    return nb;
  }

  async setPageCount(id: string, pageCount: number): Promise<void> {
    await this.meta.update(id, { pageCount });
  }

  async setPaper(id: string, paper: NonNullable<BookMeta["paper"]>): Promise<void> {
    await this.meta.update(id, { paper });
  }

  async rename(id: string, title: string): Promise<void> {
    const t = title.trim();
    if (t) await this.meta.update(id, { title: t });
  }

  /** "Xóa": to the trash. Nothing is lost for 30 days. */
  async delete(id: string): Promise<void> {
    await this.meta.update(id, { trashedAt: Date.now() });
  }

  async untrash(id: string): Promise<void> {
    await this.meta.update(id, { trashedAt: undefined });
  }

  /** Empties trash older than `maxAgeMs` (all of it with 0). Returns how many went. */
  async purgeTrash(maxAgeMs = TRASH_DAYS * 86_400_000, now = Date.now()): Promise<number> {
    let n = 0;
    for (const b of await this.listTrash()) {
      if (now - b.trashedAt! >= maxAgeMs) {
        await this.purge(b.id);
        n++;
      }
    }
    return n;
  }

  /** Gone for good: files, record, notes, text, progress. */
  async purge(id: string): Promise<void> {
    await this.files.delete(id).catch(() => {}); // notebooks have no file
    await this.files.delete(originalKey(id)).catch(() => {});
    await this.meta.delete(id);
    await this.onDeleteHooks.reduce((p, fn) => p.then(() => fn(id)), Promise.resolve());
  }

  /** Lets other modules (handwriting) clean up when a book is deleted. */
  private onDeleteHooks: ((id: string) => Promise<void>)[] = [];
  onDelete(fn: (id: string) => Promise<void>): void {
    this.onDeleteHooks.push(fn);
  }

  // ---- after an interruption (v2.4) ------------------------------------

  /**
   * Run once at start, before anything else writes. Finishes what a closed
   * app or a dead battery left half done:
   * - a file copied in without its book record (import, restore) is removed;
   * - a cold book whose files are all present again is back (thaw finished
   *   writing, the flag was not cleared); one with only some files present
   *   loses the leftovers (freeze or thaw stopped half way).
   * A file being written exists but stays empty until done, so sizes are checked.
   */
  async repairOnStart(): Promise<{ removed: string[]; thawed: string[] }> {
    const list = await this.meta.list();
    const present = new Set(await this.files.list());
    const expected = new Set<string>();
    const removed: string[] = [];
    const thawed: string[] = [];
    for (const b of list) {
      if (b.kind === "notebook") continue;
      const need = [b.id, ...(b.source ? [originalKey(b.id)] : [])];
      if (b.cold) {
        // a file being written shows up empty until it is complete: whole = right size
        const whole = async (n: string) => {
          if (!present.has(n)) return false;
          const size = await this.files.read(n).then((f) => f.size, () => -1);
          return n === (b.source ? originalKey(b.id) : b.id) ? size === b.size : size > 0;
        };
        let all = true;
        for (const n of need) if (!(await whole(n))) all = false;
        if (all) {
          await this.meta.update(b.id, { cold: undefined });
          thawed.push(b.id);
          need.forEach((n) => expected.add(n));
        }
        // partial: leave the names out of `expected`, they go below
      } else need.forEach((n) => expected.add(n));
    }
    for (const name of present) {
      if (expected.has(name)) continue;
      await this.files.delete(name).catch(() => {});
      removed.push(name);
    }
    return { removed, thawed };
  }

  // ---- cold storage (v2.3) -------------------------------------------

  /** Takes a book's file(s) off the device; notes, cover, place and progress stay. */
  async freeze(id: string, backup?: string): Promise<void> {
    const b = await this.meta.get(id);
    if (!b || b.kind === "notebook" || b.cold) return;
    await this.meta.update(id, { cold: { at: Date.now(), ...(backup ? { backup } : {}) } });
    await this.files.delete(id).catch(() => {});
    await this.files.delete(originalKey(id)).catch(() => {});
  }

  /**
   * Brings a cold book back from the file the user picked: the same PDF, or
   * for a Word book the same .docx (converted again). Anything else is refused.
   */
  async thaw(id: string, file: File, fingerprintOf: (f: Blob) => Promise<string>): Promise<void> {
    const b = await this.meta.get(id);
    if (!b?.cold) return;
    const isDocx = /\.docx$/i.test(file.name) || file.type.includes("wordprocessingml");
    if (!!b.source !== isDocx) throw new UserFacingError(b.source ? "Sách này nhập từ Word: hãy chọn đúng file .docx gốc." : "Hãy chọn đúng file PDF gốc của sách này.");
    if ((await fingerprintOf(file)) !== b.fingerprint) throw new UserFacingError("File này không phải bản gốc của sách (nội dung khác).");
    if (b.source) {
      await this.files.write(originalKey(id), file);
      const info = await this.inspector.inspect(await this.files.read(originalKey(id)), undefined, "docx");
      if (!info.converted) throw new UserFacingError("Không chuyển được file Word này.");
      await this.files.write(id, info.converted);
    } else {
      await this.files.write(id, file);
    }
    await this.meta.update(id, { cold: undefined });
  }

  /** Brings a cold book back with bytes taken from a backup (already checked against its hash). */
  async thawFromBackup(id: string, file: Blob, original?: Blob): Promise<void> {
    const b = await this.meta.get(id);
    if (!b?.cold) return;
    await this.files.write(id, file);
    if (original) await this.files.write(originalKey(id), original);
    await this.meta.update(id, { cold: undefined });
  }

  async setMargins(id: string, margins: BookMeta["margins"]): Promise<void> {
    await this.meta.update(id, { margins });
  }

  // ---- shelves -----------------------------------------------------

  listCategories(): Promise<Category[]> {
    return this.meta.listCategories();
  }

  private async checkName(name: string, parentId: string | null, exceptId?: string): Promise<string> {
    const n = name.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!n) throw new UserFacingError("Tên danh mục không được để trống.");
    const all = await this.meta.listCategories();
    const clash = all.find(
      (c) => c.parentId === parentId && c.id !== exceptId && compareNames(c.name, n) === 0,
    );
    if (clash) throw new UserFacingError(`Đã có danh mục “${clash.name}” ở đây.`);
    return n;
  }

  async createCategory(name: string, parentId: string | null): Promise<Category> {
    const c: Category = {
      id: newId(),
      name: await this.checkName(name, parentId),
      parentId,
      createdAt: Date.now(),
    };
    await this.meta.putCategory(c);
    return c;
  }

  async renameCategory(id: string, name: string): Promise<void> {
    const all = await this.meta.listCategories();
    const c = all.find((x) => x.id === id);
    if (!c) return;
    await this.meta.putCategory({ ...c, name: await this.checkName(name, c.parentId, id) });
  }

  /** Moves a shelf under another (null = top level). */
  async moveCategory(id: string, newParentId: string | null): Promise<void> {
    const all = await this.meta.listCategories();
    const c = all.find((x) => x.id === id);
    if (!c) return;
    if (newParentId && subtreeIds(all, id).has(newParentId)) {
      throw new UserFacingError("Không thể chuyển danh mục vào bên trong chính nó.");
    }
    const name = await this.checkName(c.name, newParentId, id);
    await this.meta.putCategory({ ...c, name, parentId: newParentId });
  }

  /**
   * Deletes a shelf. Its books and sub-shelves move up to the parent shelf,
   * so deleting a shelf never deletes a book.
   */
  async deleteCategory(id: string): Promise<void> {
    const all = await this.meta.listCategories();
    const c = all.find((x) => x.id === id);
    if (!c) return;
    const children = all.filter((x) => x.parentId === id).map((x) => ({ ...x, parentId: c.parentId }));
    // Keep sibling names unique after the move.
    const siblings = all.filter((x) => x.parentId === c.parentId && x.id !== id);
    for (const ch of children) {
      let n = ch.name;
      let k = 2;
      while (siblings.some((s) => compareNames(s.name, n) === 0)) n = `${ch.name} (${k++})`;
      ch.name = n;
      siblings.push(ch);
    }
    const bookIds = (await this.meta.list()).filter((b) => b.categoryId === id).map((b) => b.id);
    await this.meta.deleteCategory(id, bookIds, c.parentId, children);
  }

  async moveBooks(ids: string[], categoryId: string | null): Promise<void> {
    await this.meta.updateMany(ids, () => ({ categoryId }));
  }

  // ---- tags ---------------------------------------------------------

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.meta.update(id, { tags: mergeTags([], tags) });
  }

  async addTags(ids: string[], tags: string[]): Promise<void> {
    await this.meta.updateMany(ids, (b) => ({ tags: mergeTags(b.tags, tags) }));
  }

  async removeTag(ids: string[], tag: string): Promise<void> {
    await this.meta.updateMany(ids, (b) => ({ tags: b.tags.filter((t) => !sameTag(t, tag)) }));
  }

  /** Renames a tag on every book (merging if the new name already exists). */
  async renameTag(from: string, to: string): Promise<void> {
    const ids = (await this.meta.list()).filter((b) => b.tags.some((t) => sameTag(t, from))).map((b) => b.id);
    await this.meta.updateMany(ids, (b) => (b.tags.some((t) => sameTag(t, from)) ? { tags: mergeTags(b.tags.filter((t) => !sameTag(t, from)), [to]) } : {}));
  }

  async setIndexDone(id: string, indexDone: boolean): Promise<void> {
    await this.meta.update(id, { indexDone });
  }

  /** Runs before a new book is saved (e.g. to store the words of a converted file). */
  private onImportHooks: ((book: BookMeta, extra: { pageWords?: WordBox[][] }) => Promise<void>)[] = [];
  onImport(fn: (book: BookMeta, extra: { pageWords?: WordBox[][] }) => Promise<void>): void {
    this.onImportHooks.push(fn);
  }

  /** Runs once a new book is in the library (start indexing/OCR). */
  private onAddedHooks: ((book: BookMeta) => void)[] = [];
  onAdded(fn: (book: BookMeta) => void): void {
    this.onAddedHooks.push(fn);
  }

  /** The untouched original of a converted book (the .docx), or the file itself. */
  async readOriginal(id: string): Promise<File> {
    const b = await this.meta.get(id);
    return this.files.read(b?.source ? originalKey(id) : id);
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await this.meta.update(id, { favorite });
  }

  async setBookmarks(id: string, pages: number[]): Promise<void> {
    const clean = [...new Set(pages.filter((p) => Number.isInteger(p) && p > 0))].sort((a, b) => a - b);
    await this.meta.update(id, { bookmarks: clean });
  }

  async markOpened(id: string): Promise<void> {
    await this.meta.update(id, { lastOpenedAt: Date.now() });
  }

  async savePosition(id: string, lastPage: number, zoom: number): Promise<void> {
    await this.meta.update(id, { lastPage, zoom });
  }
}
