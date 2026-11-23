import type { OutlineNode } from "../../core/types";
import { h } from "../dom";

/** Collapsible table of contents built from the PDF bookmarks. */
export class OutlinePanel {
  readonly el: HTMLElement;
  private loaded = false;

  constructor(
    private readonly load: () => Promise<OutlineNode[]>,
    private readonly onNavigate: (page: number) => void,
  ) {
    this.el = h("div", { class: "outline", "data-testid": "outline" }, h("p", { class: "muted pad" }, "Đang đọc mục lục…"));
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const nodes = await this.load();
    if (nodes.length === 0) {
      this.el.replaceChildren(
        h(
          "p",
          { class: "muted pad" },
          "Tài liệu này không có mục lục (bookmark). Bạn vẫn có thể dùng ảnh thu nhỏ hoặc gõ số trang để nhảy.",
        ),
      );
      return;
    }
    this.el.replaceChildren(this.list(nodes, 0));
  }

  private list(nodes: OutlineNode[], depth: number): HTMLElement {
    const ul = h("ul", { class: `outline-list depth-${Math.min(depth, 4)}` });
    for (const n of nodes) {
      const hasKids = n.children.length > 0;
      const li = h("li", { class: hasKids && depth > 0 ? "collapsed" : "" });
      const toggle = hasKids
        ? h("button", {
            class: "outline-toggle",
            type: "button",
            "aria-label": "Mở/đóng",
            onclick: (e: Event) => {
              e.stopPropagation();
              li.classList.toggle("collapsed");
            },
          })
        : h("span", { class: "outline-toggle-spacer" });
      const row = h(
        "button",
        {
          class: "outline-item",
          type: "button",
          disabled: n.page === null,
          onclick: () => n.page !== null && this.onNavigate(n.page),
        },
        h("span", { class: "outline-title" }, n.title),
        h("span", { class: "outline-page" }, n.page !== null ? String(n.page) : ""),
      );
      li.append(h("div", { class: "outline-row" }, toggle, row));
      if (hasKids) li.append(this.list(n.children, depth + 1));
      ul.append(li);
    }
    return ul;
  }
}
