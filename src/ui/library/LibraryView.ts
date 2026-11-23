import { buildTree, matchesQuery, pathOf, sameTag, subtreeIds } from "../../core/library/shelves";
import type { ImportResult, LibraryService } from "../../core/storage/LibraryService";
import type { BookMeta, Category } from "../../core/types";
import { UserFacingError } from "../../core/types";
import { formatBytes, h, icon } from "../dom";
import { confirmDialog, popupMenu, promptDialog, toast } from "../feedback";
import { editTags, pickShelf } from "./dialogs";
import { ShelfPanel, type ShelfView } from "./ShelfPanel";

export interface LibraryViewDeps {
  library: LibraryService;
  onOpen: (book: BookMeta) => void;
  onFirstImport: () => void;
  loadView: () => Promise<ShelfView>;
  saveView: (v: ShelfView) => void;
}

/** Bookshelf screen: shelves, tags, import, list, bulk actions. */
export class LibraryView {
  readonly el: HTMLElement;
  private panel: ShelfPanel;
  private grid: HTMLElement;
  private shelfTiles: HTMLElement;
  private crumbs: HTMLElement;
  private empty: HTMLElement;
  private filterInput: HTMLInputElement;
  private storageInfo: HTMLElement;
  private progress: HTMLElement;
  private fileInput: HTMLInputElement;
  private selectBar: HTMLElement;
  private books: BookMeta[] = [];
  private categories: Category[] = [];
  private coverUrls = new Map<string, string>();
  private view: ShelfView = { kind: "all" };
  private tag: string | null = null;
  private selecting = false;
  private selected = new Set<string>();
  private viewLoaded = false;

  constructor(private readonly deps: LibraryViewDeps) {
    this.fileInput = h("input", {
      type: "file",
      accept: "application/pdf,.pdf",
      multiple: true,
      class: "hidden-input",
      "data-testid": "file-input",
    });
    this.fileInput.addEventListener("change", () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = "";
      if (files.length) void this.importFiles(files);
    });

    this.filterInput = h("input", {
      class: "search-input",
      type: "search",
      placeholder: "Tìm tên hoặc #thẻ (gõ không dấu cũng được)…",
      "aria-label": "Tìm tài liệu",
      "data-testid": "search",
    });
    this.filterInput.addEventListener("input", () => this.renderMain());

    const importBtn = h("button", {
      class: "btn btn-primary btn-import",
      type: "button",
      "data-testid": "import-btn",
      html: `${icon("upload", 20)}<span>Nhập tài liệu</span>`,
      onclick: () => this.fileInput.click(),
    });
    const notebookBtn = h("button", {
      class: "btn btn-notebook",
      type: "button",
      "data-testid": "new-notebook",
      html: `${icon("notebook", 19)}<span>Tạo vở</span>`,
      onclick: () => void this.newNotebook(),
    });
    const selectBtn = h("button", {
      class: "btn btn-select",
      type: "button",
      "data-testid": "select-btn",
      html: `${icon("select", 19)}<span>Chọn</span>`,
      onclick: () => this.setSelecting(!this.selecting),
    });
    const menuBtn = h("button", {
      class: "icon-btn panel-toggle",
      type: "button",
      "aria-label": "Danh mục",
      html: icon("menu"),
      onclick: () => this.el.classList.toggle("panel-open"),
    });

    this.panel = new ShelfPanel({
      onSelect: (v) => this.setView(v),
      onTag: (t) => {
        this.tag = t;
        this.el.classList.remove("panel-open");
        this.renderAll();
      },
      onNewShelf: () => void this.newShelf(this.view.kind === "shelf" ? this.view.id : null),
      onTagMenu: (t, anchor) => this.tagMenu(t, anchor),
    });

    this.progress = h("div", { class: "import-progress", hidden: true });
    this.crumbs = h("div", { class: "crumbs", "data-testid": "crumbs" });
    this.shelfTiles = h("div", { class: "shelf-tiles" });
    this.grid = h("div", { class: "shelf-grid", "data-testid": "shelf" });
    this.empty = h("div", { class: "shelf-empty" });
    this.storageInfo = h("span", { class: "storage-info" });
    this.selectBar = h("div", { class: "select-bar", hidden: true, "data-testid": "select-bar" });

    this.el = h(
      "div",
      { class: "library" },
      h(
        "header",
        { class: "lib-header" },
        menuBtn,
        h("div", { class: "brand" }, h("span", { class: "brand-mark", html: icon("book", 26) }), h("h1", {}, "Visual Library")),
        h("div", { class: "lib-search" }, h("span", { class: "search-ic", html: icon("search", 18) }), this.filterInput),
        selectBtn,
        notebookBtn,
        importBtn,
        this.fileInput,
      ),
      this.progress,
      h(
        "div",
        { class: "lib-body" },
        this.panel.el,
        h("div", { class: "panel-scrim", onclick: () => this.el.classList.remove("panel-open") }),
        h("main", { class: "shelf" }, this.crumbs, this.shelfTiles, this.grid, this.empty),
      ),
      this.selectBar,
      h("footer", { class: "lib-footer" }, this.storageInfo, h("span", { class: "version" }, `v${__APP_VERSION__}`)),
    );

    this.el.addEventListener("dragover", (e) => e.preventDefault());
    this.el.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.importFiles(files);
    });
  }

  async refresh(): Promise<void> {
    if (!this.viewLoaded) {
      this.viewLoaded = true;
      this.view = await this.deps.loadView();
    }
    [this.books, this.categories] = await Promise.all([
      this.deps.library.list(),
      this.deps.library.listCategories(),
    ]);
    // The shelf we were on may have been deleted.
    if (this.view.kind === "shelf" && !this.categories.some((c) => this.view.kind === "shelf" && c.id === this.view.id)) {
      this.view = { kind: "all" };
    }
    const present = new Set(this.books.map((b) => b.id));
    for (const id of [...this.selected]) if (!present.has(id)) this.selected.delete(id);
    this.renderAll();
    void this.updateStorageInfo();
  }

  private setView(v: ShelfView): void {
    this.view = v;
    this.el.classList.remove("panel-open");
    this.deps.saveView(v);
    this.renderAll();
  }

  private currentShelfId(): string | null {
    return this.view.kind === "shelf" ? this.view.id : null;
  }

  private renderAll(): void {
    this.panel.render(this.categories, this.books, this.view, this.tag);
    this.renderMain();
  }

  /** Books visible in the current view, filter and tag. */
  private visibleBooks(): BookMeta[] {
    let list = this.books;
    const known = new Set(this.categories.map((c) => c.id));
    if (this.view.kind === "unsorted") list = list.filter((b) => !b.categoryId || !known.has(b.categoryId));
    if (this.view.kind === "shelf") {
      const ids = subtreeIds(this.categories, this.view.id);
      list = list.filter((b) => b.categoryId && ids.has(b.categoryId));
    }
    if (this.tag) list = list.filter((b) => b.tags.some((t) => sameTag(t, this.tag!)));
    const q = this.filterInput.value.trim();
    if (q) list = list.filter((b) => matchesQuery(b, q));
    return list;
  }

  private renderMain(): void {
    this.renderCrumbs();
    this.renderTiles();
    const shown = this.visibleBooks();
    this.grid.replaceChildren(...shown.map((b) => this.card(b)));
    this.renderEmpty(shown.length);
    this.renderSelectBar();
  }

  private renderCrumbs(): void {
    const parts: HTMLElement[] = [];
    const link = (label: string, v: ShelfView) =>
      h("button", { class: "crumb", type: "button", onclick: () => this.setView(v) }, label);
    if (this.view.kind === "shelf") {
      parts.push(link("Tất cả", { kind: "all" }));
      for (const c of pathOf(this.categories, this.view.id)) {
        parts.push(h("span", { class: "crumb-sep", html: icon("chevron", 14) }));
        parts.push(link(c.name, { kind: "shelf", id: c.id }));
      }
    } else {
      parts.push(h("span", { class: "crumb current" }, this.view.kind === "all" ? "Tất cả tài liệu" : "Chưa phân loại"));
    }
    const actions = h("div", { class: "crumb-actions" });
    if (this.tag) {
      actions.append(
        h(
          "button",
          { class: "tag-chip active", type: "button", title: "Bỏ lọc thẻ", onclick: () => ((this.tag = null), this.renderAll()) },
          `#${this.tag}`,
          h("span", { class: "tag-n", html: icon("close", 12) }),
        ),
      );
    }
    actions.append(
      h("button", {
        class: "btn btn-ghost",
        type: "button",
        "data-testid": "new-subshelf",
        html: `${icon("folderPlus", 18)}<span>${this.view.kind === "shelf" ? "Danh mục con" : "Danh mục mới"}</span>`,
        onclick: () => void this.newShelf(this.currentShelfId()),
      }),
    );
    if (this.view.kind === "shelf") {
      const id = this.view.id;
      const more = h("button", { class: "icon-btn", type: "button", "aria-label": "Tùy chọn danh mục", "data-testid": "shelf-menu", html: icon("more", 20) });
      more.addEventListener("click", () =>
        popupMenu(more, [
          { label: "Đổi tên danh mục", run: () => void this.renameShelf(id) },
          { label: "Chuyển danh mục đến…", run: () => void this.moveShelf(id) },
          { label: "Xóa danh mục", danger: true, run: () => void this.deleteShelf(id) },
        ]),
      );
      actions.append(more);
    }
    this.crumbs.replaceChildren(h("div", { class: "crumb-path" }, ...parts), actions);
  }

  /** Sub-shelves of the current shelf as tiles, like walking to a shelf. */
  private renderTiles(): void {
    const parent = this.currentShelfId();
    if (this.view.kind === "unsorted" || this.filterInput.value.trim()) {
      this.shelfTiles.replaceChildren();
      return;
    }
    const tree = buildTree(this.categories);
    const findChildren = (nodes: ReturnType<typeof buildTree>): ReturnType<typeof buildTree> => {
      if (parent === null) return nodes;
      for (const n of nodes) {
        if (n.category.id === parent) return n.children;
        const r = findChildren(n.children);
        if (r.length || r === n.children) return r;
      }
      return [];
    };
    const kids = findChildren(tree);
    const known = new Set(this.categories.map((c) => c.id));
    this.shelfTiles.replaceChildren(
      ...kids.map((n) => {
        const ids = subtreeIds(this.categories, n.category.id);
        const count = this.books.filter((b) => b.categoryId && known.has(b.categoryId) && ids.has(b.categoryId)).length;
        return h(
          "button",
          {
            class: "shelf-tile",
            type: "button",
            "data-testid": "shelf-tile",
            onclick: () => this.setView({ kind: "shelf", id: n.category.id }),
          },
          h("span", { class: "tile-ic", html: icon("folder", 26) }),
          h("span", { class: "tile-name" }, n.category.name),
          h("span", { class: "tile-count" }, `${count} tài liệu${n.children.length ? ` · ${n.children.length} mục con` : ""}`),
        );
      }),
    );
  }

  private renderEmpty(shown: number): void {
    if (shown > 0) {
      this.empty.hidden = true;
      return;
    }
    this.empty.hidden = false;
    let title = "Không có tài liệu nào khớp";
    let text = "Thử bỏ bớt bộ lọc hoặc từ khóa tìm kiếm.";
    if (this.books.length === 0) {
      title = "Kệ sách đang trống";
      text = "Bấm “Nhập tài liệu” để thêm file PDF từ máy. File gốc được giữ nguyên, app lưu một bản riêng để đọc offline.";
    } else if (!this.filterInput.value.trim() && !this.tag && this.view.kind === "shelf") {
      title = "Danh mục này chưa có tài liệu";
      text = "Bấm “Nhập tài liệu” khi đang ở đây để thêm thẳng vào danh mục, hoặc dùng “Chọn” để chuyển tài liệu có sẵn vào.";
    }
    this.empty.replaceChildren(
      h("div", { class: "shelf-empty-icon", html: icon("book", 56) }),
      h("h2", {}, title),
      h("p", {}, text),
    );
  }

  private async updateStorageInfo(): Promise<void> {
    const used = this.books.reduce((s, b) => s + b.size, 0);
    let text = `${this.books.length} tài liệu · ${formatBytes(used)}`;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) text += ` · còn trống khoảng ${formatBytes(Math.max(0, est.quota - (est.usage ?? 0)))}`;
    } catch {
      /* ignore */
    }
    this.storageInfo.textContent = text;
  }

  private card(b: BookMeta): HTMLElement {
    const isNb = b.kind === "notebook";
    const cover = h("div", { class: `card-cover ${isNb ? `nb-cover paper-${b.paper ?? "lines"}` : ""}` });
    if (isNb) cover.append(h("span", { class: "nb-cover-label" }, b.title), h("span", { class: "nb-cover-tag", html: icon("notebook", 16) }));
    else void this.loadCover(b.id, cover);
    const progress = b.pageCount > 1 ? Math.round(((b.lastPage - 1) / (b.pageCount - 1)) * 100) : 0;
    const more = h("button", { class: "icon-btn card-more", type: "button", "aria-label": "Tùy chọn", html: icon("more", 20) });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      popupMenu(more, [
        { label: "Chuyển đến danh mục…", run: () => void this.moveBooks([b.id]) },
        { label: "Gắn thẻ…", run: () => void this.tagBooks([b.id]) },
        { label: "Đổi tên", run: () => void this.rename(b) },
        { label: "Xóa khỏi kệ", danger: true, run: () => void this.remove([b.id]) },
      ]);
    });
    const path = b.categoryId ? pathOf(this.categories, b.categoryId) : [];
    const showPath = path.length > 0 && (this.view.kind !== "shelf" || this.view.id !== b.categoryId);
    const tags = b.tags.slice(0, 3).map((t) => h("span", { class: "card-tag" }, `#${t}`));
    if (b.tags.length > 3) tags.push(h("span", { class: "card-tag more" }, `+${b.tags.length - 3}`));
    const isSel = this.selected.has(b.id);
    const card = h(
      "article",
      { class: `card ${isSel ? "selected" : ""}`, tabindex: 0, "data-testid": "book-card", "data-id": b.id },
      cover,
      this.selecting ? h("span", { class: "card-check", html: isSel ? icon("check", 18) : "" }) : null,
      h(
        "div",
        { class: "card-body" },
        h("h3", { class: "card-title", title: b.title }, b.title),
        showPath ? h("div", { class: "card-path", title: path.map((c) => c.name).join(" › ") }, path.map((c) => c.name).join(" › ")) : null,
        h("div", { class: "card-meta" }, isNb ? `Vở · ${b.pageCount} trang` : `${b.pageCount} trang · ${formatBytes(b.size)}`),
        tags.length ? h("div", { class: "card-tags" }, ...tags) : null,
        h(
          "div",
          { class: "card-progress", title: `Đang ở trang ${b.lastPage}` },
          h("div", { class: "bar" }, h("span", { style: `width:${progress}%` })),
          h("span", { class: "pct" }, b.lastOpenedAt ? `Trang ${b.lastPage}` : "Chưa đọc"),
        ),
      ),
      this.selecting ? null : more,
    );
    const activate = () => {
      if (this.selecting) {
        if (this.selected.has(b.id)) this.selected.delete(b.id);
        else this.selected.add(b.id);
        this.renderMain();
      } else {
        this.deps.onOpen(b);
      }
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") activate();
    });
    return card;
  }

  private async loadCover(id: string, el: HTMLElement): Promise<void> {
    let url = this.coverUrls.get(id);
    if (!url) {
      const blob = await this.deps.library.getCover(id);
      if (!blob) return;
      url = URL.createObjectURL(blob);
      this.coverUrls.set(id, url);
    }
    el.append(h("img", { src: url, alt: "", loading: "lazy", draggable: "false" }));
  }

  // ---- selection -----------------------------------------------------

  private setSelecting(on: boolean): void {
    this.selecting = on;
    if (!on) this.selected.clear();
    this.el.classList.toggle("selecting", on);
    this.renderMain();
  }

  private renderSelectBar(): void {
    this.selectBar.hidden = !this.selecting;
    if (!this.selecting) return;
    const n = this.selected.size;
    const ids = [...this.selected];
    const visible = this.visibleBooks();
    const allOn = visible.length > 0 && visible.every((b) => this.selected.has(b.id));
    const btn = (label: string, run: () => void, cls = "", testid = "") =>
      h("button", { class: `btn ${cls}`, type: "button", disabled: n === 0 && !cls.includes("always"), onclick: run, "data-testid": testid || undefined }, label);
    this.selectBar.replaceChildren(
      h("span", { class: "sel-count" }, n ? `Đã chọn ${n}` : "Chạm vào tài liệu để chọn"),
      btn(
        allOn ? "Bỏ chọn hết" : "Chọn hết",
        () => {
          if (allOn) for (const b of visible) this.selected.delete(b.id);
          else for (const b of visible) this.selected.add(b.id);
          this.renderMain();
        },
        "always",
      ),
      btn("Chuyển đến…", () => void this.moveBooks(ids), "btn-primary", "bulk-move"),
      btn("Gắn thẻ…", () => void this.tagBooks(ids), "", "bulk-tag"),
      btn("Xóa", () => void this.remove(ids), "btn-danger-outline", "bulk-delete"),
      btn("Xong", () => this.setSelecting(false), "always"),
    );
  }

  // ---- actions -------------------------------------------------------

  async importFiles(files: File[]): Promise<ImportResult[]> {
    const hadNone = this.books.length === 0;
    const target = this.currentShelfId();
    this.progress.hidden = false;
    const label = h("span");
    const bar = h("span", { class: "fill" });
    this.progress.replaceChildren(label, h("div", { class: "bar" }, bar));
    const results = await this.deps.library.importFiles(
      files,
      (p) => {
        const phase = p.phase === "copy" ? "Đang sao chép" : "Đang đọc";
        label.textContent = `${phase} ${p.fileName} (${p.index + 1}/${p.total})`;
        const overall = (p.index + (p.phase === "copy" ? p.fraction * 0.8 : 0.8 + p.fraction * 0.2)) / p.total;
        bar.style.width = `${Math.round(overall * 100)}%`;
      },
      target,
    );
    this.progress.hidden = true;
    const added = results.filter((r) => r.status === "added").length;
    for (const r of results) {
      if (r.status === "error") toast(`${r.fileName}: ${r.message}`, "error", 6000);
      if (r.status === "duplicate") toast(`“${r.book.title}” đã có trên kệ.`);
    }
    if (added) {
      const where = target ? ` vào “${pathOf(this.categories, target).map((c) => c.name).join(" › ")}”` : "";
      toast(`Đã thêm ${added} tài liệu${where}.`);
    }
    if (added && hadNone) this.deps.onFirstImport();
    await this.refresh();
    return results;
  }

  private async newNotebook(): Promise<void> {
    const name = await promptDialog("Tên vở mới", "", "Tạo vở");
    if (name === null) return;
    try {
      const nb = await this.deps.library.createNotebook(name, this.currentShelfId());
      await this.refresh();
      this.deps.onOpen(nb);
    } catch (e) {
      toast(e instanceof UserFacingError ? e.message : "Không tạo được vở.", "error");
    }
  }

  private async newShelf(parentId: string | null): Promise<void> {
    const parentName = parentId ? pathOf(this.categories, parentId).map((c) => c.name).join(" › ") : null;
    const name = await promptDialog(parentName ? `Danh mục con trong “${parentName}”` : "Danh mục mới", "", "Tạo");
    if (name === null) return;
    try {
      const c = await this.deps.library.createCategory(name, parentId);
      await this.refresh();
      this.setView({ kind: "shelf", id: c.id });
    } catch (e) {
      toast(e instanceof UserFacingError ? e.message : "Không tạo được danh mục.", "error");
    }
  }

  private async renameShelf(id: string): Promise<void> {
    const c = this.categories.find((x) => x.id === id);
    if (!c) return;
    const name = await promptDialog("Đổi tên danh mục", c.name);
    if (name === null) return;
    try {
      await this.deps.library.renameCategory(id, name);
    } catch (e) {
      toast(e instanceof UserFacingError ? e.message : "Không đổi tên được.", "error");
    }
    await this.refresh();
  }

  private async moveShelf(id: string): Promise<void> {
    const c = this.categories.find((x) => x.id === id);
    if (!c) return;
    const dest = await pickShelf({
      library: this.deps.library,
      title: `Chuyển “${c.name}” vào…`,
      okLabel: "Chuyển",
      rootLabel: "Cấp ngoài cùng",
      current: c.parentId,
      exclude: subtreeIds(this.categories, id),
    });
    if (dest === undefined) return;
    try {
      await this.deps.library.moveCategory(id, dest);
    } catch (e) {
      toast(e instanceof UserFacingError ? e.message : "Không chuyển được.", "error");
    }
    await this.refresh();
  }

  private async deleteShelf(id: string): Promise<void> {
    const c = this.categories.find((x) => x.id === id);
    if (!c) return;
    const parent = c.parentId ? this.categories.find((x) => x.id === c.parentId)?.name : null;
    const ok = await confirmDialog(
      `Xóa danh mục “${c.name}”?`,
      `Chỉ xóa danh mục, không xóa tài liệu. Tài liệu và danh mục con bên trong sẽ được chuyển lên ${parent ? `“${parent}”` : "cấp ngoài (Chưa phân loại)"}.`,
      "Xóa danh mục",
      true,
    );
    if (!ok) return;
    await this.deps.library.deleteCategory(id);
    this.setView(c.parentId ? { kind: "shelf", id: c.parentId } : { kind: "all" });
    await this.refresh();
    toast("Đã xóa danh mục.");
  }

  private async moveBooks(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const first = this.books.find((b) => b.id === ids[0]);
    const dest = await pickShelf({
      library: this.deps.library,
      title: ids.length === 1 ? `Chuyển “${first?.title}” đến…` : `Chuyển ${ids.length} tài liệu đến…`,
      okLabel: "Chuyển",
      rootLabel: "Chưa phân loại",
      current: ids.length === 1 ? (first?.categoryId ?? null) : this.currentShelfId(),
    });
    if (dest === undefined) return;
    await this.deps.library.moveBooks(ids, dest);
    const name = dest ? pathOf(await this.deps.library.listCategories(), dest).map((c) => c.name).join(" › ") : "Chưa phân loại";
    toast(`Đã chuyển ${ids.length} tài liệu đến “${name}”.`);
    if (this.selecting) this.setSelecting(false);
    await this.refresh();
  }

  private async tagBooks(ids: string[]): Promise<void> {
    const books = this.books.filter((b) => ids.includes(b.id));
    if (!books.length) return;
    await editTags(this.deps.library, books, this.books);
    await this.refresh();
  }

  private tagMenu(tag: string, anchor: HTMLElement): void {
    popupMenu(anchor, [
      {
        label: `Đổi tên thẻ #${tag}`,
        run: async () => {
          const t = await promptDialog("Đổi tên thẻ", tag);
          if (t === null || !t.trim()) return;
          await this.deps.library.renameTag(tag, t);
          if (this.tag && sameTag(this.tag, tag)) this.tag = t.trim();
          await this.refresh();
        },
      },
      {
        label: `Xóa thẻ #${tag} khỏi mọi tài liệu`,
        danger: true,
        run: async () => {
          const ok = await confirmDialog("Xóa thẻ?", `Thẻ #${tag} sẽ được gỡ khỏi mọi tài liệu. Tài liệu không bị xóa.`, "Xóa thẻ", true);
          if (!ok) return;
          await this.deps.library.removeTag(this.books.map((b) => b.id), tag);
          if (this.tag && sameTag(this.tag, tag)) this.tag = null;
          await this.refresh();
        },
      },
    ]);
  }

  private async rename(b: BookMeta): Promise<void> {
    const t = await promptDialog("Đổi tên tài liệu", b.title);
    if (t === null) return;
    await this.deps.library.rename(b.id, t);
    await this.refresh();
  }

  private async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const first = this.books.find((b) => b.id === ids[0]);
    const ok = await confirmDialog(
      ids.length === 1 ? "Xóa khỏi kệ?" : `Xóa ${ids.length} tài liệu khỏi kệ?`,
      `${ids.length === 1 ? `“${first?.title}”` : `${ids.length} tài liệu`} sẽ bị xóa khỏi app (bản lưu trong app). File gốc ở nơi khác trên máy không bị ảnh hưởng.`,
      "Xóa",
      true,
    );
    if (!ok) return;
    for (const id of ids) {
      await this.deps.library.delete(id);
      const url = this.coverUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      this.coverUrls.delete(id);
    }
    toast(ids.length === 1 ? "Đã xóa." : `Đã xóa ${ids.length} tài liệu.`);
    if (this.selecting) this.setSelecting(false);
    await this.refresh();
  }
}

export type { ShelfView };
