/**
 * Study timer (Pomodoro-style) as a pure state machine: no clock, no DOM.
 * The UI passes `now` in; events tell it when to *suggest* a break. Nothing
 * here ever stops the user from reading.
 */
export interface TimerConfig {
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  /** A long break after this many focus blocks. */
  longEvery: number;
}

export const PRESETS: { label: string; cfg: TimerConfig }[] = [
  { label: "25 phút học · 5 phút nghỉ", cfg: { focusMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 4 } },
  { label: "50 phút học · 10 phút nghỉ", cfg: { focusMin: 50, breakMin: 10, longBreakMin: 20, longEvery: 3 } },
  { label: "90 phút học · 15 phút nghỉ", cfg: { focusMin: 90, breakMin: 15, longBreakMin: 30, longEvery: 2 } },
];

export type Phase = "idle" | "focus" | "break";

export interface TimerState {
  phase: Phase;
  paused: boolean;
  /** When the current phase ends (ms epoch), if running. */
  endsAt: number;
  /** Remaining ms while paused. */
  remaining: number;
  /** Focus blocks completed in this sitting. */
  blocks: number;
  /** Start of the current running stretch of focus (for logging). */
  focusSince: number | null;
  /** Focus phase overran by the user's choice ("Học tiếp"). */
  overtime: boolean;
  longBreak: boolean;
}

export type TimerEvent = { type: "focusDone"; longBreak: boolean } | { type: "breakDone" };

export const IDLE: TimerState = {
  phase: "idle",
  paused: false,
  endsAt: 0,
  remaining: 0,
  blocks: 0,
  focusSince: null,
  overtime: false,
  longBreak: false,
};

const MIN = 60_000;

export class StudyTimer {
  state: TimerState = { ...IDLE };

  constructor(public cfg: TimerConfig) {}

  /** ms left in the current phase (negative = overtime). */
  remaining(now: number): number {
    if (this.state.phase === "idle") return 0;
    return this.state.paused ? this.state.remaining : this.state.endsAt - now;
  }

  /** Starts a focus block; returns focus ms to log from a previous stretch. */
  startFocus(now: number, minutes = this.cfg.focusMin): number {
    const logged = this.collect(now);
    this.state = {
      ...this.state,
      phase: "focus",
      paused: false,
      endsAt: now + minutes * MIN,
      remaining: 0,
      focusSince: now,
      overtime: false,
      longBreak: false,
    };
    return logged;
  }

  startBreak(now: number): number {
    const logged = this.collect(now);
    const long = this.state.longBreak;
    const minutes = long ? this.cfg.longBreakMin : this.cfg.breakMin;
    this.state = { ...this.state, phase: "break", paused: false, endsAt: now + minutes * MIN, remaining: 0, overtime: false };
    return logged;
  }

  /** "Học thêm N phút": keeps the focus block going. */
  extend(now: number, minutes: number): void {
    if (this.state.phase !== "focus") return;
    // After a suggestion the phase is open-ended (Infinity): count from now.
    const base = Number.isFinite(this.state.endsAt) && this.state.endsAt > now ? this.state.endsAt : now;
    this.state = { ...this.state, endsAt: base + minutes * MIN, overtime: false };
  }

  /** "Bỏ qua": keep studying without a timer target until the user stops. */
  continueWithoutBreak(): void {
    if (this.state.phase === "focus") this.state = { ...this.state, overtime: true, endsAt: Number.POSITIVE_INFINITY };
  }

  pause(now: number): number {
    if (this.state.phase === "idle" || this.state.paused) return 0;
    const logged = this.collect(now);
    this.state = { ...this.state, paused: true, remaining: this.state.endsAt - now, focusSince: null };
    return logged;
  }

  resume(now: number): void {
    if (!this.state.paused) return;
    this.state = {
      ...this.state,
      paused: false,
      endsAt: now + this.state.remaining,
      focusSince: this.state.phase === "focus" ? now : null,
    };
  }

  stop(now: number): number {
    const logged = this.collect(now);
    this.state = { ...IDLE };
    return logged;
  }

  /** Advances time. Returns an event when a phase ends (once). */
  tick(now: number): TimerEvent | null {
    const s = this.state;
    if (s.phase === "idle" || s.paused || now < s.endsAt) return null;
    if (s.phase === "focus") {
      const blocks = s.blocks + 1;
      const longBreak = blocks % this.cfg.longEvery === 0;
      // Keep counting focus time until the user answers the suggestion.
      this.state = { ...s, blocks, longBreak, overtime: true, endsAt: Number.POSITIVE_INFINITY };
      return { type: "focusDone", longBreak };
    }
    this.state = { ...s, phase: "idle", endsAt: 0 };
    return { type: "breakDone" };
  }

  /** Focus ms since the last collection (to add to today's total). */
  collect(now: number): number {
    const since = this.state.focusSince;
    if (this.state.phase !== "focus" || since === null || this.state.paused) return 0;
    this.state = { ...this.state, focusSince: now };
    return Math.max(0, now - since);
  }
}
