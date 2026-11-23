import type { BookMeta } from "../../core/types";
import type { LibraryService, ImportResult } from "../../core/storage/LibraryService";
import { formatBytes, h, icon } from "../dom";
import { confirmDialog, popupMenu, promptDialog, toast } from "../feedback";

export interface LibraryViewDeps {
  library: LibraryService;
  onOpen: (book: BookMeta) => void;
  onFirstImport: () => void;
}

/** Bookshelf screen: import, list, rename, delete. */
export class LibraryView {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private empty: HTMLElement;
  private filterInput: HTMLInputElement;
  private storageInfo: HTMLElement;
  private progress: HTMLElement;
  private fileInput: HTMLInputElement;
  private books: BookMeta[] = [];
  private coverUrls = new Map<string, string>();

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
      placeholder: "Tìm theo tên tài liệu…",
      "aria-label": "Tìm tài liệu",
    });
    this.filterInput.addEventListener("input", () => this.renderGrid());

    const importBtn = h("button", {
      class: "btn btn-primary btn-import",
      type: "button",
      "data-testid": "import-btn",
      html: `${icon("upload", 20)}<span>Nhập tài liệu</span>`,
      onclick: () => this.fileInput.click(),
    });

    this.progress = h("div", { class: "import-progress", hidden: true });
    this.grid = h("div", { class: "shelf-grid", "data-testid": "shelf" });
    this.empty = h(
      "div",
      { class: "shelf-empty" },
      h("div", { class: "shelf-empty-icon", html: icon("book", 56) }),
      h("h2", {}, "Kệ sách đang trống"),
      h("p", {}, "Bấm “Nhập tài liệu” để thêm file PDF từ máy. File gốc được giữ nguyên, app lưu một bản riêng để đọc offline."),
    );
    this.storageInfo = h("span", { class: "storage-info" });

    this.el = h(
      "div",
      { class: "library" },
      h(
        "header",
        { class: "lib-header" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark", html: icon("book", 26) }), h("h1", {}, "Visual Library")),
        h("div", { class: "lib-search" }, h("span", { class: "search-ic", html: icon("search", 18) }), this.filterInput),
        importBtn,
        this.fileInput,
      ),
      this.progress,
      h("main", { class: "shelf" }, this.grid, this.empty),
      h("footer", { class: "lib-footer" }, this.storageInfo, h("span", { class: "version" }, `v${__APP_VERSION__}`)),
    );

    // Drag and drop is handy when testing on a laptop.
    this.el.addEventListener("dragover", (e) => e.preventDefault());
    this.el.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.importFiles(files);
    });
  }

  async refresh(): Promise<void> {
    this.books = await this.deps.library.list();
    this.renderGrid();
    void this.updateStorageInfo();
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

  private renderGrid(): void {
    const q = this.filterInput.value.trim().toLowerCase();
    const shown = q ? this.books.filter((b) => b.title.toLowerCase().includes(q)) : this.books;
    this.grid.replaceChildren(...shown.map((b) => this.card(b)));
    this.empty.hidden = this.books.length > 0;
  }

  private card(b: BookMeta): HTMLElement {
    const cover = h("div", { class: "card-cover" });
    void this.loadCover(b.id, cover);
    const progress = b.pageCount > 1 ? Math.round(((b.lastPage - 1) / (b.pageCount - 1)) * 100) : 0;
    const more = h("button", {
      class: "icon-btn card-more",
      type: "button",
      "aria-label": "Tùy chọn",
      html: icon("more", 20),
    });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      popupMenu(more, [
        { label: "Đổi tên", run: () => void this.rename(b) },
        { label: "Xóa khỏi kệ", danger: true, run: () => void this.remove(b) },
      ]);
    });
    const card = h(
      "article",
      { class: "card", tabindex: 0, "data-testid": "book-card", "data-id": b.id },
      cover,
      h(
        "div",
        { class: "card-body" },
        h("h3", { class: "card-title", title: b.title }, b.title),
        h(
          "div",
          { class: "card-meta" },
          `${b.pageCount} trang · ${formatBytes(b.size)}`,
        ),
        h(
          "div",
          { class: "card-progress", title: `Đang ở trang ${b.lastPage}` },
          h("div", { class: "bar" }, h("span", { style: `width:${progress}%` })),
          h("span", { class: "pct" }, b.lastOpenedAt ? `Trang ${b.lastPage}` : "Chưa đọc"),
        ),
      ),
      more,
    );
    card.addEventListener("click", () => this.deps.onOpen(b));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.deps.onOpen(b);
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

  async importFiles(files: File[]): Promise<ImportResult[]> {
    const hadNone = this.books.length === 0;
    this.progress.hidden = false;
    const label = h("span");
    const bar = h("span", { class: "fill" });
    this.progress.replaceChildren(label, h("div", { class: "bar" }, bar));
    const results = await this.deps.library.importFiles(files, (p) => {
      const phase = p.phase === "copy" ? "Đang sao chép" : "Đang đọc";
      label.textContent = `${phase} ${p.fileName} (${p.index + 1}/${p.total})`;
      const overall = (p.index + (p.phase === "copy" ? p.fraction * 0.8 : 0.8 + p.fraction * 0.2)) / p.total;
      bar.style.width = `${Math.round(overall * 100)}%`;
    });
    this.progress.hidden = true;
    const added = results.filter((r) => r.status === "added").length;
    for (const r of results) {
      if (r.status === "error") toast(`${r.fileName}: ${r.message}`, "error", 6000);
      if (r.status === "duplicate") toast(`“${r.book.title}” đã có trên kệ.`);
    }
    if (added) toast(added === 1 ? "Đã thêm 1 tài liệu." : `Đã thêm ${added} tài liệu.`);
    if (added && hadNone) this.deps.onFirstImport();
    await this.refresh();
    return results;
  }

  private async rename(b: BookMeta): Promise<void> {
    const t = await promptDialog("Đổi tên tài liệu", b.title);
    if (t === null) return;
    await this.deps.library.rename(b.id, t);
    await this.refresh();
  }

  private async remove(b: BookMeta): Promise<void> {
    const ok = await confirmDialog(
      "Xóa khỏi kệ?",
      `“${b.title}” sẽ bị xóa khỏi app (bản lưu trong app). File gốc ở nơi khác trên máy không bị ảnh hưởng.`,
      "Xóa",
      true,
    );
    if (!ok) return;
    await this.deps.library.delete(b.id);
    const url = this.coverUrls.get(b.id);
    if (url) URL.revokeObjectURL(url);
    this.coverUrls.delete(b.id);
    toast("Đã xóa.");
    await this.refresh();
  }
}
