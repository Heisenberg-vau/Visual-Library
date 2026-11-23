import type { BookMeta, Category } from "../types";
import { compareNames, mergeTags, sameTag, subtreeIds } from "../library/shelves";
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
        categoryId,
        tags: [],
        margins: { left: 0, right: 0 },
        favorite: false,
        bookmarks: [],
      };
      await this.meta.put(book);
      if (info.cover) await this.meta.putCover(id, info.cover);
      report("inspect", 1);
      for (const fn of this.onImportHooks) fn(book);
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

  async delete(id: string): Promise<void> {
    await this.files.delete(id).catch(() => {}); // notebooks have no file
    await this.meta.delete(id);
    await this.onDeleteHooks.reduce((p, fn) => p.then(() => fn(id)), Promise.resolve());
  }

  /** Lets other modules (handwriting) clean up when a book is deleted. */
  private onDeleteHooks: ((id: string) => Promise<void>)[] = [];
  onDelete(fn: (id: string) => Promise<void>): void {
    this.onDeleteHooks.push(fn);
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
    const books = (await this.meta.list())
      .filter((b) => b.categoryId === id)
      .map((b) => ({ ...b, categoryId: c.parentId }));
    await this.meta.deleteCategory(id, books, children);
  }

  async moveBooks(ids: string[], categoryId: string | null): Promise<void> {
    const set = new Set(ids);
    const books = (await this.meta.list()).filter((b) => set.has(b.id));
    await this.meta.putMany(books.map((b) => ({ ...b, categoryId })));
  }

  // ---- tags ---------------------------------------------------------

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.meta.update(id, { tags: mergeTags([], tags) });
  }

  async addTags(ids: string[], tags: string[]): Promise<void> {
    const set = new Set(ids);
    const books = (await this.meta.list()).filter((b) => set.has(b.id));
    await this.meta.putMany(books.map((b) => ({ ...b, tags: mergeTags(b.tags, tags) })));
  }

  async removeTag(ids: string[], tag: string): Promise<void> {
    const set = new Set(ids);
    const books = (await this.meta.list()).filter((b) => set.has(b.id));
    await this.meta.putMany(books.map((b) => ({ ...b, tags: b.tags.filter((t) => !sameTag(t, tag)) })));
  }

  /** Renames a tag on every book (merging if the new name already exists). */
  async renameTag(from: string, to: string): Promise<void> {
    const books = (await this.meta.list()).filter((b) => b.tags.some((t) => sameTag(t, from)));
    await this.meta.putMany(
      books.map((b) => ({ ...b, tags: mergeTags(b.tags.filter((t) => !sameTag(t, from)), [to]) })),
    );
  }

  async setIndexDone(id: string, indexDone: boolean): Promise<void> {
    await this.meta.update(id, { indexDone });
  }

  /** Lets other modules react to a newly imported book (start indexing/OCR). */
  private onImportHooks: ((book: BookMeta) => void)[] = [];
  onImport(fn: (book: BookMeta) => void): void {
    this.onImportHooks.push(fn);
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
