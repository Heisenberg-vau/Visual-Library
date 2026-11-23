import { round1, simplify, snapHorizontal, straighten, strokeHitSegment } from "../../core/annotations/geometry";
import type { InkModel } from "../../core/annotations/InkModel";
import { HIGHLIGHT_OPACITY, strokeSvg, svgPathData } from "../../core/annotations/path";
import type { InkTool, PageLink, Stroke } from "../../core/annotations/types";
import { linkAt, makeLinkStroke } from "../../core/notebook/links";
import { clipAt, movedClip, type Rect } from "../../core/notebook/clips";
import { highlightRects, snapUnderline, type CharBox } from "../../core/text/textGeometry";
import { isStylus, type PageFrame, type PageScroller, type SlotHooks } from "./PageScroller";

/** "clip": cut text/pictures from a book (and move them around in a notebook). */
export type Tool = "hand" | InkTool | "eraser" | "clip";

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
  /** Pasted clips, under everything else so you can write on them. */
  clip: SVGSVGElement;
  clipKey: string;
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
  mode: "draw" | "erase" | "select" | "move";
  tool: InkTool;
  color: string;
  width: number;
  points: number[];
  erased: Set<string>;
  lastX: number;
  lastY: number;
  /** Clip being moved, and where the pen went down (page points / client px). */
  target?: Stroke;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
}

/** Optional behaviour used by notebooks. */
export interface InkLayerOptions {
  /** Called when the pen starts writing here (to know which pane is active). */
  onActivity?: () => void;
  /** If it returns a link, the next pen tap places that page-link tag. */
  linkToPlace?: () => PageLink | null;
  onLinkPlaced?: () => void;
  /** A finger tap, or a pen tap without moving, on a page-link tag. */
  onLinkTap?: (link: PageLink) => void;
  /** With the clip tool: a rectangle was drawn on a page (PDF points; client box for placing UI). */
  onSelect?: (page: number, rect: Rect, client: { left: number; top: number; right: number; bottom: number }) => void;
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
  private tap: { id: number; x: number; y: number; t: number } | null = null;
  /** Search hits to outline (page -> flat x,y,w,h rects); not saved, not exported. */
  private marks = new Map<number, number[]>();
  /** Area chosen with the clip tool (dashed box), not saved. */
  private selection: { page: number; rect: Rect } | null = null;

  constructor(
    private readonly scroller: PageScroller,
    private readonly model: InkModel,
    private readonly tools: () => ToolState,
    private readonly onHistory: () => void,
    private readonly textChars: (page: number) => Promise<CharBox[]>,
    private readonly opts: InkLayerOptions = {},
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
    const s: InkSlot = { index, el, clip: mk("ink-clips"), clipKey: "", hl: mk("ink-hl"), ink: mk("ink-pen"), live, frame };
    el.append(s.clip, s.hl, s.ink);
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
    s.clip.remove();
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
    for (const svg of [s.clip, s.hl, s.ink]) {
      svg.setAttribute("viewBox", `${-ox} 0 ${w} ${hgt}`);
    }
  }

  // ---- drawing --------------------------------------------------------

  /** Shows search hits on a page (replaces previous marks everywhere). */
  setMarks(page: number, rects: number[]): void {
    const old = [...this.marks.keys()];
    this.marks.clear();
    if (rects.length) this.marks.set(page, rects);
    for (const p of new Set([...old, page])) this.redraw(p);
  }

  /** Shows (or clears) the dashed box of the clip tool. */
  setSelection(page: number | null, rect?: Rect): void {
    const old = this.selection?.page;
    this.selection = page === null || !rect ? null : { page, rect };
    if (old !== undefined) this.redraw(old);
    if (page !== null) this.redraw(page);
  }

  /** Page and PDF point under a client position (for dropping clips). */
  pagePointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    for (const [page, s] of this.slots) {
      const r = s.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        const pt = this.toPage(page, clientX, clientY);
        return pt ? { page, ...pt } : null;
      }
    }
    return null;
  }

  redraw(page: number): void {
    const s = this.slots.get(page);
    if (s) this.paint(s);
  }

  private paint(s: InkSlot): void {
    const skip = this.gesture?.page === s.index ? this.gesture.erased : null;
    let hl = "";
    let ink = "";
    const clips: Stroke[] = [];
    for (const st of this.model.strokes(s.index)) {
      if (skip?.has(st.id)) continue;
      if (st.tool === "clip") clips.push(st);
      else if (st.tool === "highlighter") hl += strokeSvg(st);
      else ink += strokeSvg(st);
    }
    // Pictures are big: only rebuild this layer when the clips themselves change.
    const key = clips.map((c) => `${c.id}@${c.rects?.join(",")}`).join("|");
    if (key !== s.clipKey) {
      s.clipKey = key;
      (s.clip.firstChild as SVGGElement).innerHTML = clips.map(strokeSvg).join("");
    }
    const sel = this.selection?.page === s.index ? this.selection.rect : null;
    if (sel) {
      ink += `<rect class="clip-select" data-testid="clip-select" x="${sel[0]}" y="${sel[1]}" width="${sel[2]}" height="${sel[3]}" fill="rgba(31,95,191,0.06)" stroke="#1f5fbf" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`;
    }
    const m = this.marks.get(s.index);
    if (m) {
      for (let i = 0; i + 3 < m.length; i += 4) {
        ink += `<rect class="search-hit" x="${m[i] - 1.5}" y="${m[i + 1] - 1.5}" width="${m[i + 2] + 3}" height="${m[i + 3] + 3}" rx="2"/>`;
      }
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
    if (g.mode === "move") {
      const el = s.clip.querySelector(`[data-id="${CSS.escape(g.target!.id)}"]`);
      el?.setAttribute("transform", `translate(${g.lastX - g.startX} ${g.lastY - g.startY})`);
      return;
    }
    if (g.mode === "select") {
      const [x0, y0, x1, y1] = [g.startX, g.startY, g.lastX, g.lastY];
      if (s.live.parentNode !== s.ink) s.ink.append(s.live);
      s.live.setAttribute("d", `M${x0} ${y0}H${x1}V${y1}H${x0}Z`);
      s.live.setAttribute("stroke", "#1f5fbf");
      s.live.setAttribute("stroke-width", String(1 / s.frame.scale));
      s.live.setAttribute("stroke-dasharray", `${4 / s.frame.scale} ${3 / s.frame.scale}`);
      s.live.setAttribute("stroke-opacity", "1");
      return;
    }
    s.live.removeAttribute("stroke-dasharray");
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

  private slotPage(e: PointerEvent): number | null {
    const slotEl = (e.target as Element | null)?.closest?.(".page-slot") as HTMLElement | null;
    return slotEl ? Number(slotEl.dataset.page) - 1 : null;
  }

  /** Link tags react to taps (fingers, or the pen in "hand" mode). */
  private tapLink(page: number, clientX: number, clientY: number): boolean {
    if (!this.opts.onLinkTap) return false;
    const pt = this.toPage(page, clientX, clientY);
    const hit = pt ? linkAt(this.model.strokes(page), pt.x, pt.y, 3, true) : null;
    if (hit?.link) {
      this.opts.onLinkTap(hit.link);
      return true;
    }
    return false;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.writes(e)) {
      if (e.isPrimary) this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      return;
    }
    if (this.gesture) return;
    const page = this.slotPage(e);
    if (page === null) return;
    const pt = this.toPage(page, e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    this.opts.onActivity?.();
    const pendingLink = this.opts.linkToPlace?.();
    if (pendingLink) {
      this.model.add(page, makeLinkStroke(newStrokeId(), pt.x, pt.y, pendingLink));
      this.opts.onLinkPlaced?.();
      return;
    }
    const t = this.tools();
    const base = { pointerId: e.pointerId, page, points: [], erased: new Set<string>(), lastX: pt.x, lastY: pt.y, startX: pt.x, startY: pt.y, clientX: e.clientX, clientY: e.clientY, tool: "pen" as InkTool, color: "", width: 1 };
    if (t.tool === "clip" && (e.buttons & 32) === 0) {
      const target = clipAt(this.model.strokes(page), pt.x, pt.y);
      if (!target && !this.opts.onSelect) return; // nothing to do here; leave the pen alone
      this.scroller.el.setPointerCapture?.(e.pointerId);
      if (e.pointerType === "pen") this.lastPenAt = performance.now();
      this.gesture = target ? { ...base, mode: "move", target } : { ...base, mode: "select" };
      if (!target) this.setSelection(null);
      return;
    }
    this.scroller.el.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "pen") this.lastPenAt = performance.now();
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
      startX: pt.x,
      startY: pt.y,
      clientX: e.clientX,
      clientY: e.clientY,
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
      else if (g.mode === "select" || g.mode === "move") {
        g.lastX = pt.x;
        g.lastY = pt.y;
      } else g.points.push(round1(pt.x), round1(pt.y));
    }
    if (g.mode !== "erase") this.scheduleLive();
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
    const tap = this.tap;
    if (tap && tap.id === e.pointerId) {
      this.tap = null;
      const page = this.slotPage(e);
      if (page !== null && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && performance.now() - tap.t < 600) {
        this.tapLink(page, e.clientX, e.clientY);
      }
      return;
    }
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    if (g.mode === "move") {
      const dx = g.lastX - g.startX;
      const dy = g.lastY - g.startY;
      const s = this.slots.get(g.page);
      if (Math.hypot(dx, dy) > 0.5) this.model.replace(g.page, g.target!, movedClip(g.target!, dx, dy));
      else s?.clip.querySelector(`[data-id="${CSS.escape(g.target!.id)}"]`)?.removeAttribute("transform");
      return;
    }
    if (g.mode === "select") {
      this.clearLive(g.page);
      const x = Math.min(g.startX, g.lastX);
      const y = Math.min(g.startY, g.lastY);
      const w = Math.abs(g.lastX - g.startX);
      const hh = Math.abs(g.lastY - g.startY);
      if (w < 8 || hh < 6) return; // a tap
      const rect: Rect = [round1(x), round1(y), round1(w), round1(hh)];
      this.setSelection(g.page, rect);
      this.opts.onSelect?.(g.page, rect, {
        left: Math.min(g.clientX, e.clientX),
        top: Math.min(g.clientY, e.clientY),
        right: Math.max(g.clientX, e.clientX),
        bottom: Math.max(g.clientY, e.clientY),
      });
      return;
    }
    // A pen tap (no movement) on a link tag follows the link instead of leaving a dot.
    if (g.mode === "draw" && this.opts.onLinkTap) {
      const p = g.points;
      let moved = 0;
      for (let i = 2; i < p.length; i += 2) moved = Math.max(moved, Math.hypot(p[i] - p[0], p[i + 1] - p[1]));
      if (moved < 2 && linkAt(this.model.strokes(g.page), p[0], p[1], 3)) {
        this.clearLive(g.page);
        this.tapLink(g.page, e.clientX, e.clientY);
        return;
      }
    }
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
    if (g.mode === "move") this.slots.get(g.page)?.clip.querySelector(`[data-id="${CSS.escape(g.target!.id)}"]`)?.removeAttribute("transform");
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
