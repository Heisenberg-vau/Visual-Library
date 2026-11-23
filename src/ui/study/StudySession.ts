import type { MetaStore } from "../../core/storage/MetaStore";
import { dayKey, formatDuration, mmss } from "../../core/study/dates";
import type { StudyStore } from "../../core/study/StudyStore";
import { IDLE, PRESETS, StudyTimer, type TimerConfig, type TimerState } from "../../core/study/timer";
import { todayList, type Task } from "../../core/study/tasks";
import { h, icon } from "../dom";
import { modal } from "../feedback";
import type { SoundScape } from "./sound";

const LOG_EVERY_MS = 30_000;
/** If the app was closed longer than this mid-session, that gap is not study time. */
const MAX_GAP_MS = 3 * 60 * 60_000;

/**
 * App-wide study session: one timer whether you are on the shelf or reading.
 * Suggests breaks, never forces them. Logs focus time per day and per book.
 */
export class StudySession {
  readonly timer: StudyTimer;
  private listeners = new Set<() => void>();
  private interval = 0;
  private sinceLog = 0;
  private todayMs = 0;
  private today = dayKey(new Date());
  /** Book being read now, for per-book totals. */
  bookId: string | null = null;
  /** Test hook: shifts the clock. */
  private offset = 0;
  private prompting = false;

  constructor(
    private readonly meta: MetaStore,
    private readonly store: StudyStore,
    private readonly sound: SoundScape,
    private readonly openPlanner: () => void,
    private readonly openTask: (t: Task) => void,
  ) {
    this.timer = new StudyTimer(PRESETS[0].cfg);
  }

  now(): number {
    return Date.now() + this.offset;
  }

  async init(): Promise<void> {
    this.timer.cfg = await this.meta.getSetting<TimerConfig>("timerCfg", PRESETS[0].cfg);
    const saved = await this.meta.getSetting<TimerState | null>("timerState", null);
    if (saved && saved.phase !== "idle") {
      this.timer.state = { ...IDLE, ...saved, endsAt: saved.endsAt ?? Number.POSITIVE_INFINITY };
      if (this.timer.state.focusSince && this.now() - this.timer.state.focusSince > MAX_GAP_MS) {
        this.timer.state.focusSince = this.now();
      }
    }
    this.todayMs = (await this.store.getDay(this.today)).ms;
    this.interval = window.setInterval(() => this.tick(), 1000);
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    const st = this.timer.state;
    // JSON can't hold Infinity; store null for "open ended".
    void this.meta.setSetting("timerState", { ...st, endsAt: Number.isFinite(st.endsAt) ? st.endsAt : null });
  }

  /** Today's focus time, including the running stretch. */
  get todayTotal(): number {
    const s = this.timer.state;
    const running = s.phase === "focus" && !s.paused && s.focusSince ? this.now() - s.focusSince : 0;
    return this.todayMs + running;
  }

  private log(ms: number): void {
    if (ms <= 0) return;
    const day = dayKey(new Date(this.now()));
    if (day !== this.today) {
      this.today = day;
      this.todayMs = 0;
    }
    this.todayMs += ms;
    void this.store.addTime(day, ms, this.bookId);
  }

  start(): void {
    this.log(this.timer.startFocus(this.now()));
    this.persist();
    this.emit();
  }

  pause(): void {
    this.log(this.timer.pause(this.now()));
    this.persist();
    this.emit();
  }

  resume(): void {
    this.timer.resume(this.now());
    this.persist();
    this.emit();
  }

  stop(): void {
    this.log(this.timer.stop(this.now()));
    this.persist();
    this.emit();
  }

  async setConfig(cfg: TimerConfig): Promise<void> {
    this.timer.cfg = cfg;
    await this.meta.setSetting("timerCfg", cfg);
    this.emit();
  }

  /** For tests: pretend time passed. */
  debugAdvance(ms: number): void {
    this.offset += ms;
    this.tick();
  }

  private tick(): void {
    const now = this.now();
    this.sinceLog += 1000;
    if (this.sinceLog >= LOG_EVERY_MS) {
      this.sinceLog = 0;
      this.log(this.timer.collect(now));
    }
    const ev = this.timer.tick(now);
    if (ev) {
      this.persist();
      if (ev.type === "focusDone") void this.suggestBreak(ev.longBreak);
      else void this.suggestNext();
    }
    this.emit();
  }

  private alert(): void {
    this.sound.chime();
    navigator.vibrate?.([80, 60, 80]);
  }

  /** Gentle suggestion; every choice is the user's. */
  private async suggestBreak(long: boolean): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    this.alert();
    const cfg = this.timer.cfg;
    const breakMin = long ? cfg.longBreakMin : cfg.breakMin;
    const choice = await modal((close) =>
      h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true", "data-testid": "break-suggest" },
        h("h2", {}, `Bạn đã học ${cfg.focusMin} phút 👏`),
        h(
          "p",
          {},
          long
            ? `Đã ${this.timer.state.blocks} phiên rồi. Nghỉ dài ${breakMin} phút: đứng dậy, uống nước, nhìn ra xa nhé. Đây chỉ là gợi ý.`
            : `Nghỉ ${breakMin} phút cho mắt và đầu óc nhé? Đây chỉ là gợi ý, bạn vẫn có thể học tiếp.`,
        ),
        h(
          "div",
          { class: "modal-actions wrap" },
          h("button", { class: "btn", type: "button", "data-testid": "keep-going", onclick: () => close("keep") }, "Học tiếp, không nhắc"),
          h("button", { class: "btn", type: "button", "data-testid": "plus10", onclick: () => close("plus10") }, "Học thêm 10 phút"),
          h("button", { class: "btn btn-primary", type: "button", "data-testid": "take-break", onclick: () => close("break") }, `Nghỉ ${breakMin} phút`),
        ),
      ),
    );
    this.prompting = false;
    const now = this.now();
    if (choice === "break") this.log(this.timer.startBreak(now));
    else if (choice === "plus10") this.timer.extend(now, 10);
    else this.timer.continueWithoutBreak(); // also when dismissed
    this.persist();
    this.emit();
  }

  private async suggestNext(): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    this.alert();
    const choice = await modal((close) =>
      h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true", "data-testid": "break-over" },
        h("h2", {}, "Hết giờ nghỉ"),
        h("p", {}, "Sẵn sàng cho phiên học tiếp theo chưa?"),
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Để sau"),
          h("button", { class: "btn btn-primary", type: "button", "data-testid": "start-next", onclick: () => close("go") }, "Bắt đầu học"),
        ),
      ),
    );
    this.prompting = false;
    if (choice === "go") this.start();
  }

  // ---- UI pieces ----------------------------------------------------

  /** Small button showing the timer; opens the panel. Call dispose when the view goes away. */
  chip(): { el: HTMLButtonElement; dispose: () => void } {
    const b = h("button", { class: "timer-chip", type: "button", "data-testid": "timer-chip", title: "Đồng hồ học" });
    const render = () => {
      const s = this.timer.state;
      const left = this.timer.remaining(this.now());
      b.dataset.phase = s.paused ? "paused" : s.phase;
      if (s.phase === "idle") b.innerHTML = `${icon("timer", 18)}<span>Học</span>`;
      else if (s.overtime) b.innerHTML = `${icon("timer", 18)}<span>+${mmss(this.now() - (s.focusSince ?? this.now()))}</span>`;
      else b.innerHTML = `${icon(s.phase === "break" ? "coffee" : "timer", 18)}<span>${mmss(left)}</span>`;
    };
    render();
    const off = this.onChange(render);
    b.addEventListener("click", () => void this.openPanel(b));
    return { el: b, dispose: off };
  }

  async openPanel(anchor: HTMLElement): Promise<void> {
    const tasks = todayList(await this.store.listTasks(), dayKey(new Date(this.now())));
    const backdrop = h("div", { class: "menu-backdrop" });
    const close = () => {
      off();
      backdrop.remove();
    };
    const panel = h("div", { class: "palette study-panel", "data-testid": "study-panel" });
    const render = () => {
      const s = this.timer.state;
      const left = this.timer.remaining(this.now());
      const big =
        s.phase === "idle"
          ? mmss(this.timer.cfg.focusMin * 60_000)
          : s.overtime
            ? `+${mmss(this.now() - (s.focusSince ?? this.now()))}`
            : mmss(left);
      const label = s.phase === "idle" ? "Sẵn sàng" : s.phase === "break" ? (s.paused ? "Đang tạm dừng (nghỉ)" : "Đang nghỉ") : s.paused ? "Tạm dừng" : "Đang học";
      const btn = (text: string, run: () => void, cls = "", id = "") =>
        h("button", { class: `btn ${cls}`, type: "button", onclick: run, "data-testid": id || undefined }, text);
      const actions =
        s.phase === "idle"
          ? [btn("Bắt đầu học", () => this.start(), "btn-primary", "timer-start")]
          : [
              s.paused ? btn("Tiếp tục", () => this.resume(), "btn-primary", "timer-resume") : btn("Tạm dừng", () => this.pause(), "", "timer-pause"),
              btn("Kết thúc", () => this.stop(), "", "timer-stop"),
            ];
      const preset = h("select", { class: "text-input", "aria-label": "Nhịp học", "data-testid": "timer-preset" });
      const cur = this.timer.cfg;
      PRESETS.forEach((p, i) => {
        const o = h("option", { value: String(i) }, p.label);
        if (p.cfg.focusMin === cur.focusMin && p.cfg.breakMin === cur.breakMin) o.selected = true;
        preset.append(o);
      });
      const custom = h("option", { value: "custom" }, `Tự chọn: ${cur.focusMin} học · ${cur.breakMin} nghỉ`);
      if (!PRESETS.some((p) => p.cfg.focusMin === cur.focusMin && p.cfg.breakMin === cur.breakMin)) custom.selected = true;
      preset.append(custom);
      const customRow = h(
        "div",
        { class: "custom-row", hidden: !custom.selected },
        h("label", {}, "Học ", h("input", { type: "number", min: "5", max: "180", value: String(cur.focusMin), class: "num", "data-testid": "focus-min" }), " phút"),
        h("label", {}, "Nghỉ ", h("input", { type: "number", min: "1", max: "60", value: String(cur.breakMin), class: "num", "data-testid": "break-min" }), " phút"),
      );
      const applyCustom = () => {
        const [f, b] = [...customRow.querySelectorAll("input")].map((i) => Math.round(Number((i as HTMLInputElement).value)));
        if (f >= 1 && b >= 1) void this.setConfig({ focusMin: f, breakMin: b, longBreakMin: Math.max(b, Math.round(b * 3)), longEvery: 4 });
      };
      customRow.addEventListener("change", applyCustom);
      preset.addEventListener("change", () => {
        if (preset.value === "custom") customRow.hidden = false;
        else void this.setConfig(PRESETS[Number(preset.value)].cfg);
      });
      const taskList = h(
        "div",
        { class: "today-tasks" },
        ...(tasks.length
          ? tasks.slice(0, 6).map((t) => {
              const row = h("button", { class: `today-task ${t.done ? "done" : ""}`, type: "button", onclick: () => (close(), this.openTask(t)) }, h("span", { class: "tt-dot" }), t.title);
              return row;
            })
          : [h("p", { class: "muted small" }, "Chưa có việc cho hôm nay.")]),
      );
      panel.replaceChildren(
        h("div", { class: "timer-big", "data-testid": "timer-big" }, big),
        h("div", { class: "timer-label" }, label),
        h("div", { class: "row-gap center" }, ...actions),
        h("h4", {}, "Nhịp học"),
        preset,
        customRow,
        h("div", { class: "today-total", "data-testid": "today-total" }, `Hôm nay đã học: ${formatDuration(this.todayTotal)}`),
        h("h4", {}, "Việc hôm nay"),
        taskList,
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => (close(), this.openPlanner()) }, "Mở kế hoạch học →"),
      );
    };
    // Only re-render the clock part each second, not the form controls.
    let lastPhase = "";
    const off = this.onChange(() => {
      const key = `${this.timer.state.phase}|${this.timer.state.paused}|${this.timer.state.overtime}`;
      if (key !== lastPhase) {
        lastPhase = key;
        render();
      } else {
        const s = this.timer.state;
        const el = panel.querySelector(".timer-big");
        if (el) el.textContent = s.phase === "idle" ? mmss(this.timer.cfg.focusMin * 60_000) : s.overtime ? `+${mmss(this.now() - (s.focusSince ?? this.now()))}` : mmss(this.timer.remaining(this.now()));
        const tot = panel.querySelector(".today-total");
        if (tot) tot.textContent = `Hôm nay đã học: ${formatDuration(this.todayTotal)}`;
      }
    });
    render();
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.append(panel);
    document.body.append(backdrop);
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + 6 + panel.offsetHeight > window.innerHeight ? Math.max(8, r.top - panel.offsetHeight - 6) : r.bottom + 6;
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.left - 140))}px`;
  }

  destroy(): void {
    clearInterval(this.interval);
  }
}
