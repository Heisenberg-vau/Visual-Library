import { h, icon } from "../dom";
import { toast } from "../feedback";
import type { Tool, ToolState } from "./InkLayer";

/*
 * The pen case: docked on one edge of the screen (the right by default, out
 * of a left hand's way). Collapsed it shows the pen in hand, three quick
 * slots (like a game's hotbar) and undo/redo; tapping the pen in hand opens
 * the tray with every tool, its colours and widths.
 */

export interface PenSlot {
  tool: Tool;
  color?: string;
  width?: number;
}

export const DEFAULT_SLOTS: PenSlot[] = [
  { tool: "pen", color: "#1d2430", width: 1.6 },
  { tool: "pen", color: "#d03a2f", width: 1.6 },
  { tool: "highlighter", color: "#ffd400" },
];

export const PEN_COLORS = ["#1d2430", "#1f5fbf", "#d03a2f", "#1e8a4c", "#7b3fb5", "#e07a12"];
export const HL_COLORS = ["#ffd400", "#7ee36a", "#ff8fc7", "#6cc7ff", "#ffa94d"];
export const UL_COLORS = ["#d03a2f", "#1f5fbf", "#1d2430", "#1e8a4c"];
export const PEN_WIDTHS = [1, 1.6, 2.6];

export type Dock = "left" | "right";
const DOCK_KEY = "vl.dock";

export const TOOL_ICON: Record<Tool, string> = {
  hand: "hand",
  pen: "pen",
  highlighter: "highlighter",
  underline: "underline",
  eraser: "eraser",
  clip: "scissors",
};

export function toolName(t: Tool, notebook: boolean): string {
  return { hand: "Chỉ đọc", pen: "Bút", highlighter: "Dạ quang", underline: "Gạch chân", eraser: "Tẩy", clip: notebook ? "Di chuyển" : "Kéo cắt" }[t];
}

/** The colour that goes with the tool in hand (null for tools without one). */
export function toolColor(s: ToolState): string | null {
  return s.tool === "pen" ? s.penColor : s.tool === "highlighter" ? s.hlColor : s.tool === "underline" ? s.ulColor : null;
}

export interface PenCaseDeps {
  notebook: boolean;
  get: () => ToolState & { slots?: PenSlot[] };
  /** Store a new tool state (persisted by the reader). */
  set: (s: ToolState & { slots?: PenSlot[] }) => void;
  setTool: (t: Tool) => void;
  undo: () => void;
  redo: () => void;
  /** The element that carries data-dock (the reader). */
  host: HTMLElement;
  /** The case moved to the other edge. */
  onDock?: () => void;
}

export class PenCase {
  readonly el: HTMLElement;
  readonly tray: HTMLElement;
  private current: HTMLButtonElement;
  private slotBtns: HTMLButtonElement[] = [];
  readonly undoBtn: HTMLButtonElement;
  readonly redoBtn: HTMLButtonElement;
  private toolsGrid: HTMLElement;
  private colors: HTMLElement;

  constructor(private readonly d: PenCaseDeps) {
    const grip = h("div", { class: "pc-grip", title: "Kéo sang cạnh bên kia để dời hộp bút", "aria-hidden": "true" });
    grip.addEventListener("pointerdown", this.onGrip);
    this.current = h("button", { class: "pc-slot pc-main", type: "button", "data-testid": "pen-current", "aria-label": "Bút đang dùng – chạm để mở hộp bút" });
    this.current.addEventListener("click", () => this.openTray(!this.isOpen));
    for (let i = 0; i < 3; i++) {
      const b = h("button", { class: "pc-slot", type: "button", "data-testid": "pen-slot", "data-slot": String(i) });
      this.wireSlot(b, i);
      this.slotBtns.push(b);
    }
    this.undoBtn = h("button", { class: "pc-slot pc-small", type: "button", "data-testid": "undo", "aria-label": "Hoàn tác (chạm 2 ngón)", title: "Hoàn tác (chạm 2 ngón)", html: icon("undo", 20) });
    this.undoBtn.addEventListener("click", () => d.undo());
    this.redoBtn = h("button", { class: "pc-slot pc-small", type: "button", "data-testid": "redo", "aria-label": "Làm lại (chạm 3 ngón)", title: "Làm lại (chạm 3 ngón)", html: icon("redo", 20) });
    this.redoBtn.addEventListener("click", () => d.redo());
    this.el = h(
      "aside",
      { class: "pencase", "data-testid": "pencase", "aria-label": "Hộp bút" },
      grip,
      this.current,
      h("i", { class: "pc-sep" }),
      ...this.slotBtns,
      h("i", { class: "pc-sep" }),
      this.undoBtn,
      this.redoBtn,
    );
    this.toolsGrid = h("div", { class: "pt-tools", "data-testid": "tools" });
    this.toolsGrid.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tool]");
      if (b) d.setTool(b.dataset.tool as Tool);
    });
    this.colors = h("div", { class: "pt-colors" });
    this.tray = h(
      "div",
      { class: "pentray", "data-testid": "pen-tray", role: "dialog", "aria-label": "Hộp bút" },
      h("div", { class: "pt-k" }, "CÔNG CỤ"),
      this.toolsGrid,
      this.colors,
      h("p", { class: "pt-hint" }, "Giữ ô 1 · 2 · 3 để cất bút đang cầm vào ô đó."),
    );
    d.host.dataset.dock = this.dock;
    this.render();
  }

  get dock(): Dock {
    try {
      return localStorage.getItem(DOCK_KEY) === "left" ? "left" : "right";
    } catch {
      return "right";
    }
  }

  setDock(side: Dock): void {
    try {
      localStorage.setItem(DOCK_KEY, side);
    } catch {
      /* ignore */
    }
    if (this.d.host.dataset.dock !== side) {
      this.d.host.dataset.dock = side;
      this.d.onDock?.();
    }
  }

  get isOpen(): boolean {
    return this.tray.classList.contains("open");
  }

  openTray(open: boolean): void {
    this.tray.classList.toggle("open", open);
    this.current.setAttribute("aria-expanded", String(open));
  }

  /** Fades while the pen is on the page. */
  setDrawing(on: boolean): void {
    this.el.classList.toggle("drawing", on);
    if (on) this.openTray(false);
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }

  private get slots(): PenSlot[] {
    const s = this.d.get().slots;
    return s && s.length === 3 ? s : DEFAULT_SLOTS;
  }

  private slotMatches(s: PenSlot, st: ToolState): boolean {
    if (s.tool !== st.tool) return false;
    const c = toolColor(st);
    return !s.color || !c || s.color === c;
  }

  render(): void {
    const st = this.d.get();
    const nb = this.d.notebook;
    const dot = (c: string | null | undefined) => (c ? `<i class="pc-dot" style="background:${c}"></i>` : "");
    this.current.innerHTML = icon(TOOL_ICON[st.tool], 24) + dot(toolColor(st));
    this.current.title = toolName(st.tool, nb);
    this.slots.forEach((s, i) => {
      const b = this.slotBtns[i];
      b.innerHTML = `<small>${i + 1}</small>${icon(TOOL_ICON[s.tool], 20)}${dot(s.color)}`;
      b.classList.toggle("on", this.slotMatches(s, st));
      b.title = `${toolName(s.tool, nb)} – giữ để cất bút đang cầm vào ô này`;
      b.setAttribute("aria-label", `Ô ${i + 1}: ${toolName(s.tool, nb)}`);
    });
    const tools: Tool[] = ["hand", "pen", "highlighter", "underline", "eraser", "clip"];
    this.toolsGrid.replaceChildren(
      ...tools.map((t) => {
        const b = h("button", { class: `pt-tool ${t === st.tool ? "active" : ""}`, type: "button", "data-tool": t, "aria-pressed": String(t === st.tool) }, h("span", { html: icon(TOOL_ICON[t], 20) }), toolName(t, nb));
        return b;
      }),
    );
    // colours (and widths for the pen) of the tool in hand
    const parts: HTMLElement[] = [];
    const key = st.tool === "pen" ? "penColor" : st.tool === "highlighter" ? "hlColor" : st.tool === "underline" ? "ulColor" : null;
    if (key) {
      const list = st.tool === "pen" ? PEN_COLORS : st.tool === "highlighter" ? HL_COLORS : UL_COLORS;
      parts.push(h("div", { class: "pt-k" }, "MÀU"));
      parts.push(
        h(
          "div",
          { class: "pt-swatches", "data-testid": "palette" },
          ...list.map((c) => {
            const b = h("button", { class: `pt-sw ${st[key] === c ? "active" : ""}`, type: "button", "aria-label": `Màu ${c}`, style: `background:${c}` });
            b.addEventListener("click", () => this.d.set({ ...this.d.get(), [key]: c }));
            return b;
          }),
        ),
      );
    }
    if (st.tool === "pen") {
      parts.push(h("div", { class: "pt-k" }, "ĐỘ DÀY NÉT"));
      parts.push(
        h(
          "div",
          { class: "pt-widths" },
          ...PEN_WIDTHS.map((w) => {
            const b = h("button", { class: `pt-w ${st.penWidth === w ? "active" : ""}`, type: "button", "aria-label": `Độ dày ${w}` }, h("span", { style: `height:${Math.round(w * 2)}px` }));
            b.addEventListener("click", () => this.d.set({ ...this.d.get(), penWidth: w }));
            return b;
          }),
        ),
      );
    }
    this.colors.replaceChildren(...parts);
  }

  /** Tap: take that pen. Hold: put the pen in hand into the slot. */
  private wireSlot(b: HTMLButtonElement, i: number): void {
    let timer = 0;
    let held = false;
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("pointerdown", () => {
      held = false;
      timer = window.setTimeout(() => {
        held = true;
        const st = this.d.get();
        if (st.tool === "hand" || st.tool === "eraser" || st.tool === "clip") {
          toast("Chỉ cất được bút, dạ quang hoặc gạch chân vào ô nhanh.");
          return;
        }
        const slots = [...this.slots];
        slots[i] = { tool: st.tool, color: toolColor(st) ?? undefined, width: st.tool === "pen" ? st.penWidth : undefined };
        this.d.set({ ...st, slots });
        navigator.vibrate?.(10);
        toast(`Đã cất ${toolName(st.tool, this.d.notebook).toLowerCase()} này vào ô ${i + 1}.`);
      }, 550);
    });
    const cancel = () => clearTimeout(timer);
    b.addEventListener("pointerleave", cancel);
    b.addEventListener("pointercancel", cancel);
    b.addEventListener("click", () => {
      cancel();
      if (held) return;
      const s = this.slots[i];
      const st = this.d.get();
      const next: ToolState & { slots?: PenSlot[] } = { ...st, tool: s.tool };
      if (s.color) {
        if (s.tool === "pen") next.penColor = s.color;
        if (s.tool === "highlighter") next.hlColor = s.color;
        if (s.tool === "underline") next.ulColor = s.color;
      }
      if (s.tool === "pen" && s.width) next.penWidth = s.width;
      this.d.set(next);
    });
  }

  /** Drag the grip across the screen to dock the case on the other edge. */
  private onGrip = (e: PointerEvent): void => {
    e.preventDefault();
    const move = (ev: PointerEvent) => this.setDock(ev.clientX < window.innerWidth / 2 ? "left" : "right");
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
}
