import { buildTree, countBooks, sameTag, tagCounts, type ShelfNode } from "../../core/library/shelves";
import type { BookMeta, Category } from "../../core/types";
import { h, icon } from "../dom";

export type ShelfView = { kind: "all" } | { kind: "unsorted" } | { kind: "shelf"; id: string };

export interface ShelfPanelCallbacks {
  onSelect: (v: ShelfView) => void;
  onTag: (tag: string | null) => void;
  onNewShelf: () => void;
  onTagMenu: (tag: string, anchor: HTMLElement) => void;
}

/** Left column of the shelf screen: all / unsorted / shelf tree / tags. */
export class ShelfPanel {
  readonly el: HTMLElement;
  private collapsed = new Set<string>();

  constructor(private readonly cb: ShelfPanelCallbacks) {
    this.el = h("nav", { class: "shelf-panel", "aria-label": "Danh mục", "data-testid": "shelf-panel" });
  }

  render(categories: Category[], books: BookMeta[], view: ShelfView, tag: string | null): void {
    const counts = countBooks(categories, books);
    const unsorted = books.filter((b) => !b.categoryId || !categories.some((c) => c.id === b.categoryId)).length;
    const item = (
      label: string,
      iconName: string,
      count: number,
      active: boolean,
      onClick: () => void,
      testid: string,
    ) => {
      const b = h(
        "button",
        { class: `sp-item ${active ? "active" : ""}`, type: "button", "data-testid": testid },
        h("span", { class: "sp-ic", html: icon(iconName, 19) }),
        h("span", { class: "sp-label" }, label),
        h("span", { class: "sp-count" }, String(count)),
      );
      b.addEventListener("click", onClick);
      return b;
    };

    const tree = h("div", { class: "sp-tree" });
    const addNodes = (nodes: ShelfNode[]) => {
      for (const n of nodes) {
        const c = n.category;
        const hasKids = n.children.length > 0;
        const isCollapsed = this.collapsed.has(c.id);
        const active = view.kind === "shelf" && view.id === c.id;
        const toggle = h("button", {
          class: `sp-toggle ${hasKids ? "" : "empty"} ${isCollapsed ? "collapsed" : ""}`,
          type: "button",
          "aria-label": isCollapsed ? "Mở" : "Thu gọn",
          tabindex: hasKids ? 0 : -1,
          html: hasKids ? icon("chevron", 16) : "",
        });
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!hasKids) return;
          if (isCollapsed) this.collapsed.delete(c.id);
          else this.collapsed.add(c.id);
          this.render(categories, books, view, tag);
        });
        const row = h(
          "div",
          { class: `sp-row ${active ? "active" : ""}`, style: `padding-left:${4 + n.depth * 16}px`, "data-shelf": c.id },
          toggle,
          item(c.name, "folder", counts.get(c.id) ?? 0, false, () => this.cb.onSelect({ kind: "shelf", id: c.id }), "shelf-item"),
        );
        tree.append(row);
        if (hasKids && !isCollapsed) addNodes(n.children);
      }
    };
    addNodes(buildTree(categories));
    if (!categories.length) tree.append(h("p", { class: "sp-hint" }, "Chưa có danh mục. Bấm + để tạo, ví dụ “Hàng không”."));

    const tags = tagCounts(books);
    const tagBox = h("div", { class: "sp-tags" });
    for (const t of tags) {
      const active = tag !== null && sameTag(tag, t.tag);
      const chip = h(
        "button",
        { class: `tag-chip ${active ? "active" : ""}`, type: "button", "data-tag": t.tag },
        `#${t.tag}`,
        h("span", { class: "tag-n" }, String(t.count)),
      );
      chip.addEventListener("click", () => this.cb.onTag(active ? null : t.tag));
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.cb.onTagMenu(t.tag, chip);
      });
      tagBox.append(chip);
    }
    if (!tags.length) tagBox.append(h("p", { class: "sp-hint" }, "Gắn thẻ từ menu ⋮ của từng tài liệu."));

    const addBtn = h("button", { class: "icon-btn sp-add", type: "button", "aria-label": "Tạo danh mục", "data-testid": "new-shelf", html: icon("plus", 18) });
    addBtn.addEventListener("click", () => this.cb.onNewShelf());

    this.el.replaceChildren(
      item("Tất cả tài liệu", "library", books.length, view.kind === "all", () => this.cb.onSelect({ kind: "all" }), "view-all"),
      item("Chưa phân loại", "inbox", unsorted, view.kind === "unsorted", () => this.cb.onSelect({ kind: "unsorted" }), "view-unsorted"),
      h("div", { class: "sp-head" }, h("span", {}, "Danh mục"), addBtn),
      tree,
      h("div", { class: "sp-head" }, h("span", {}, "Thẻ"), tags.length ? h("span", { class: "sp-hint-inline" }, "giữ lâu để sửa") : null),
      tagBox,
    );
  }
}
