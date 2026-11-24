import { icon } from "../dom";

/*
 * A game-style quick wheel: hold a finger on the page, it opens around the
 * finger; slide towards a choice and lift. No aiming at small buttons.
 */

export interface WheelItem {
  key: string;
  label: string;
  icon: string;
}

const R = 125; // outer radius
const r = 44; // hub radius

export class QuickWheel {
  readonly el: SVGSVGElement;
  private items: WheelItem[] = [];
  private at = { x: 0, y: 0 };
  private hot = -1;
  open = false;

  constructor() {
    this.el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.el.setAttribute("class", "quickwheel");
    this.el.setAttribute("viewBox", `${-R - 4} ${-R - 4} ${2 * R + 8} ${2 * R + 8}`);
    this.el.setAttribute("aria-hidden", "true");
    this.el.dataset.testid = "quick-wheel";
  }

  show(x: number, y: number, items: WheelItem[]): void {
    this.items = items;
    this.at = { x, y };
    this.hot = -1;
    // keep the whole wheel on screen
    const m = R + 8;
    const cx = Math.min(window.innerWidth - m, Math.max(m, x));
    const cy = Math.min(window.innerHeight - m, Math.max(m, y));
    this.at = { x: cx, y: cy };
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
    this.draw();
    this.open = true;
    this.el.classList.add("open");
    navigator.vibrate?.(8);
  }

  /** Finger moved: highlights the slice it points at (none near the hub). */
  move(x: number, y: number): void {
    const dx = x - this.at.x;
    const dy = y - this.at.y;
    const n = this.items.length;
    let hot = -1;
    if (Math.hypot(dx, dy) > 34) {
      const a = Math.atan2(dy, dx) + Math.PI / 2 + Math.PI / n;
      const full = Math.PI * 2;
      hot = Math.floor((((a % full) + full) % full) / (full / n));
    }
    if (hot !== this.hot) {
      this.hot = hot;
      this.draw();
      if (hot >= 0) navigator.vibrate?.(4);
    }
  }

  /** Closes; returns the chosen key (null: lifted on the hub). */
  close(): string | null {
    const k = this.hot >= 0 ? this.items[this.hot].key : null;
    this.open = false;
    this.el.classList.remove("open");
    return k;
  }

  /** Index of the slice under a direction (tests). */
  get chosen(): string | null {
    return this.hot >= 0 ? this.items[this.hot].key : null;
  }

  private draw(): void {
    const n = this.items.length;
    const p = (rad: number, a: number) => `${(rad * Math.cos(a)).toFixed(1)} ${(rad * Math.sin(a)).toFixed(1)}`;
    let s = "";
    this.items.forEach((it, i) => {
      const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 - Math.PI / n;
      const a1 = a0 + (Math.PI * 2) / n;
      s += `<path class="qw-seg ${i === this.hot ? "hot" : ""}" d="M${p(r, a0)} L${p(R, a0)} A${R} ${R} 0 0 1 ${p(R, a1)} L${p(r, a1)} A${r} ${r} 0 0 0 ${p(r, a0)}Z"/>`;
      const am = (a0 + a1) / 2;
      const cx = 86 * Math.cos(am);
      const cy = 86 * Math.sin(am);
      s += `<g transform="translate(${(cx - 11).toFixed(1)} ${(cy - 19).toFixed(1)})" class="qw-ic">${icon(it.icon, 22)}</g>`;
      s += `<text x="${cx.toFixed(1)}" y="${(cy + 20).toFixed(1)}">${it.label}</text>`;
    });
    const hub = this.hot >= 0 ? this.items[this.hot].label : "Trượt để chọn";
    s += `<circle class="qw-hub" r="${r - 6}"/><text class="qw-hub-t" y="5">${hub}</text>`;
    this.el.innerHTML = s;
  }
}
