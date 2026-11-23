import { h, icon } from "../dom";
import type { IndexStatus, TextIndexer } from "./TextIndexer";

/** "Tìm" tab: search box, indexing/OCR progress, results with snippets. */
export class SearchPanel {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private statusEl: HTMLElement;
  private results: HTMLElement;
  private lastQuery = "";
  private unsub: () => void;

  constructor(
    private readonly indexer: TextIndexer,
    private readonly onJump: (page: number, rects: number[]) => void,
  ) {
    this.input = h("input", {
      class: "search-input",
      type: "search",
      placeholder: "Tìm trong tài liệu (gõ không dấu được)…",
      "aria-label": "Tìm trong tài liệu",
      "data-testid": "doc-search",
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.run();
    });
    this.statusEl = h("div", { class: "index-status small muted", "data-testid": "index-status" });
    this.results = h("div", { class: "search-results", "data-testid": "search-results" });
    this.el = h(
      "div",
      { class: "search-panel" },
      h("div", { class: "search-box" }, h("span", { class: "search-ic", html: icon("search", 18) }), this.input),
      this.statusEl,
      this.results,
    );
    let lastScanned = -1;
    this.unsub = indexer.onStatus((s) => {
      this.renderStatus(s);
      // Refresh results as more pages get indexed (throttled to page batches).
      if (this.lastQuery && s.scanned + s.ocrDone !== lastScanned) {
        lastScanned = s.scanned + s.ocrDone;
        this.render(this.lastQuery, false);
      }
    });
  }

  focus(): void {
    setTimeout(() => this.input.focus(), 0);
  }

  private renderStatus(s: IndexStatus): void {
    const parts: string[] = [];
    if (s.scanned < s.total) parts.push(`Đang đọc chữ: ${s.scanned}/${s.total} trang`);
    if (s.ocrTotal > 0) {
      parts.push(
        s.ocrDone < s.ocrTotal
          ? `OCR (trang ảnh/lỗi mã): ${s.ocrDone}/${s.ocrTotal}${s.running ? " · đang chạy" : " · tiếp tục khi mở lại sách"}`
          : `Đã OCR ${s.ocrDone} trang`,
      );
    }
    this.statusEl.textContent = parts.join(" · ") || `Đã sẵn sàng tìm trong ${s.total} trang`;
  }

  private run(): void {
    this.lastQuery = this.input.value.trim();
    this.render(this.lastQuery, true);
  }

  private render(q: string, jumpFirst: boolean): void {
    if (!q) {
      this.results.replaceChildren();
      return;
    }
    const pages = this.indexer.search(q);
    const total = pages.reduce((s, p) => s + p.hits.length, 0);
    if (!total) {
      this.results.replaceChildren(h("p", { class: "muted pad" }, `Không thấy “${q}”.`));
      return;
    }
    const rows: HTMLElement[] = [h("div", { class: "result-count small muted" }, `${total} kết quả trong ${pages.length} trang`)];
    for (const p of pages) {
      for (const hit of p.hits) {
        const snip = h("span", { class: "snippet" });
        snip.append(hit.snippet.slice(0, hit.at), h("mark", {}, hit.snippet.slice(hit.at, hit.at + hit.len)), hit.snippet.slice(hit.at + hit.len));
        const row = h(
          "button",
          { class: "result", type: "button", "data-testid": "search-result", "data-page": p.page + 1 },
          h("span", { class: "result-page" }, `Tr. ${p.page + 1}`),
          snip,
        );
        row.addEventListener("click", () => this.onJump(p.page, this.indexer.hitRects(p.page, hit)));
        rows.push(row);
      }
    }
    this.results.replaceChildren(...rows);
    if (jumpFirst) (rows[1] as HTMLButtonElement | undefined)?.click();
  }

  destroy(): void {
    this.unsub();
  }
}
