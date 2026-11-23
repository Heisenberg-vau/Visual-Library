import { buildTree, flatten, sameTag, tagCounts } from "../../core/library/shelves";
import type { LibraryService } from "../../core/storage/LibraryService";
import type { BookMeta } from "../../core/types";
import { UserFacingError } from "../../core/types";
import { h, icon } from "../dom";
import { modal, promptDialog, toast } from "../feedback";

/**
 * Lets the user choose a shelf. Returns the shelf id, null for
 * "Chưa phân loại"/top level, or undefined if cancelled.
 */
export async function pickShelf(opts: {
  library: LibraryService;
  title: string;
  okLabel: string;
  /** Label for the null choice. */
  rootLabel: string;
  current: string | null;
  /** Shelves that cannot be chosen (e.g. a shelf's own subtree). */
  exclude?: Set<string>;
}): Promise<string | null | undefined> {
  let categories = await opts.library.listCategories();
  let selected: string | null = opts.current;
  const r = await modal((close) => {
    const list = h("div", { class: "picker-list", role: "listbox" });
    const render = () => {
      const rows: HTMLElement[] = [];
      const row = (id: string | null, label: string, depth: number, iconName: string, disabled = false) => {
        const b = h(
          "button",
          {
            class: `picker-row ${selected === id ? "selected" : ""}`,
            type: "button",
            role: "option",
            "aria-selected": selected === id ? "true" : "false",
            disabled,
            style: `padding-left:${14 + depth * 22}px`,
            "data-shelf": id ?? "",
          },
          h("span", { class: "picker-ic", html: icon(iconName, 18) }),
          h("span", { class: "picker-label" }, label),
          h("span", { class: "picker-check", html: selected === id ? icon("check", 18) : "" }),
        );
        b.addEventListener("click", () => {
          selected = id;
          render();
        });
        b.addEventListener("dblclick", () => close({ value: id }));
        rows.push(b);
      };
      row(null, opts.rootLabel, 0, "inbox");
      for (const n of flatten(buildTree(categories))) {
        row(n.category.id, n.category.name, n.depth, "folder", opts.exclude?.has(n.category.id));
      }
      list.replaceChildren(...rows);
    };
    render();
    const newBtn = h("button", {
      class: "btn btn-ghost",
      type: "button",
      html: `${icon("folderPlus", 18)}<span>Danh mục mới ở đây</span>`,
    });
    newBtn.addEventListener("click", async () => {
      const name = await promptDialog("Tên danh mục mới", "", "Tạo");
      if (name === null) return;
      try {
        const c = await opts.library.createCategory(name, selected);
        categories = await opts.library.listCategories();
        selected = c.id;
        render();
      } catch (e) {
        toast(e instanceof UserFacingError ? e.message : "Không tạo được danh mục.", "error");
      }
    });
    return h(
      "div",
      { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "data-testid": "shelf-picker" },
      h("h2", {}, opts.title),
      list,
      h(
        "div",
        { class: "modal-actions spread" },
        newBtn,
        h(
          "div",
          { class: "row-gap" },
          h("button", { class: "btn", type: "button", onclick: () => close(undefined) }, "Hủy"),
          h("button", { class: "btn btn-primary", type: "button", onclick: () => close({ value: selected }) }, opts.okLabel),
        ),
      ),
    );
  });
  // Cancel, backdrop tap -> undefined; a choice is wrapped so null ("root") is distinct.
  return r && typeof r === "object" ? (r as { value: string | null }).value : undefined;
}

/**
 * Edits tags of one or several books. Changes apply immediately; the
 * promise resolves when the dialog is closed.
 */
export async function editTags(library: LibraryService, books: BookMeta[], allBooks: BookMeta[]): Promise<void> {
  const ids = books.map((b) => b.id);
  let current = books.map((b) => ({ ...b, tags: [...b.tags] }));
  await modal((close) => {
    const chips = h("div", { class: "chips" });
    const input = h("input", {
      class: "text-input",
      type: "text",
      placeholder: "Nhập thẻ rồi bấm Enter, ví dụ: M15, ATA 72, HSK 3",
      "aria-label": "Thêm thẻ",
      "data-testid": "tag-input",
    });
    const suggestBox = h("div", { class: "chips suggest" });

    const renderChips = () => {
      const counts = tagCounts(current);
      chips.replaceChildren(
        ...(counts.length
          ? counts.map(({ tag, count }) => {
              const x = h("button", { class: "chip-x", type: "button", "aria-label": `Bỏ thẻ ${tag}`, html: icon("close", 14) });
              x.addEventListener("click", async () => {
                await library.removeTag(ids, tag);
                current = current.map((b) => ({ ...b, tags: b.tags.filter((t) => !sameTag(t, tag)) }));
                renderChips();
              });
              const label = books.length > 1 && count < books.length ? `${tag} (${count}/${books.length})` : tag;
              return h("span", { class: "chip", "data-tag": tag }, h("span", {}, `#${label}`), x);
            })
          : [h("span", { class: "muted" }, "Chưa có thẻ nào.")]),
      );
      renderSuggest();
    };

    const renderSuggest = () => {
      const q = input.value.trim().toLowerCase().replace(/^#/, "");
      const have = new Set(tagCounts(current).filter((t) => t.count === books.length).map((t) => t.tag.toLowerCase()));
      const opts = tagCounts(allBooks)
        .map((t) => t.tag)
        .filter((t) => !have.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q)))
        .slice(0, 12);
      suggestBox.replaceChildren(
        ...opts.map((t) =>
          h("button", { class: "chip chip-suggest", type: "button", onclick: () => void add(t) }, `+ #${t}`),
        ),
      );
    };

    // Adds are queued so fast typing (Enter, type, Enter) never loses a tag.
    let chain: Promise<void> = Promise.resolve();
    const add = (raw: string) => {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return chain;
      if (input.value === raw) input.value = "";
      chain = chain.then(async () => {
        await library.addTags(ids, parts);
        current = (await library.list()).filter((b) => ids.includes(b.id));
        renderChips();
      });
      input.focus();
      return chain;
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void add(input.value);
      }
    });
    input.addEventListener("input", renderSuggest);
    renderChips();

    return h(
      "div",
      { class: "modal modal-wide", role: "dialog", "aria-modal": "true", "data-testid": "tag-dialog" },
      h("h2", {}, books.length === 1 ? `Thẻ của “${books[0].title}”` : `Thẻ cho ${books.length} tài liệu`),
      chips,
      input,
      h("div", { class: "suggest-label muted" }, "Thẻ đã dùng:"),
      suggestBox,
      h(
        "div",
        { class: "modal-actions" },
        h("button", {
          class: "btn btn-primary",
          type: "button",
          onclick: async () => {
            if (input.value.trim()) add(input.value); // typed but not yet Enter-ed
            await chain;
            close(true);
          },
        }, "Xong"),
      ),
    );
  });
}

