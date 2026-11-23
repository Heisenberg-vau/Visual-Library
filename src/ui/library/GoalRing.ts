import { h } from "../dom";
import { modal } from "../feedback";

/** Optional daily goal. No warnings, no streaks: just a quiet ring. */
export interface DailyGoal {
  kind: "pages" | "minutes";
  target: number;
}

export interface GoalDeps {
  get(): Promise<DailyGoal | null>;
  set(g: DailyGoal | null): Promise<void>;
  pagesToday(): Promise<number>;
  minutesToday(): number;
}

export class GoalRing {
  readonly el: HTMLButtonElement;

  constructor(private readonly deps: GoalDeps) {
    this.el = h("button", { class: "goal-ring", type: "button", "data-testid": "goal-ring", title: "Mục tiêu mỗi ngày" });
    this.el.addEventListener("click", () => void this.edit());
  }

  async refresh(): Promise<void> {
    const g = await this.deps.get();
    if (!g) {
      this.el.innerHTML = `${ring(0)}<span class="goal-text">Mục tiêu</span>`;
      this.el.dataset.state = "off";
      return;
    }
    const done = g.kind === "pages" ? await this.deps.pagesToday() : this.deps.minutesToday();
    const f = Math.min(1, done / Math.max(1, g.target));
    this.el.dataset.state = f >= 1 ? "done" : "on";
    this.el.innerHTML = `${ring(f)}<span class="goal-text">${done}/${g.target} ${g.kind === "pages" ? "trang" : "phút"}</span>`;
  }

  private async edit(): Promise<void> {
    const cur = await this.deps.get();
    const r = await modal((close) => {
      const kind = h(
        "select",
        { class: "text-input", "data-testid": "goal-kind" },
        h("option", { value: "off" }, "Không đặt mục tiêu"),
        h("option", { value: "pages" }, "Số trang đọc mỗi ngày"),
        h("option", { value: "minutes" }, "Số phút học mỗi ngày"),
      );
      kind.value = cur?.kind ?? "off";
      const target = h("input", { class: "text-input", type: "number", min: "1", max: "1000", value: String(cur?.target ?? 20), "data-testid": "goal-target" });
      const form = h(
        "form",
        { class: "modal", role: "dialog", "aria-modal": "true", "data-testid": "goal-form" },
        h("h2", {}, "Mục tiêu mỗi ngày"),
        h(
          "p",
          {},
          "Chỉ để bạn tự theo dõi, không có nhắc nhở hay cảnh báo. Trang đọc lại trong ngày cũng được tính (ôn bài cũng là học); một trang được tính khi bạn ở trên nó ít nhất 8 giây. Số phút lấy từ đồng hồ học.",
        ),
        kind,
        h("div", { style: "height:10px" }),
        target,
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
          h("button", { class: "btn btn-primary", type: "submit", "data-testid": "goal-save" }, "Lưu"),
        ),
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        close(kind.value === "off" ? { off: true } : { kind: kind.value, target: Math.max(1, Math.round(Number(target.value) || 1)) });
      });
      return form;
    });
    if (!r) return;
    await this.deps.set("off" in (r as object) ? null : (r as DailyGoal));
    await this.refresh();
  }
}

function ring(f: number): string {
  const r = 9;
  const c = 2 * Math.PI * r;
  return `<svg class="ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="${r}" fill="none" stroke="#e4ded2" stroke-width="3.2"/><circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 12 12)"/></svg>`;
}
