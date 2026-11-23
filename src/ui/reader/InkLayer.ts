import { round1, simplify, snapHorizontal, straighten, strokeHitSegment } from "../../core/annotations/geometry";
import type { InkModel } from "../../core/annotations/InkModel";
import { HIGHLIGHT_OPACITY, strokeSvg, svgPathData } from "../../core/annotations/path";
import type { InkTool, Stroke } from "../../core/annotations/types";
import { highlightRects, snapUnderline, type CharBox } from "../../core/text/textGeometry";
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
const UL_WIDTH = 1.4;
const ERASER_PX = 12; // eraser radius in CSS px, independent of zoom
const SVG_NS = "http://www.w3.org/2000/svg";

interface InkSlot {
  index: number;
  el: HTMLElement;
  /** Highlights, blended "multiply" so text under them stays crisp. */
  hl: SVGSVGElement;
  /** Pen and underline. */
  ink: SVGSVGElement;
  /** Stroke in progress (one path, moved between the two layers). */
  live: SVGPathElement;
  frame: PageFrame;
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
 * Handwriting on top of the page view, drawn as vector SVG so it is razor
 * sharp at any zoom and screen density. Pen (and mouse, for laptops) writes;
 * fingers keep scrolling and zooming. The stylus never scrolls the page.
 */
export class InkLayer implements SlotHooks {
  private slots = new Map<number, InkSlot>();
  private gesture: Gesture | null = null;
  private raf = 0;
  private unsub: () => void;
  private lastPenAt = 0;
  /** Strokes finishing (text snapping is async); keeps the live path visible. */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly scroller: PageScroller,
    private readonly model: InkModel,
    private readonly tools: () => ToolState,
    private readonly onHistory: () => void,
    private readonly textChars: (page: number) => Promise<CharBox[]>,
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

  /** Resolves when the last stroke has been committed (for tests). */
  settled(): Promise<void> {
    return this.pending;
  }

  // ---- SlotHooks ----------------------------------------------------

  attach(index: number, el: HTMLElement, frame: PageFrame): void {
    const mk = (cls: string) => {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", `ink-svg ${cls}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.append(document.createElementNS(SVG_NS, "g"));
      return svg;
    };
    const live = document.createElementNS(SVG_NS, "path");
    live.setAttribute("fill", "none");
    live.setAttribute("stroke-linejoin", "round");
    const s: InkSlot = { index, el, hl: mk("ink-hl"), ink: mk("ink-pen"), live, frame };
    el.append(s.hl, s.ink);
    this.slots.set(index, s);
    this.size(s, frame);
    this.paint(s);
  }

  resize(index: number, frame: PageFrame): void {
    const s = this.slots.get(index);
    if (s) this.size(s, frame);
  }

  detach(index: number): void {
    const s = this.slots.get(index);
    if (!s) return;
    s.hl.remove();
    s.ink.remove();
    this.slots.delete(index);
  }

  /** Vector ink only needs a new viewBox when zoom or margins change. */
  private size(s: InkSlot, f: PageFrame): void {
    s.frame = f;
    const w = f.width / f.scale;
    const hgt = f.height / f.scale;
    const ox = f.offsetX / f.scale;
    for (const svg of [s.hl, s.ink]) {
      svg.setAttribute("viewBox", `${-ox} 0 ${w} ${hgt}`);
    }
  }

  // ---- drawing --------------------------------------------------------

  redraw(page: number): void {
    const s = this.slots.get(page);
    if (s) this.paint(s);
  }

  private paint(s: InkSlot): void {
    const skip = this.gesture?.page === s.index ? this.gesture.erased : null;
    let hl = "";
    let ink = "";
    for (const st of this.model.strokes(s.index)) {
      if (skip?.has(st.id)) continue;
      if (st.tool === "highlighter") hl += strokeSvg(st);
      else ink += strokeSvg(st);
    }
    (s.hl.firstChild as SVGGElement).innerHTML = hl;
    (s.ink.firstChild as SVGGElement).innerHTML = ink;
  }

  private paintLive(): void {
    this.raf = 0;
    const g = this.gesture;
    if (!g || g.mode === "erase") return;
    const s = this.slots.get(g.page);
    if (!s) return;
    let pts = g.points;
    if (g.tool === "underline" && pts.length >= 4) pts = snapHorizontal([pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]);
    const live = s.live;
    const parent = g.tool === "highlighter" ? s.hl : s.ink;
    if (live.parentNode !== parent) parent.append(live);
    live.setAttribute("d", svgPathData(pts));
    live.setAttribute("stroke", g.color);
    live.setAttribute("stroke-width", String(g.width));
    live.setAttribute("stroke-linecap", g.tool === "highlighter" ? "butt" : "round");
    live.setAttribute("stroke-opacity", g.tool === "highlighter" ? String(HIGHLIGHT_OPACITY) : "1");
  }

  private clearLive(page: number): void {
    this.slots.get(page)?.live.remove();
  }

  private scheduleLive(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paintLive());
  }

  // ---- input --------------------------------------------------------

  /** Client point -> PDF point coordinates on the page. */
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
    if (!erase && tool !== "pen") void this.textChars(page); // warm the cache while drawing
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
    if (g.mode === "erase") {
      if (g.erased.size) this.model.remove(g.page, g.erased);
      else this.redraw(g.page);
      return;
    }
    this.pending = this.pending.then(() => this.commit(g)).catch((err) => console.error(err));
  };

  /** Finishes a stroke: straightening and snapping to the page's text. */
  private async commit(g: Gesture): Promise<void> {
    let pts = simplify(g.points, 0.25);
    let rects: number[] | undefined;
    if (g.tool === "underline") {
      const seg = snapHorizontal([pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]) as [number, number, number, number];
      if (Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) < 2) {
        this.clearLive(g.page);
        return; // a tap, not a line
      }
      pts = snapUnderline(await this.textChars(g.page), seg) ?? seg;
    } else if (g.tool === "highlighter") {
      const r = highlightRects(await this.textChars(g.page), pts);
      if (r.length) rects = r.flat().map(round1);
      pts = straighten(pts, 3) ?? pts;
    }
    this.clearLive(g.page);
    const stroke: Stroke = { id: newStrokeId(), tool: g.tool, color: g.color, width: g.width, points: pts.map(round1) };
    if (rects) stroke.rects = rects;
    this.model.add(g.page, stroke);
  }

  private onCancel = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    this.clearLive(g.page);
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
    return this.gesture !== null || performance.now() - this.lastPenAt < 250;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.unsub();
    this.scroller.hooks = null;
    for (const i of [...this.slots.keys()]) this.detach(i);
  }
}
