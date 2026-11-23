import { InkModel } from "../core/annotations/InkModel";
import { InkStore } from "../core/annotations/InkStore";
import { looksLikePdf, openPdf } from "../core/pdf/PdfEngine";
import { createFileStore } from "../core/storage/FileStore";
import { LibraryService, type DocInspector } from "../core/storage/LibraryService";
import { MetaStore } from "../core/storage/MetaStore";
import { fileFingerprint } from "../core/util/fingerprint";
import type { BookMeta } from "../core/types";
import { UserFacingError } from "../core/types";
import { toast } from "../ui/feedback";
import { LibraryView, type ShelfView } from "../ui/library/LibraryView";
import { DEFAULT_TOOLS, type ToolState } from "../ui/reader/InkLayer";
import { ReaderView } from "../ui/reader/ReaderView";

/** Composition root: builds the layers and switches between screens. */

const pdfInspector: DocInspector = {
  accepts: (file) => looksLikePdf(file),
  async inspect(file) {
    const doc = await openPdf(file);
    try {
      const cover = await doc.renderCover().catch(() => null);
      const fingerprint = await fileFingerprint(file);
      return { pageCount: doc.numPages, fingerprint, title: doc.metaTitle, cover };
    } finally {
      await doc.destroy();
    }
  },
};

export class App {
  readonly library: LibraryService;
  private libraryView: LibraryView;
  private reader: ReaderView | null = null;
  private opening = false;
  private inkStore = new InkStore();
  private meta: MetaStore;

  constructor(private readonly root: HTMLElement) {
    const meta = new MetaStore();
    this.meta = meta;
    this.library = new LibraryService(meta, createFileStore(), pdfInspector);
    this.library.onDelete((id) => this.inkStore.deleteBook(id));
    this.libraryView = new LibraryView({
      library: this.library,
      onOpen: (b) => void this.open(b),
      onFirstImport: () => void requestPersistentStorage(),
      loadView: () => meta.getSetting<ShelfView>("libraryView", { kind: "all" }),
      saveView: (v) => void meta.setSetting("libraryView", v),
    });
    window.addEventListener("popstate", () => {
      if (this.reader && !location.hash.startsWith("#read/")) void this.closeReader(false);
    });
  }

  async start(): Promise<void> {
    this.root.replaceChildren(this.libraryView.el);
    await this.libraryView.refresh();
    // Reload while reading -> reopen the same book.
    const m = location.hash.match(/^#read\/(.+)$/);
    if (m) {
      // Put the shelf underneath so "back" returns to it instead of exiting.
      history.replaceState(null, "", location.pathname + location.search);
      const b = await this.library.get(decodeURIComponent(m[1]));
      if (b) await this.open(b, true);
    }
  }

  async open(book: BookMeta, push = true): Promise<void> {
    if (this.opening || this.reader) return;
    this.opening = true;
    document.body.classList.add("busy");
    try {
      const file = await this.library.readFile(book.id);
      const doc = await openPdf(file);
      const fresh = (await this.library.get(book.id)) ?? book;
      await this.library.markOpened(book.id);
      const strokes = await this.inkStore.load(book.id);
      const ink = new InkModel(strokes, { savePage: (p, s) => this.inkStore.savePage(book.id, p, s) });
      const tools = { ...DEFAULT_TOOLS, ...(await this.meta.getSetting<Partial<ToolState>>("tools", {})) };
      this.reader = new ReaderView({
        book: fresh,
        doc,
        ink,
        tools,
        onClose: () => history.back(),
        onPosition: (page, zoom) => void this.library.savePosition(book.id, page, zoom),
        onToolsChange: (t) => void this.meta.setSetting("tools", t),
        onMargins: (m) => void this.library.setMargins(book.id, m),
      });
      if (push) history.pushState({ read: book.id }, "", `#read/${encodeURIComponent(book.id)}`);
      this.libraryView.el.remove();
      this.root.append(this.reader.el);
      this.reader.start();
      (window as unknown as { __reader?: ReaderView }).__reader = this.reader;
    } catch (e) {
      console.error(e);
      toast(e instanceof UserFacingError ? e.message : "Không mở được tài liệu.", "error");
    } finally {
      this.opening = false;
      document.body.classList.remove("busy");
    }
  }

  private async closeReader(popHistory: boolean): Promise<void> {
    const r = this.reader;
    if (!r) return;
    this.reader = null;
    (window as unknown as { __reader?: ReaderView }).__reader = undefined;
    if (popHistory) history.back();
    await r.destroy();
    this.root.replaceChildren(this.libraryView.el);
    await this.libraryView.refresh();
  }
}

async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not critical */
  }
}
