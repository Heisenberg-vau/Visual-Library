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
import { HomeView } from "../ui/home3d/HomeView";
import { evictionCandidate, putOnDesk, removeFromDesk, type DeskItem } from "../core/desk";
import { DEFAULT_TOOLS, type ToolState } from "../ui/reader/InkLayer";
import { ReaderView, type NotebookHost } from "../ui/reader/ReaderView";
import { StudyStore } from "../core/study/StudyStore";
import { ReadingStore } from "../core/study/reading";
import { OcrEngine } from "../core/text/ocr";
import { TextIndexStore } from "../core/text/TextIndexStore";
import { IndexService } from "./IndexService";
import { dayKey } from "../core/study/dates";
import type { DailyGoal } from "../ui/library/GoalRing";
import { Ambience } from "../ui/study/Ambience";
import { PlannerView } from "../ui/study/PlannerView";
import { StudySession } from "../ui/study/StudySession";

/** Composition root: builds the layers and switches between screens. */

async function looksLikeDocx(file: Blob & { name?: string }): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  return zip && (/\.docx$/i.test(file.name ?? "") || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

const pdfInspector: DocInspector = {
  accepts: async (file) => ((await looksLikePdf(file)) ? "pdf" : (await looksLikeDocx(file)) ? "docx" : false),
  async inspect(file, onProgress, kind) {
    if (kind === "docx") {
      const { convertDocx } = await import("../core/docx/convertDocx");
      const conv = await convertDocx(file, onProgress);
      const doc = await openPdf(conv.pdf);
      try {
        const cover = await doc.renderCover().catch(() => null);
        const fingerprint = await fileFingerprint(file);
        return { pageCount: doc.numPages, fingerprint, title: conv.title, cover, converted: conv.pdf, pageWords: conv.pageWords };
      } finally {
        await doc.destroy();
      }
    }
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
  /** The 3D library room (home), when WebGL works and the user hasn't chosen the list. */
  private home: HomeView | null = null;
  private reader: ReaderView | null = null;
  private opening = false;
  private inkStore = new InkStore();
  private meta: MetaStore;
  readonly studyStore = new StudyStore();
  readonly readingStore = new ReadingStore();
  readonly textStore = new TextIndexStore();
  readonly ocr = new OcrEngine();
  readonly index: IndexService;
  readonly ambience: Ambience;
  readonly study: StudySession;
  private planner: PlannerView | null = null;

  constructor(private readonly root: HTMLElement) {
    const meta = new MetaStore();
    this.meta = meta;
    this.library = new LibraryService(meta, createFileStore(), pdfInspector);
    this.library.onDelete((id) => this.inkStore.deleteBook(id));
    this.library.onDelete((id) => this.readingStore.deleteBook(id));
    this.library.onDelete(async (id) => {
      this.index.remove(id);
      await this.textStore.deleteBook(id);
    });
    this.index = new IndexService(this.library, this.textStore, this.ocr, async (id) => openPdf(await this.library.readFile(id)));
    this.library.onImport(async (b, extra) => {
      if (!extra.pageWords) return;
      for (let page = 0; page < extra.pageWords.length; page++) {
        await this.textStore.put({ bookId: b.id, page, source: "docx", words: extra.pageWords[page] });
      }
    });
    this.library.onAdded((b) => {
      if (b.kind === "pdf" && !b.indexDone) this.index.enqueue(b.id);
    });
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
      index: this.index,
      goal: {
        get: () => meta.getSetting<DailyGoal | null>("dailyGoal", null),
        set: (g) => meta.setSetting("dailyGoal", g),
        pagesToday: async () => (await this.readingStore.getDay(dayKey(new Date()))).keys.length,
        minutesToday: () => Math.floor(this.study.todayTotal / 60_000),
      },
    });
    if (HomeView.supported()) {
      this.home = new HomeView({
        library: this.library,
        loadReading: () => this.readingStore.all(),
        onOpen: (b) => void this.open(b),
        onList: () => void this.setHomeMode("list"),
        onPlanner: () => void this.openPlanner(),
        onFirstImport: () => void requestPersistentStorage(),
        loadDesk: () => this.loadDesk(),
        saveDesk: (d) => this.meta.setSetting("desk", d),
        loadTasks: () => this.studyStore.listTasks(),
        putTask: (t) => this.studyStore.putTask(t),
        editTask: async (t, date, kind) => {
          // the planner's own dialog, without leaving the room
          const pv = new PlannerView({ store: this.studyStore, library: this.library, onBack: () => {}, onOpenBook: (id, page) => void this.openAt(id, page) });
          await pv.refresh();
          return pv.edit(t, date, kind);
        },
      });
    }
    this.library.onDelete(async (id) => {
      const d = await this.loadDesk();
      if (d.some((x) => x.id === id)) await this.meta.setSetting("desk", removeFromDesk(d, id));
    });
    this.libraryView.onSwitchTo3d = this.home ? () => void this.setHomeMode("3d") : null;
    window.addEventListener("popstate", () => {
      if (this.reader && !location.hash.startsWith("#read/")) void this.closeReader(false);
      if (this.planner && location.hash !== "#plan") void this.closePlanner();
    });
  }

  async start(): Promise<void> {
    await Promise.all([this.ambience.init(), this.study.init()]);
    void this.index.enqueueAll();
    await this.showHome();
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
      await this.toDesk(book);
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
        indexer: book.kind === "pdf" ? await this.index.get(book.id) : null,
        index: this.index,
      });
      this.study.bookId = book.id;
      if (push) history.pushState({ read: book.id }, "", `#read/${encodeURIComponent(book.id)}`);
      this.libraryView.el.remove();
      this.home?.pause();
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
    this.home?.pause();
    this.root.replaceChildren(this.planner.el);
    await this.planner.refresh();
    (window as unknown as { __planner?: PlannerView }).__planner = this.planner;
  }

  private async closePlanner(): Promise<void> {
    if (!this.planner) return;
    this.planner = null;
    await this.showHome();
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
    await this.showHome();
  }

  // ---- the study desk ------------------------------------------------------

  private loadDesk(): Promise<DeskItem[]> {
    return this.meta.getSetting<DeskItem[]>("desk", []);
  }

  /** Whatever you open lies on the desk until you put it back (max 6). */
  private async toDesk(book: BookMeta): Promise<void> {
    const desk = await this.loadDesk();
    if (desk.some((d) => d.id === book.id)) return;
    const all = new Map((await this.library.list()).map((b) => [b.id, b]));
    const last = (id: string) => all.get(id)?.lastOpenedAt ?? 0;
    const c = desk.length >= 6 ? evictionCandidate(desk, last) : null;
    const r = putOnDesk(desk, book.id, Date.now(), last);
    await this.meta.setSetting("desk", r.items);
    if (r.evicted && c) toast(`Bàn đã đủ 6 cuốn: đã cất “${all.get(c.id)?.title ?? ""}” lên kệ.`);
  }

  // ---- home: 3D room or list ---------------------------------------------

  private get homeMode(): "3d" | "list" {
    try {
      return this.home && localStorage.getItem("vl.home") !== "list" ? "3d" : "list";
    } catch {
      return this.home ? "3d" : "list";
    }
  }

  private async setHomeMode(m: "3d" | "list"): Promise<void> {
    try {
      localStorage.setItem("vl.home", m);
    } catch {
      /* ignore */
    }
    await this.showHome();
  }

  private async showHome(): Promise<void> {
    if (this.homeMode === "3d" && this.home) {
      this.root.replaceChildren(this.home.el);
      await this.home.refresh();
    } else {
      this.home?.pause();
      this.root.replaceChildren(this.libraryView.el);
      await this.libraryView.refresh();
    }
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
