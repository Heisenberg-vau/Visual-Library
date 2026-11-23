import { round1, simplify, snapHorizontal, straighten, strokeHitSegment } from "../../core/annotations/geometry";
import type { InkModel } from "../../core/annotations/InkModel";
import type { InkTool, Stroke } from "../../core/annotations/types";
import { h } from "../dom";
import { isStylus, type PageFrame, type PageScroller, type SlotHooks } from "./PageScroller";

export type Tool = "hand" | InkTool | "eraser";

export interface ToolState {
  tool: Tool;
  penColor: string;
  penWidth: number; // PDF points
  hlColor: string;
  ulColor: string;
}

export const DEFAULT_TOOLS: ToolState = {
  tool: "pen",
  penColor: "#1d2430",
  penWidth: 1.6,
  hlColor: "#ffd400",
  ulColor: "#d03a2f",
};

const HL_WIDTH = 12;
const UL_WIDTH = 1.8;
const HL_ALPHA = 0.38;
const ERASER_PX = 12; // eraser radius in CSS px, independent of zoom
const MAX_PIXELS = 16_000_000;

interface InkSlot {
  index: number;
  el: HTMLElement;
  hl: HTMLCanvasElement; // highlighter, blended "multiply" so text stays crisp
  ink: HTMLCanvasElement; // pen + underline
  live: HTMLCanvasElement; // stroke in progress
  frame: PageFrame;
  ratio: number;
}

interface Gesture {
  pointerId: number;
  page: number;
  mode: "draw" | "erase";
  tool: InkTool;
  color: string;
  width: number;
  points: number[];
  erased: Set<string>;
  lastX: number;
  lastY: number;
}

let idSeq = 0;
const newStrokeId = () => `${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Handwriting on top of the page view. Pen (and mouse, for laptops) writes;
 * fingers keep scrolling and zooming. The stylus never scrolls the page.
 */
export class InkLayer implements SlotHooks {
  private slots = new Map<number, InkSlot>();
  private gesture: Gesture | null = null;
  private raf = 0;
  private unsub: () => void;
  private lastPenAt = 0;

  constructor(
    private readonly scroller: PageScroller,
    private readonly model: InkModel,
    private readonly tools: () => ToolState,
    private readonly onHistory: () => void,
  ) {
    const el = scroller.el;
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onCancel);
    el.addEventListener("touchstart", this.onTouchStart, { passive: false });
    el.addEventListener("touchmove", this.onTouchMove, { passive: false });
    this.unsub = model.onChange((p) => {
      this.redraw(p);
      this.onHistory();
    });
    scroller.hooks = this;
  }

  // ---- SlotHooks ----------------------------------------------------

  attach(index: number, el: HTMLElement, frame: PageFrame): void {
    const mk = (cls: string) => h("canvas", { class: `ink-canvas ${cls}` });
    const s: InkSlot = { index, el, hl: mk("ink-hl"), ink: mk("ink-pen"), live: mk("ink-live"), frame, ratio: 1 };
    el.append(s.hl, s.ink, s.live);
    this.slots.set(index, s);
    this.size(s, frame);
  }

  resize(index: number, frame: PageFrame): void {
    const s = this.slots.get(index);
    if (s) this.size(s, frame);
  }

  detach(index: number): void {
    const s = this.slots.get(index);
    if (!s) return;
    for (const c of [s.hl, s.ink, s.live]) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    this.slots.delete(index);
  }

  private size(s: InkSlot, f: PageFrame): void {
    s.frame = f;
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (f.width * f.height * ratio * ratio > MAX_PIXELS) ratio = Math.sqrt(MAX_PIXELS / (f.width * f.height));
    s.ratio = ratio;
    for (const c of [s.hl, s.ink, s.live]) {
      c.width = Math.max(1, Math.round(f.width * ratio));
      c.height = Math.max(1, Math.round(f.height * ratio));
    }
    this.paint(s);
  }

  // ---- drawing --------------------------------------------------------

  private ctx(s: InkSlot, c: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = c.getContext("2d")!;
    const k = s.ratio * s.frame.scale;
    ctx.setTransform(k, 0, 0, k, s.ratio * s.frame.offsetX, 0);
    return ctx;
  }

  private clear(c: HTMLCanvasElement): void {
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }

  redraw(page: number): void {
    const s = this.slots.get(page);
    if (s) this.paint(s);
  }

  private paint(s: InkSlot): void {
    this.clear(s.hl);
    this.clear(s.ink);
    const skip = this.gesture?.page === s.index ? this.gesture.erased : null;
    const hl = this.ctx(s, s.hl);
    const ink = this.ctx(s, s.ink);
    for (const st of this.model.strokes(s.index)) {
      if (skip?.has(st.id)) continue;
      drawStroke(st.tool === "highlighter" ? hl : ink, st);
    }
  }

  private paintLive(): void {
    this.raf = 0;
    const g = this.gesture;
    if (!g) return;
    const s = this.slots.get(g.page);
    if (!s) return;
    this.clear(s.live);
    if (g.mode === "erase") return;
    const ctx = this.ctx(s, s.live);
    let pts = g.points;
    if (g.tool === "underline" && pts.length >= 4) pts = snapHorizontal([pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
    drawStroke(ctx, { id: "live", tool: g.tool, color: g.color, width: g.width, points: pts });
  }

  private scheduleLive(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paintLive());
  }

  // ---- input --------------------------------------------------------

  /** Client point -> page index + PDF point coordinates. */
  private toPage(page: number, clientX: number, clientY: number): { x: number; y: number } | null {
    const s = this.slots.get(page);
    if (!s) return null;
    const r = s.el.getBoundingClientRect();
    // r may be scaled by an in-progress pinch; use the ratio of rendered size.
    const k = r.width / s.frame.width || 1;
    return {
      x: ((clientX - r.left) / k - s.frame.offsetX) / s.frame.scale,
      y: (clientY - r.top) / k / s.frame.scale,
    };
  }

  private writes(e: PointerEvent): boolean {
    if (e.pointerType === "touch") return false; // fingers scroll/zoom
    if (e.pointerType === "mouse" && e.button !== 0) return false;
    const eraserButton = (e.buttons & 32) !== 0; // pen's eraser end / side button
    return eraserButton || this.tools().tool !== "hand";
  }

  private onDown = (e: PointerEvent): void => {
    if (this.gesture || !this.writes(e)) return;
    const slotEl = (e.target as Element | null)?.closest?.(".page-slot") as HTMLElement | null;
    if (!slotEl) return;
    const page = Number(slotEl.dataset.page) - 1;
    const pt = this.toPage(page, e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    this.scroller.el.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "pen") this.lastPenAt = performance.now();
    const t = this.tools();
    const erase = t.tool === "eraser" || (e.buttons & 32) !== 0;
    const tool: InkTool = t.tool === "highlighter" || t.tool === "underline" ? t.tool : "pen";
    this.gesture = {
      pointerId: e.pointerId,
      page,
      mode: erase ? "erase" : "draw",
      tool,
      color: tool === "highlighter" ? t.hlColor : tool === "underline" ? t.ulColor : t.penColor,
      width: tool === "highlighter" ? HL_WIDTH : tool === "underline" ? UL_WIDTH : t.penWidth,
      points: [round1(pt.x), round1(pt.y)],
      erased: new Set(),
      lastX: pt.x,
      lastY: pt.y,
    };
    if (erase) this.eraseAt(pt.x, pt.y);
    else this.scheduleLive();
  };

  private onMove = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    e.preventDefault();
    if (e.pointerType === "pen") this.lastPenAt = performance.now();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const pt = this.toPage(g.page, ev.clientX, ev.clientY);
      if (!pt) continue;
      if (g.mode === "erase") this.eraseAt(pt.x, pt.y);
      else g.points.push(round1(pt.x), round1(pt.y));
    }
    if (g.mode === "draw") this.scheduleLive();
  };

  private eraseAt(x: number, y: number): void {
    const g = this.gesture!;
    const s = this.slots.get(g.page);
    const radius = ERASER_PX / (s?.frame.scale || 1);
    let hit = false;
    for (const st of this.model.strokes(g.page)) {
      if (!g.erased.has(st.id) && strokeHitSegment(st, g.lastX, g.lastY, x, y, radius)) {
        g.erased.add(st.id);
        hit = true;
      }
    }
    g.lastX = x;
    g.lastY = y;
    if (hit) this.redraw(g.page);
  }

  private onUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    const s = this.slots.get(g.page);
    if (s) this.clear(s.live);
    if (g.mode === "erase") {
      if (g.erased.size) this.model.remove(g.page, g.erased);
      else this.redraw(g.page);
      return;
    }
    let pts = simplify(g.points, 0.25);
    if (g.tool === "underline") {
      pts = snapHorizontal([pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
      if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < 2) return; // a tap, not a line
    } else if (g.tool === "highlighter") {
      pts = straighten(pts, 3) ?? pts;
    }
    this.model.add(g.page, { id: newStrokeId(), tool: g.tool, color: g.color, width: g.width, points: pts.map(round1) });
  };

  private onCancel = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    const s = this.slots.get(g.page);
    if (s) this.clear(s.live);
    this.redraw(g.page);
  };

  /**
   * Stops the browser from scrolling with the stylus, and with the palm
   * while the pen is writing. Ordinary finger scrolling is untouched.
   */
  private onTouchStart = (e: TouchEvent): void => {
    if (!e.cancelable) return;
    const stylus = [...e.changedTouches].some(isStylus);
    const tool = this.tools().tool;
    if ((stylus && tool !== "hand") || this.penBusy()) e.preventDefault();
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (e.cancelable && this.penBusy()) e.preventDefault();
  };

  private penBusy(): boolean {
    return (this.gesture !== null && this.gesture.mode !== undefined) || performance.now() - this.lastPenAt < 250;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.unsub();
    this.scroller.hooks = null;
    for (const i of [...this.slots.keys()]) this.detach(i);
  }
}

/** Smooth polyline through midpoints (quadratic curves). */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const p = s.points;
  if (!p.length) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineJoin = "round";
  ctx.lineCap = s.tool === "highlighter" ? "butt" : "round";
  if (s.tool === "highlighter") ctx.globalAlpha = HL_ALPHA;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if (p.length === 4) {
    ctx.lineTo(p[2], p[3]);
  } else {
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2;
      const my = (p[i + 1] + p[i + 3]) / 2;
      ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  }
  ctx.stroke();
  ctx.restore();
}
