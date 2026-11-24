import { buildTree, flatten } from "../../core/library/shelves";
import type { LibraryService } from "../../core/storage/LibraryService";
import { addDays, countdown, dayKey, friendlyDay, longDate, weekStart, weekdayName, type DayKey } from "../../core/study/dates";
import type { StudyStore } from "../../core/study/StudyStore";
import { REPEAT_LABEL, groupByDay, isOverdue, todayList, toggled, upcomingDeadlines, weekDays, type Repeat, type Task } from "../../core/study/tasks";
import type { BookMeta, Category } from "../../core/types";
import { h, icon, iconButton } from "../dom";
import { confirmDialog, modal, popupMenu, toast } from "../feedback";

type Tab = "today" | "week" | "all";

export interface PlannerDeps {
  store: StudyStore;
  library: LibraryService;
  onBack: () => void;
  onOpenBook: (bookId: string, page: number | null) => void;
  /** Test hook / date override. */
  today?: () => DayKey;
}

/** "Kế hoạch học": tasks for today and this week, deadlines with countdowns. */
export class PlannerView {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private deadlines: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  private tab: Tab = "today";
  private week: DayKey;
  private tasks: Task[] = [];
  private books: BookMeta[] = [];
  private cats: Category[] = [];
  private showDone = false;

  constructor(private readonly deps: PlannerDeps) {
    this.week = weekStart(this.today());
    const mkTab = (t: Tab, label: string) =>
      h("button", { class: "tab", type: "button", "data-tab": t, onclick: () => this.setTab(t) }, label);
    this.tabs = { today: mkTab("today", "Hôm nay"), week: mkTab("week", "Tuần này"), all: mkTab("all", "Tất cả") };
    this.deadlines = h("div", { class: "deadlines", "data-testid": "deadlines" });
    this.body = h("div", { class: "plan-body", "data-testid": "plan-body" });
    const addBtn = h("button", {
      class: "btn btn-primary",
      type: "button",
      "data-testid": "add-task",
      html: `${icon("plus", 19)}<span>Thêm việc</span>`,
      onclick: () => void this.edit(null),
    });
    this.el = h(
      "div",
      { class: "planner", "data-testid": "planner" },
      h(
        "header",
        { class: "lib-header" },
        iconButton("back", "Về kệ sách", () => deps.onBack()),
        h("div", { class: "brand" }, h("span", { class: "brand-mark", html: icon("calendar", 24) }), h("h1", {}, "Kế hoạch học")),
        h("div", { class: "tabs plan-tabs" }, this.tabs.today, this.tabs.week, this.tabs.all),
        addBtn,
      ),
      h("main", { class: "plan-main" }, this.deadlines, this.body),
    );
  }

  private today(): DayKey {
    return this.deps.today?.() ?? dayKey(new Date());
  }

  async refresh(): Promise<void> {
    [this.tasks, this.books, this.cats] = await Promise.all([
      this.deps.store.listTasks(),
      this.deps.library.list(),
      this.deps.library.listCategories(),
    ]);
    this.render();
  }

  private setTab(t: Tab): void {
    this.tab = t;
    this.render();
  }

  private render(): void {
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle("active", k === this.tab);
    const today = this.today();
    const dls = upcomingDeadlines(this.tasks, today);
    this.deadlines.replaceChildren(
      ...dls.map((t) => {
        const days = countdown(t.date!, today);
        const urgent = t.date === today || t.date === addDays(today, 1);
        return h(
          "button",
          { class: `deadline ${urgent ? "urgent" : ""}`, type: "button", "data-testid": "deadline", onclick: () => void this.edit(t) },
          h("span", { class: "dl-count" }, days),
          h("span", { class: "dl-title" }, t.title),
          h("span", { class: "dl-date" }, friendlyDay(t.date!, today)),
        );
      }),
    );
    this.deadlines.hidden = dls.length === 0;
    if (this.tab === "today") this.renderToday(today);
    else if (this.tab === "week") this.renderWeek(today);
    else this.renderAll(today);
  }

  private renderToday(today: DayKey): void {
    const list = todayList(this.tasks, today);
    this.body.replaceChildren(
      h("h2", { class: "plan-h" }, `Hôm nay · ${longDate(today)}`),
      list.length ? this.list(list, today) : this.empty("Hôm nay chưa có việc nào. Bấm “Thêm việc” để lên kế hoạch."),
    );
  }

  private renderWeek(today: DayKey): void {
    const days = weekDays(this.week);
    const groups = groupByDay(this.tasks, days);
    const nav = h(
      "div",
      { class: "week-nav" },
      iconButton("back", "Tuần trước", () => ((this.week = addDays(this.week, -7)), this.render())),
      h("span", { class: "week-label" }, `${longDate(days[0])} – ${longDate(days[6])}`),
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => ((this.week = weekStart(today)), this.render()) }, "Tuần này"),
      iconButton("chevron", "Tuần sau", () => ((this.week = addDays(this.week, 7)), this.render())),
    );
    const cols = days.map((d) =>
      h(
        "section",
        { class: `day-col ${d === today ? "is-today" : ""}`, "data-day": d },
        h(
          "header",
          {},
          h("span", { class: "day-name" }, d === today ? "Hôm nay" : weekdayName(d)),
          h("span", { class: "day-date" }, `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`),
          iconButton("plus", "Thêm việc ngày này", () => void this.edit(null, d)),
        ),
        groups.get(d)!.length ? this.list(groups.get(d)!, today, true) : h("p", { class: "muted small pad-s" }, "—"),
      ),
    );
    this.body.replaceChildren(nav, h("div", { class: "week-grid" }, ...cols));
  }

  private renderAll(today: DayKey): void {
    const open = this.tasks.filter((t) => !t.done);
    const dated = open.filter((t) => t.date).sort((a, b) => a.date!.localeCompare(b.date!));
    const undated = open.filter((t) => !t.date);
    const done = this.tasks.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    const toggle = h("label", { class: "radio inline" }, h("input", { type: "checkbox", checked: this.showDone, onchange: () => ((this.showDone = !this.showDone), this.render()) }), h("span", {}, `Hiện việc đã xong (${done.length})`));
    this.body.replaceChildren(
      h("h2", { class: "plan-h" }, "Sắp tới"),
      dated.length ? this.list(dated, today) : this.empty("Không có việc nào có hẹn ngày."),
      h("h2", { class: "plan-h" }, "Không hẹn ngày"),
      undated.length ? this.list(undated, today) : this.empty("—"),
      toggle,
    );
    if (this.showDone) this.body.append(this.list(done, today));
  }

  private empty(text: string): HTMLElement {
    return h("p", { class: "muted plan-empty" }, text);
  }

  private list(tasks: Task[], today: DayKey, compact = false): HTMLElement {
    return h("ul", { class: `task-list ${compact ? "compact" : ""}` }, ...tasks.map((t) => this.row(t, today, compact)));
  }

  private row(t: Task, today: DayKey, compact: boolean): HTMLElement {
    const check = h("input", { type: "checkbox", class: "task-check", checked: t.done, "aria-label": "Đã xong", "data-testid": "task-check" });
    check.addEventListener("change", () => void this.toggle(t));
    const subject = t.subjectId ? this.cats.find((c) => c.id === t.subjectId)?.name : null;
    const book = t.bookId ? this.books.find((b) => b.id === t.bookId) : null;
    const chips: HTMLElement[] = [];
    if (t.kind === "deadline") chips.push(h("span", { class: "chip-s exam" }, "Deadline · Thi"));
    if (t.kind === "goal") chips.push(h("span", { class: "chip-s" }, "Dự định"));
    if (t.repeat) chips.push(h("span", { class: "chip-s repeat", "data-testid": "repeat-chip", html: `${icon("repeat", 12)} ${REPEAT_LABEL[t.repeat]}` }));
    if (subject) chips.push(h("span", { class: "chip-s" }, subject));
    if (t.date && !compact) chips.push(h("span", { class: `chip-s ${isOverdue(t, today) ? "late" : ""}` }, isOverdue(t, today) ? `Quá hạn · ${friendlyDay(t.date, today)}` : friendlyDay(t.date, today)));
    const open = book
      ? h("button", {
          class: "btn btn-ghost open-book",
          type: "button",
          "data-testid": "task-open",
          title: `${book.title}${t.page ? ` · tr. ${t.page}` : ""}`,
          html: `${icon(book.kind === "notebook" ? "notebook" : "book", 16)}<span>${
            compact ? (t.page ? `Mở · tr. ${t.page}` : "Mở") : `${escapeText(shorten(book.title, 28))}${t.page ? ` · tr. ${t.page}` : ""}`
          }</span>`,
          onclick: () => this.deps.onOpenBook(book.id, t.page),
        })
      : null;
    const more = iconButton("more", "Tùy chọn", () =>
      popupMenu(more, [
        { label: "Sửa", run: () => void this.edit(t) },
        { label: "Xóa", danger: true, run: () => void this.remove(t) },
      ]),
    );
    return h(
      "li",
      { class: `task ${t.done ? "done" : ""} ${isOverdue(t, today) ? "late" : ""}`, "data-testid": "task", "data-id": t.id },
      check,
      h("div", { class: "task-main" }, h("div", { class: "task-title" }, t.title), chips.length ? h("div", { class: "task-chips" }, ...chips) : null, open),
      more,
    );
  }

  private async toggle(t: Task): Promise<void> {
    const { update, next } = toggled(t, this.today());
    await this.deps.store.putTask(update);
    if (next) {
      // The finished one stays as history; the next occurrence appears.
      await this.deps.store.putTask(next);
      toast(`Tốt lắm! Lần tới: ${friendlyDay(next.date!, this.today())}.`);
    } else if (update.done) {
      toast("Tốt lắm! Đã đánh dấu xong.");
    }
    await this.refresh();
  }

  private async remove(t: Task): Promise<void> {
    if (!(await confirmDialog("Xóa việc này?", `“${t.title}” sẽ bị xóa khỏi kế hoạch.`, "Xóa", true))) return;
    await this.deps.store.deleteTask(t.id);
    await this.refresh();
  }

  /** Create (t = null) or edit a task. */
  async edit(t: Task | null, presetDate?: DayKey | null, presetKind?: Task["kind"]): Promise<boolean> {
    const today = this.today();
    const shelves = flatten(buildTree(this.cats));
    const result = await modal((close) => {
      const title = h("input", { class: "text-input", type: "text", placeholder: "Ví dụ: Ôn chương 12 Rolls-Royce, Làm đề M11…", value: t?.title ?? "", "data-testid": "task-title" });
      const kind = h(
        "select",
        { class: "text-input", "data-testid": "task-kind" },
        h("option", { value: "task" }, "Việc cần làm"),
        h("option", { value: "deadline" }, "Deadline / Kỳ thi (có đếm ngược)"),
        h("option", { value: "goal" }, "Dự định (mục tiêu dài hạn)"),
      );
      kind.value = t?.kind ?? presetKind ?? "task";
      const date = h("input", { class: "text-input", type: "date", value: t ? (t.date ?? "") : presetDate === null ? "" : (presetDate ?? today), "data-testid": "task-date" });
      const quick = h(
        "div",
        { class: "quick-dates" },
        ...[
          ["Hôm nay", today],
          ["Ngày mai", addDays(today, 1)],
          ["Tuần sau", addDays(today, 7)],
          ["Không hẹn", ""],
        ].map(([label, v]) => h("button", { class: "chip-s btnlike", type: "button", onclick: () => (date.value = v) }, label)),
      );
      const subject = h("select", { class: "text-input", "data-testid": "task-subject" }, h("option", { value: "" }, "— Môn / danh mục —"));
      for (const n of shelves) subject.append(h("option", { value: n.category.id }, `${"  ".repeat(n.depth)}${n.category.name}`));
      subject.value = t?.subjectId ?? "";
      const book = h("select", { class: "text-input", "data-testid": "task-book" }, h("option", { value: "" }, "— Gắn với sách / vở (tùy chọn) —"));
      for (const b of this.books) book.append(h("option", { value: b.id }, `${b.kind === "notebook" ? "📓 " : ""}${b.title}`));
      book.value = t?.bookId ?? "";
      const page = h("input", { class: "text-input", type: "number", min: "1", placeholder: "Trang", value: t?.page ? String(t.page) : "", "data-testid": "task-page" });
      const repeat = h(
        "select",
        { class: "text-input", "data-testid": "task-repeat" },
        h("option", { value: "" }, "Không lặp lại"),
        ...(Object.entries(REPEAT_LABEL) as [Repeat, string][]).map(([v, label]) => h("option", { value: v }, label)),
      );
      repeat.value = t?.repeat ?? "";
      const form = h(
        "form",
        { class: "modal modal-wide task-form", role: "dialog", "aria-modal": "true", "data-testid": "task-form" },
        h("h2", {}, t ? "Sửa việc" : "Thêm việc"),
        title,
        h("div", { class: "form-grid" }, h("label", {}, "Loại", kind), h("label", {}, "Ngày", date, quick)),
        h("div", { class: "form-grid" }, h("label", {}, "Môn", subject), h("label", { class: "book-pick" }, "Sách / vở", book, page)),
        h("div", { class: "form-grid" }, h("label", {}, "Lặp lại", repeat), h("span")),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
          h("button", { class: "btn btn-primary", type: "submit", "data-testid": "task-save" }, t ? "Lưu" : "Thêm"),
        ),
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!title.value.trim()) {
          title.focus();
          return;
        }
        close({
          title: title.value.trim().slice(0, 200),
          kind: kind.value as Task["kind"],
          date: date.value || null,
          subjectId: subject.value || null,
          bookId: book.value || null,
          page: page.value ? Math.max(1, Math.round(Number(page.value))) : null,
          repeat: (repeat.value || null) as Repeat | null,
        });
      });
      setTimeout(() => title.focus(), 0);
      return form;
    });
    if (!result) return false;
    const data = result as Pick<Task, "title" | "kind" | "date" | "subjectId" | "bookId" | "page" | "repeat">;
    // A repeating task needs a day to repeat from.
    if (data.repeat && !data.date) data.date = this.today();
    const task: Task = t
      ? { ...t, ...data }
      : { id: crypto.randomUUID(), ...data, done: false, doneAt: null, createdAt: Date.now() };
    await this.deps.store.putTask(task);
    toast(t ? "Đã lưu." : "Đã thêm vào kế hoạch.");
    await this.refresh();
    return true;
  }
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
