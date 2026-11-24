import type { LibraryService, ImportResult } from "../../core/storage/LibraryService";
import type { BookMeta, Category } from "../../core/types";
import type { BookReading } from "../../core/study/reading";
import { h, icon } from "../dom";
import { confirmDialog, popupMenu, toast } from "../feedback";
import { DESK_MAX, dustLevel, evictionCandidate, idleDays, putOnDesk, removeFromDesk, type DeskItem } from "../../core/desk";
import type { SpineStyle } from "./textures";
import { LibraryWorld, type BoardNote, type DeskEntry, type NoteKey, type WorldBook, type WorldStack, type WorldView } from "./World";
import { boardSections, isOverdue, toggled, type BoardSections, type Task } from "../../core/study/tasks";
import { addDays, countdown, dayKey, daysBetween, friendlyDay, weekdayName } from "../../core/study/dates";

/*
 * The library as a 3D room (the app's home): stacks built from the user's
 * shelves, the desk and the pinboard. Management (tags, renaming, deleting…)
 * stays in the list view ("Danh sách"), one tap away.
 */

export interface HomeDeps {
  library: LibraryService;
  loadReading: () => Promise<Map<string, BookReading>>;
  onOpen: (b: BookMeta) => void;
  onList: () => void;
  onPlanner: () => void;
  onFirstImport: () => void;
  loadDesk: () => Promise<DeskItem[]>;
  saveDesk: (items: DeskItem[]) => Promise<void>;
  /** The planner's tasks, shown on the pinboard. */
  loadTasks: () => Promise<Task[]>;
  putTask: (t: Task) => Promise<void>;
  /** The planner's task dialog (create when t = null). True if saved. */
  editTask: (t: Task | null, date?: string | null, kind?: Task["kind"]) => Promise<boolean>;
}

const VIEW_KEY = "vl.view";
const SPINE_KEY = "vl.spine";

export class HomeView {
  readonly el: HTMLElement;
  private world: LibraryWorld | null = null;
  private bar: HTMLElement;
  private where: HTMLElement;
  private panel: HTMLElement;
  private fileInput: HTMLInputElement;
  private books = new Map<string, BookMeta>();
  private reading = new Map<string, BookReading>();
  private signature = "";
  private colors = new Map<string, string>();
  private stacks: WorldStack[] = [];
  private busy = false;
  private desk: DeskItem[] = [];
  private sections: BoardSections | null = null;
  private note: NoteKey = "today";

  /** WebGL may be unavailable (very old devices): then the list view is used. */
  static supported(): boolean {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      return false;
    }
  }

  constructor(private readonly deps: HomeDeps) {
    this.where = h("span", { class: "h3-where", "data-testid": "h3-where" });
    this.fileInput = h("input", { type: "file", accept: "application/pdf,.pdf,.docx", multiple: true, hidden: true, "data-testid": "h3-file-input" }) as HTMLInputElement;
    this.fileInput.addEventListener("change", () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = "";
      if (files.length) void this.importFiles(files);
    });
    const btn = (label: string, testid: string, run: () => void, ic?: string) => {
      const b = h("button", { class: "h3-btn", type: "button", "data-testid": testid }, ic ? h("span", { html: icon(ic, 18) }) : null, label);
      b.addEventListener("click", run);
      return b;
    };
    const more = h("button", { class: "h3-btn h3-icon", type: "button", "aria-label": "Thêm", "data-testid": "h3-more", html: icon("more", 20) });
    more.addEventListener("click", () =>
      popupMenu(more, [
        { label: "Danh sách & quản lý sách", run: () => this.deps.onList() },
        {
          label: `Chữ trên gáy: ${this.spineStyle === "up" ? "từ dưới lên (nghiêng đầu sang trái)" : "từ trên xuống (nghiêng đầu sang phải)"} → đổi`,
          run: () => this.toggleSpine(),
        },
      ]),
    );
    this.bar = h(
      "header",
      { class: "h3-bar" },
      h("span", { class: "h3-brand", html: icon("emblem", 26) }),
      h("span", { class: "h3-title" }, "Visual Library"),
      this.where,
      h("span", { class: "grow" }),
      btn("Sảnh", "h3-hall", () => this.world?.goTo({ kind: "hall" }), "home"),
      btn("Bảng ghim", "h3-board", () => this.world?.goTo({ kind: "board" }), "calendar"),
      btn("Nhập sách", "h3-import", () => this.fileInput.click(), "plus"),
      btn("Danh sách", "h3-list", () => this.deps.onList(), "list"),
      more,
      this.fileInput,
    );
    this.panel = h("aside", { class: "h3-panel", "data-testid": "h3-panel", hidden: true });
    this.el = h("div", { class: "home3d", "data-testid": "home3d" }, this.bar, this.panel);
  }

  private get spineStyle(): SpineStyle {
    return (localStorage.getItem(SPINE_KEY) as SpineStyle) || "up";
  }

  private ensureWorld(): LibraryWorld {
    if (this.world) return this.world;
    this.world = new LibraryWorld(
      {
        onView: (v) => this.onView(v),
        onPulled: (b) => this.renderPanel(b),
        onDeskBook: (id) => {
          const b = this.books.get(id);
          if (b) this.deps.onOpen(b);
        },
        onNote: (key) => {
          this.note = key;
          this.renderBoard();
        },
      },
      this.spineStyle,
    );
    this.el.prepend(this.world.el);
    (window as unknown as { __world?: LibraryWorld }).__world = this.world;
    return this.world;
  }

  /** Called whenever the home screen is shown. Rebuilds only if the library changed. */
  async refresh(): Promise<void> {
    const world = this.ensureWorld();
    world.resume();
    const [books, cats, reading, desk] = await Promise.all([this.deps.library.list(), this.deps.library.listCategories(), this.deps.loadReading(), this.deps.loadDesk()]);
    this.reading = reading;
    this.books = new Map(books.map((b) => [b.id, b]));
    this.desk = desk.filter((d) => this.books.has(d.id));
    const sig = JSON.stringify([
      books.map((b) => [b.id, b.title, b.categoryId, b.pageCount, b.favorite, b.lastPage > 1, b.kind]),
      cats.map((c) => [c.id, c.name, c.parentId]),
      this.spineStyle,
    ]);
    if (sig !== this.signature) {
      // read where the user was before rebuilding (rebuilding reports a view too)
      const saved = this.savedView();
      this.signature = sig;
      await this.loadColors(books);
      this.stacks = this.buildStacks(books, cats);
      world.setStacks(this.stacks, this.deskEntries());
      this.restoreView(saved);
    } else world.setDesk(this.deskEntries());
    await this.loadBoard();
    const v = world.currentView;
    if (v.kind === "desk") this.renderDesk();
    if (v.kind === "board") this.renderBoard();
    this.el.dataset.ready = "1";
  }

  private deskEntries(): DeskEntry[] {
    const now = Date.now();
    return this.desk.map((d) => ({ id: d.id, dust: dustLevel(idleDays(d, this.books.get(d.id)?.lastOpenedAt ?? 0, now)) }));
  }

  private lastOpened = (id: string) => this.books.get(id)?.lastOpenedAt ?? 0;

  pause(): void {
    this.world?.pause();
  }

  // ------------------------------------------------------------ data → stacks

  private buildStacks(books: BookMeta[], cats: Category[]): WorldStack[] {
    const byId = new Map(cats.map((c) => [c.id, c]));
    const rootOf = (id: string | null): Category | null => {
      let c = id ? byId.get(id) ?? null : null;
      while (c?.parentId && byId.get(c.parentId)) c = byId.get(c.parentId)!;
      return c;
    };
    const tierOf = (id: string | null): Category | null => {
      // the child of the root on the path (2 levels: stack › tier)
      let c = id ? byId.get(id) ?? null : null;
      while (c?.parentId && byId.get(c.parentId)?.parentId) c = byId.get(c.parentId)!;
      return c?.parentId ? c : null;
    };
    const coll = new Intl.Collator("vi");
    const roots = cats.filter((c) => !c.parentId).sort((a, b) => a.createdAt - b.createdAt);
    const stacks: WorldStack[] = roots.map((r) => {
      const children = cats.filter((c) => c.parentId === r.id).sort((a, b) => a.createdAt - b.createdAt);
      return { id: r.id, name: r.name, tiers: [{ name: r.name, books: [] }, ...children.map((c) => ({ name: c.name, books: [] as WorldBook[] }))] };
    });
    const loose: WorldStack = { id: null, name: "Chưa xếp kệ", tiers: [{ name: "Chưa xếp kệ", books: [] }] };
    const sorted = [...books].sort((a, b) => coll.compare(a.title, b.title));
    for (const b of sorted) {
      const wb = this.toWorldBook(b);
      const root = rootOf(b.categoryId);
      if (!root) {
        loose.tiers[0].books.push(wb);
        continue;
      }
      const stack = stacks[roots.indexOf(root)];
      const tier = tierOf(b.categoryId);
      const ti = tier ? stack.tiers.findIndex((t, i) => i > 0 && t.name === tier.name) : 0;
      stack.tiers[Math.max(0, ti)].books.push(wb);
    }
    for (const s of stacks) {
      // drop the stack-wide tier when nothing sits directly on it
      if (!s.tiers[0].books.length && s.tiers.length > 1) s.tiers.shift();
      else if (s.tiers.length > 1) s.tiers[0].name = `${s.name} – chung`;
    }
    const out = stacks;
    if (loose.tiers[0].books.length || !out.length) out.push(loose);
    return out;
  }

  private toWorldBook(b: BookMeta): WorldBook {
    const nb = b.kind === "notebook";
    return {
      id: b.id,
      title: b.title,
      subtitle: nb ? `Vở · ${b.pageCount} trang` : `${b.pageCount} trang${b.source === "docx" ? " · Word" : ""}`,
      pages: b.pageCount,
      color: this.colors.get(b.id) ?? fallbackColor(b.id, nb),
      cloth: nb,
      ribbon: !nb && b.lastPage > 1,
      favorite: !!b.favorite,
      cover: () => this.deps.library.getCover(b.id),
    };
  }

  /** Spine colours from the covers, made leathery (dark, a bit muted). */
  private async loadColors(books: BookMeta[]): Promise<void> {
    const todo = books.filter((b) => b.kind !== "notebook" && !this.colors.has(b.id));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 12;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    for (const b of todo) {
      try {
        const blob = await this.deps.library.getCover(b.id);
        if (!blob) continue;
        const bmp = await createImageBitmap(blob, { resizeWidth: 12, resizeHeight: 12 });
        ctx.drawImage(bmp, 0, 0, 12, 12);
        bmp.close();
        this.colors.set(b.id, leatherFrom(ctx.getImageData(0, 0, 12, 12).data, b.id));
      } catch {
        /* keep the fallback colour */
      }
    }
  }

  // ------------------------------------------------------------ view state

  private onView(v: WorldView): void {
    const s = v.kind === "stack" ? this.stacks[v.index] : null;
    this.where.textContent = v.kind === "hall" ? "· Sảnh" : v.kind === "desk" ? "· Bàn học" : v.kind === "board" ? "· Bảng ghim" : `· Kệ sách › ${s?.name ?? ""}`;
    this.el.dataset.view = v.kind === "stack" ? `stack:${v.index}` : v.kind;
    // remember where the user was (a stack by its shelf id, so it survives reordering)
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v.kind === "stack" ? { kind: "stack", id: s?.id ?? null } : v));
    } catch {
      /* ignore */
    }
    if (v.kind === "desk") this.renderDesk();
    else if (v.kind === "board") this.renderBoard();
    else if (!this.world?.pulledBook) this.panel.hidden = true;
  }

  private savedView(): { kind: string; id?: string | null } | null {
    try {
      return JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    } catch {
      return null;
    }
  }

  private restoreView(saved: { kind: string; id?: string | null } | null): void {
    const world = this.world!;
    let v: WorldView = { kind: "hall" };
    try {
      if (saved?.kind === "stack") {
        const i = this.stacks.findIndex((s) => s.id === (saved.id ?? null));
        if (i >= 0) v = { kind: "stack", index: i };
      } else if (saved?.kind === "desk" || saved?.kind === "board") v = { kind: saved.kind };
    } catch {
      /* first visit: the hall */
    }
    world.goTo(v, true);
  }

  // ------------------------------------------------------------ pulled-out book

  private renderPanel(wb: WorldBook | null): void {
    if (!wb) {
      if (this.world?.currentView.kind !== "desk") this.panel.hidden = true;
      return;
    }
    const b = this.books.get(wb.id);
    if (!b) return;
    const r = this.reading.get(b.id);
    const pct = r && b.pageCount ? Math.round((r.count / b.pageCount) * 100) : 0;
    const open = h("button", { class: "h3-primary", type: "button", "data-testid": "h3-open" }, b.kind === "notebook" ? "Mở vở" : "Mở sách");
    open.addEventListener("click", () => void this.takeAndOpen(b));
    const fav = h("button", { class: `h3-ghost ${b.favorite ? "on" : ""}`, type: "button", "data-testid": "h3-fav", title: "Yêu thích" }, b.favorite ? "★" : "☆");
    fav.addEventListener("click", async () => {
      await this.deps.library.setFavorite(b.id, !b.favorite);
      await this.refresh();
    });
    const back = h("button", { class: "h3-ghost", type: "button", "data-testid": "h3-back" }, "Cất lại");
    back.addEventListener("click", () => this.world?.putBack());
    const tags = (b.tags ?? []).map((t) => h("span", { class: "h3-tag" }, `#${t}`));
    this.panel.hidden = false;
    const parts: (HTMLElement | null)[] = [
      h("div", { class: "h3-k" }, "RÚT RA KHỎI KỆ"),
      h("div", { class: "h3-t", "data-testid": "h3-title" }, b.title),
      h("div", { class: "h3-muted" }, wb.subtitle),
      b.kind === "notebook"
        ? null
        : h(
            "div",
            { class: "h3-progress" },
            h("div", { class: "h3-bar-track" }, h("i", { style: `width:${pct}%` })),
            h("span", {}, b.lastPage > 1 ? `Đã đọc ${pct}% · đang ở trang ${b.lastPage}` : "Chưa đọc"),
          ),
      tags.length ? h("div", { class: "h3-tags" }, ...tags) : null,
      h("div", { class: "h3-row" }, open, fav, back),
    ];
    this.panel.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  // ------------------------------------------------------------ the desk

  /** "Mở sách": the book goes onto the desk (making room if needed), then opens. */
  private async takeAndOpen(b: BookMeta): Promise<void> {
    const world = this.world!;
    if (!this.desk.some((d) => d.id === b.id)) {
      if (this.desk.length >= DESK_MAX) {
        const c = evictionCandidate(this.desk, this.lastOpened)!;
        const name = this.books.get(c.id)?.title ?? "một cuốn";
        const ok = await confirmDialog(
          "Bàn học đã đủ 6 cuốn",
          `Cất “${name}” (lâu nhất chưa mở) lên kệ để lấy “${b.title}” xuống bàn?`,
          "Cất và lấy sách",
        );
        if (!ok) return;
        await world.returnFromDesk(c.id);
        this.desk = removeFromDesk(this.desk, c.id);
      }
      this.desk = putOnDesk(this.desk, b.id, Date.now(), this.lastOpened).items;
      await this.deps.saveDesk(this.desk);
      world.goTo({ kind: "desk" });
      await world.moveToDesk(b.id);
    }
    this.deps.onOpen(b);
  }

  private async putBack(id: string): Promise<void> {
    this.desk = removeFromDesk(this.desk, id);
    await this.deps.saveDesk(this.desk);
    this.renderDesk();
    await this.world?.returnFromDesk(id);
  }

  private renderDesk(): void {
    if (this.world?.currentView.kind !== "desk") return;
    const now = Date.now();
    const rows = this.desk.map((d) => {
      const b = this.books.get(d.id)!;
      const days = idleDays(d, b.lastOpenedAt ?? 0, now);
      const dusty = dustLevel(days) > 0;
      const read = h("button", { class: "h3-ghost", type: "button", "data-testid": "desk-open" }, "Đọc tiếp");
      read.addEventListener("click", () => this.deps.onOpen(b));
      const back = h("button", { class: "h3-ghost", type: "button", "data-testid": "desk-back" }, "Cất lên kệ");
      back.addEventListener("click", () => void this.putBack(d.id));
      return h(
        "div",
        { class: `desk-row ${dusty ? "dusty" : ""}`, "data-testid": "desk-row", "data-id": d.id },
        h(
          "div",
          { class: "desk-info" },
          h("div", { class: "desk-title" }, b.title),
          h("div", { class: "h3-muted" }, b.kind === "notebook" ? `Vở · trang ${b.lastPage}` : `Trang ${b.lastPage}/${b.pageCount}`),
          dusty ? h("div", { class: "desk-dust", "data-testid": "desk-dust" }, `Phủ bụi · ${days} ngày chưa mở – cất lên kệ?`) : null,
        ),
        h("div", { class: "desk-actions" }, read, back),
      );
    });
    this.panel.hidden = false;
    this.panel.replaceChildren(
      h("div", { class: "h3-k", "data-testid": "desk-count" }, `TRÊN BÀN · ${this.desk.length}/${DESK_MAX}`),
      ...(rows.length ? rows : [h("p", { class: "h3-muted" }, "Bàn đang trống. Rút một cuốn từ kệ và bấm “Mở sách” – sách sẽ nằm ở đây cho tới khi bạn cất.")]),
    );
  }

  // ------------------------------------------------------------ the pinboard

  private today(): string {
    return dayKey(new Date());
  }

  private async loadBoard(): Promise<void> {
    const today = this.today();
    this.sections = boardSections(await this.deps.loadTasks(), today);
    const s = this.sections;
    const notes: BoardNote[] = [
      {
        key: "today",
        title: "Hôm nay",
        lines: s.today.map((t) => ({ text: t.title, box: true, done: t.done, urgent: isOverdue(t, today), right: isOverdue(t, today) ? "trễ hạn" : undefined })),
        more: Math.max(0, s.today.length - 6),
        alert: s.today.some((t) => isOverdue(t, today)),
      },
      { key: "week", title: "Tuần này", lines: s.week.map((t) => ({ text: t.title, box: true, right: weekdayName(t.date!) })), more: Math.max(0, s.week.length - 6), alert: false },
      { key: "goals", title: "Dự định", lines: s.goals.map((t) => ({ text: `• ${t.title}`, right: t.date ? friendlyDay(t.date, today) : undefined })), more: Math.max(0, s.goals.length - 6), alert: false },
      {
        key: "events",
        title: "Sự kiện sắp tới",
        lines: s.events.map((t) => ({ text: t.title, right: countdown(t.date!, today), urgent: daysBetween(today, t.date!) <= 3 })),
        more: Math.max(0, s.events.length - 6),
        alert: s.events.some((t) => daysBetween(today, t.date!) <= 7),
      },
    ];
    this.world?.setBoard(notes);
  }

  private renderBoard(): void {
    if (this.world?.currentView.kind !== "board" || !this.sections) return;
    const today = this.today();
    const s = this.sections;
    const names: Record<NoteKey, string> = { today: "Hôm nay", week: "Tuần này", goals: "Dự định", events: "Sự kiện" };
    const lists: Record<NoteKey, Task[]> = { today: s.today, week: s.week, goals: s.goals, events: s.events };
    const tabs = h(
      "div",
      { class: "board-tabs" },
      ...(Object.keys(names) as NoteKey[]).map((k) => {
        const b = h("button", { class: `board-tab ${k === this.note ? "on" : ""}`, type: "button", "data-testid": `board-tab-${k}` }, names[k], h("span", { class: "board-n" }, String(lists[k].filter((t) => !t.done).length)));
        b.addEventListener("click", () => {
          this.note = k;
          this.renderBoard();
        });
        return b;
      }),
    );
    const rows = lists[this.note].map((t) => {
      const box = h("input", { type: "checkbox", class: "board-check", "data-testid": "board-check" }) as HTMLInputElement;
      box.checked = t.done;
      box.addEventListener("change", () => void this.tick(t));
      const meta =
        t.kind === "deadline" && t.date
          ? countdown(t.date, today)
          : t.date
            ? isOverdue(t, today)
              ? `trễ · ${friendlyDay(t.date, today)}`
              : friendlyDay(t.date, today)
            : t.kind === "goal"
              ? "không hẹn ngày"
              : "";
      const title = h("button", { class: `board-item ${t.done ? "done" : ""}`, type: "button", "data-testid": "board-item" }, h("span", { class: "board-title" }, t.title), meta ? h("span", { class: `board-meta ${isOverdue(t, today) ? "late" : ""}` }, meta) : null);
      title.addEventListener("click", () => void this.editTask(t));
      return h("div", { class: "board-row" }, box, title);
    });
    const add = h("button", { class: "h3-primary", type: "button", "data-testid": "board-add" }, `+ Ghim vào “${names[this.note]}”`);
    add.addEventListener("click", () => {
      const presets: Record<NoteKey, [string | null, Task["kind"]]> = {
        today: [today, "task"],
        week: [addDays(today, 1), "task"],
        goals: [null, "goal"],
        events: [addDays(today, 7), "deadline"],
      };
      const [d, k] = presets[this.note];
      void this.editTask(null, d, k);
    });
    const full = h("button", { class: "h3-ghost", type: "button", "data-testid": "board-planner" }, "Sổ kế hoạch");
    full.addEventListener("click", () => this.deps.onPlanner());
    this.panel.hidden = false;
    this.panel.replaceChildren(
      h("div", { class: "h3-k" }, "BẢNG GHIM"),
      tabs,
      ...(rows.length ? rows : [h("p", { class: "h3-muted" }, "Chưa có gì ở đây.")]),
      h("div", { class: "h3-row" }, add, full),
    );
  }

  private async tick(t: Task): Promise<void> {
    const { update, next } = toggled(t, this.today());
    await this.deps.putTask(update);
    if (next) {
      await this.deps.putTask(next);
      toast(`Tốt lắm! Lần tới: ${friendlyDay(next.date!, this.today())}.`);
    } else if (update.done) toast("Tốt lắm! Đã đánh dấu xong.");
    await this.loadBoard();
    this.renderBoard();
  }

  private async editTask(t: Task | null, date?: string | null, kind?: Task["kind"]): Promise<void> {
    if (await this.deps.editTask(t, date, kind)) {
      await this.loadBoard();
      this.renderBoard();
    }
  }

  // ------------------------------------------------------------ import & settings

  private async importFiles(files: File[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const v = this.world?.currentView;
    const stackId = v?.kind === "stack" ? this.stacks[v.index]?.id ?? null : null;
    const had = this.books.size;
    try {
      const results: ImportResult[] = await this.deps.library.importFiles(
        files,
        (p) => {
          this.where.textContent = `· Đang nhập ${p.fileName} (${p.index + 1}/${p.total})`;
        },
        stackId,
      );
      const added = results.filter((r) => r.status === "added").length;
      for (const r of results) if (r.status === "error") toast(`${r.fileName}: ${r.message}`, "error", 6000);
      const dup = results.filter((r) => r.status === "duplicate").length;
      if (added) toast(`Đã thêm ${added} tài liệu${stackId ? " vào tủ này" : " vào tủ Chưa xếp kệ"}.`);
      if (dup) toast(`${dup} tài liệu đã có trên kệ.`);
      if (!had && added) this.deps.onFirstImport();
    } finally {
      this.busy = false;
      await this.refresh();
      const cur = this.world?.currentView;
      if (cur) this.onView(cur);
    }
  }

  private toggleSpine(): void {
    localStorage.setItem(SPINE_KEY, this.spineStyle === "up" ? "down" : "up");
    void this.refresh();
  }
}

function fallbackColor(id: string, notebook: boolean): string {
  const nb = ["#3d5a6b", "#5a4a3a", "#4a5a3a", "#5a3d4a"];
  const leather = ["#6e2a22", "#2f4a3c", "#3b2f5a", "#7a5a22", "#23465e", "#5a2a3a", "#4a3a2a", "#2e5a55", "#6a3d1e", "#36402a"];
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return notebook ? nb[s % nb.length] : leather[s % leather.length];
}

/** Average cover colour → a dark leather tone (keeps the hue, varies a little per book). */
export function leatherFrom(px: Uint8ClampedArray, id: string): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [R, G, B] = [px[i], px[i + 1], px[i + 2]];
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    // weight saturated pixels more: white/grey backgrounds don't make a colour
    const w = 0.15 + (mx - mn) / 255;
    r += R * w;
    g += G * w;
    b += B * w;
    n += w;
  }
  r /= n;
  g /= n;
  b /= n;
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  let hue = 0;
  const d = mx - mn;
  if (d > 1e-3) {
    if (mx === r / 255) hue = ((g - b) / 255 / d) % 6;
    else if (mx === g / 255) hue = (b - r) / 255 / d + 2;
    else hue = (r - g) / 255 / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const sat = d < 0.08 ? 0.28 : Math.min(0.55, Math.max(0.3, d * 1.1));
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  const light = 0.2 + (s % 10) / 100; // 20–29%
  const hh = d < 0.08 ? [8, 150, 25, 210, 340][s % 5] : hue; // grey covers: pick a classic leather hue
  return `hsl(${Math.round(hh)}, ${Math.round(sat * 100)}%, ${Math.round(light * 100)}%)`;
}
