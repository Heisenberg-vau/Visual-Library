import { InkModel } from "../core/annotations/InkModel";
import { InkStore } from "../core/annotations/InkStore";
import { NotebookDocument } from "../core/notebook/NotebookDocument";
import type { PageLink } from "../core/annotations/types";
import type { PagedDocument } from "../core/pdf/PagedDocument";
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
import { ReaderView, type NotebookHost } from "../ui/reader/ReaderView";
import { StudyStore } from "../core/study/StudyStore";
import { ReadingStore } from "../core/study/reading";
import { dayKey } from "../core/study/dates";
import type { DailyGoal } from "../ui/library/GoalRing";
import { Ambience } from "../ui/study/Ambience";
import { PlannerView } from "../ui/study/PlannerView";
import { StudySession } from "../ui/study/StudySession";

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
  readonly studyStore = new StudyStore();
  readonly readingStore = new ReadingStore();
  readonly ambience: Ambience;
  readonly study: StudySession;
  private planner: PlannerView | null = null;

  constructor(private readonly root: HTMLElement) {
    const meta = new MetaStore();
    this.meta = meta;
    this.library = new LibraryService(meta, createFileStore(), pdfInspector);
    this.library.onDelete((id) => this.inkStore.deleteBook(id));
    this.library.onDelete((id) => this.readingStore.deleteBook(id));
    this.ambience = new Ambience(meta);
    this.study = new StudySession(
      meta,
      this.studyStore,
      this.ambience.sound,
      () => void this.openPlanner(),
      (t) => (t.bookId ? void this.openAt(t.bookId, t.page) : void this.openPlanner()),
    );
    this.libraryView = new LibraryView({
      library: this.library,
      onOpen: (b) => void this.open(b),
      onFirstImport: () => void requestPersistentStorage(),
      loadView: () => meta.getSetting<ShelfView>("libraryView", { kind: "all" }),
      saveView: (v) => void meta.setSetting("libraryView", v),
      study: this.study,
      onPlanner: () => void this.openPlanner(),
      loadTasks: () => this.studyStore.listTasks(),
      loadReading: () => this.readingStore.all(),
      goal: {
        get: () => meta.getSetting<DailyGoal | null>("dailyGoal", null),
        set: (g) => meta.setSetting("dailyGoal", g),
        pagesToday: async () => (await this.readingStore.getDay(dayKey(new Date()))).keys.length,
        minutesToday: () => Math.floor(this.study.todayTotal / 60_000),
      },
    });
    window.addEventListener("popstate", () => {
      if (this.reader && !location.hash.startsWith("#read/")) void this.closeReader(false);
      if (this.planner && location.hash !== "#plan") void this.closePlanner();
    });
  }

  async start(): Promise<void> {
    await Promise.all([this.ambience.init(), this.study.init()]);
    this.root.replaceChildren(this.libraryView.el);
    await this.libraryView.refresh();
    // Reload while reading -> reopen the same book.
    const m = location.hash.match(/^#read\/(.+)$/);
    if (m) {
      // Put the shelf underneath so "back" returns to it instead of exiting.
      history.replaceState(null, "", location.pathname + location.search);
      const b = await this.library.get(decodeURIComponent(m[1]));
      if (b) await this.open(b, true);
    } else if (location.hash === "#plan") {
      history.replaceState(null, "", location.pathname + location.search);
      await this.openPlanner();
    }
  }

  private async openDoc(book: BookMeta): Promise<PagedDocument> {
    if (book.kind === "notebook") {
      return new NotebookDocument(book.fingerprint, book.pageCount, book.paper ?? "lines");
    }
    return openPdf(await this.library.readFile(book.id));
  }

  private async openInk(id: string): Promise<InkModel> {
    const strokes = await this.inkStore.load(id);
    return new InkModel(strokes, { savePage: (p, s) => this.inkStore.savePage(id, p, s) });
  }

  private async notebookHost(book: BookMeta): Promise<NotebookHost> {
    const companionKey = `companion:${book.id}`;
    const companionId = await this.meta.getSetting<string | null>(companionKey, null);
    const splitRatio = await this.meta.getSetting<number>("splitRatio", 0.5);
    const host: NotebookHost = {
      list: async () => (await this.library.list()).filter((b) => b.kind === "notebook"),
      create: (name, paper) => this.library.createNotebook(name, book.kind === "notebook" ? null : book.categoryId, paper),
      open: async (id) => {
        const meta = await this.library.get(id);
        if (!meta || meta.kind !== "notebook") throw new Error("notebook missing");
        await this.library.markOpened(id);
        const doc = new NotebookDocument(meta.fingerprint, meta.pageCount, meta.paper ?? "lines");
        return { meta, doc, ink: await this.openInk(id) };
      },
      setPageCount: (id, n) => void this.library.setPageCount(id, n),
      savePosition: (id, page, zoom) => void this.library.savePosition(id, page, zoom),
      companionId,
      setCompanion: (id) => {
        host.companionId = id;
        void this.meta.setSetting(companionKey, id);
      },
      openLink: (link, notebookId) => void this.followLink(link, notebookId),
      splitRatio,
      saveSplitRatio: (r) => {
        host.splitRatio = r;
        void this.meta.setSetting("splitRatio", r);
      },
    };
    return host;
  }

  /** A notebook link to another book: open that book at the page, notebook beside it. */
  private async followLink(link: PageLink, notebookId: string | null): Promise<void> {
    const target = await this.library.get(link.bookId);
    if (!target) {
      toast("Sách của liên kết này không còn trên kệ.", "error");
      return;
    }
    await this.library.savePosition(target.id, link.page, target.zoom);
    if (notebookId) await this.meta.setSetting(`companion:${target.id}`, notebookId);
    await this.closeReader(false, false);
    await this.open(target, false);
    history.replaceState({ read: target.id }, "", `#read/${encodeURIComponent(target.id)}`);
  }

  async open(book: BookMeta, push = true): Promise<void> {
    if (this.opening || this.reader) return;
    this.opening = true;
    document.body.classList.add("busy");
    try {
      const doc = await this.openDoc(book);
      const fresh = (await this.library.get(book.id)) ?? book;
      await this.library.markOpened(book.id);
      const ink = await this.openInk(book.id);
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
        getFile: () => this.library.readFile(book.id),
        notebooks: await this.notebookHost(fresh),
        study: this.study,
        ambience: this.ambience,
        onPageRead: (p) => void this.readingStore.markRead(book.id, p, dayKey(new Date())),
        onBookmarks: (pages) => void this.library.setBookmarks(book.id, pages),
      });
      this.study.bookId = book.id;
      if (push) history.pushState({ read: book.id }, "", `#read/${encodeURIComponent(book.id)}`);
      this.libraryView.el.remove();
      this.root.replaceChildren(this.reader.el);
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

  // ---- planner --------------------------------------------------------

  async openPlanner(): Promise<void> {
    if (this.planner) return;
    if (this.reader) {
      await this.closeReader(false, false);
      history.replaceState(null, "", location.pathname + location.search);
    }
    this.planner = new PlannerView({
      store: this.studyStore,
      library: this.library,
      onBack: () => history.back(),
      onOpenBook: (id, page) => void this.openAt(id, page),
    });
    history.pushState({ plan: true }, "", "#plan");
    this.root.replaceChildren(this.planner.el);
    await this.planner.refresh();
    (window as unknown as { __planner?: PlannerView }).__planner = this.planner;
  }

  private async closePlanner(): Promise<void> {
    if (!this.planner) return;
    this.planner = null;
    this.root.replaceChildren(this.libraryView.el);
    await this.libraryView.refresh();
  }

  /** Opens a book (or notebook) at a page, e.g. from a planned task. */
  async openAt(bookId: string, page: number | null): Promise<void> {
    const b = await this.library.get(bookId);
    if (!b) {
      toast("Sách/vở này không còn trên kệ.", "error");
      return;
    }
    if (page) await this.library.savePosition(b.id, Math.min(page, b.pageCount), b.zoom);
    if (this.planner) {
      this.planner = null;
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (this.reader) await this.closeReader(false, false);
    await this.open(b, true);
  }

  private async closeReader(popHistory: boolean, showShelf = true): Promise<void> {
    const r = this.reader;
    if (!r) return;
    this.reader = null;
    this.study.bookId = null;
    (window as unknown as { __reader?: ReaderView }).__reader = undefined;
    if (popHistory) history.back();
    await r.destroy();
    if (!showShelf) return;
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
