import type { PageLink } from "../../core/annotations/types";
import { h, icon } from "../dom";
import { toast } from "../feedback";

export type ClipPayload =
  | { kind: "image"; src: string; w: number; h: number; link: PageLink }
  | { kind: "text"; text: string; w: number; link: PageLink };

export interface ClipCardDeps {
  /** Where the selection is on screen (to put the card beside it). */
  near: { left: number; top: number; right: number; bottom: number };
  link: PageLink;
  /** Size of the selection in PDF points. */
  size: { w: number; h: number };
  image: () => Promise<string>;
  text: () => Promise<string>;
  hasNotebook: () => boolean;
  openNotebook: () => void;
  /** Drops the clip at a client point; false if that is not on the notebook. */
  drop: (clientX: number, clientY: number, payload: ClipPayload) => boolean;
  onClose: () => void;
}

/**
 * The small card that appears after framing part of a page with the clip
 * tool. Pick "Hình" or "Chữ", then drag the card onto the notebook.
 */
export class ClipCard {
  readonly el: HTMLElement;
  private mode: "image" | "text" = "image";
  private src = "";
  private text = "";
  private preview: HTMLElement;
  private seg: HTMLElement;
  private copyBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private drag: { id: number; dx: number; dy: number; x0: number; y0: number } | null = null;

  constructor(private readonly deps: ClipCardDeps) {
    this.preview = h("div", { class: "clip-preview", "data-testid": "clip-drag", title: "Kéo sang vở" }, h("span", { class: "muted small" }, "Đang cắt…"));
    const segBtn = (m: "image" | "text", label: string) => {
      const b = h("button", { class: "seg-btn", type: "button", "data-mode": m, "data-testid": `clip-mode-${m}` }, label);
      b.addEventListener("click", () => this.setMode(m));
      return b;
    };
    this.seg = h("div", { class: "seg" }, segBtn("image", "Hình"), segBtn("text", "Chữ"));
    this.copyBtn = h("button", { class: "btn btn-ghost small", type: "button", "data-testid": "clip-copy" }, "Chép chữ");
    this.copyBtn.addEventListener("click", () => void this.copy());
    this.hint = h("div", { class: "clip-hint" });
    const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Đóng", html: icon("close", 18) });
    close.addEventListener("click", () => this.close());
    this.el = h(
      "div",
      { class: "clip-card", "data-testid": "clip-card", role: "dialog", "aria-label": "Cắt sang vở" },
      h("div", { class: "clip-head" }, h("span", { html: icon("scissors", 16) }), h("strong", {}, "Cắt sang vở"), h("span", { class: "grow" }), close),
      this.preview,
      h("div", { class: "clip-row" }, this.seg, this.copyBtn),
      this.hint,
    );
    this.preview.addEventListener("pointerdown", this.onDown);
    this.preview.addEventListener("pointermove", this.onMove);
    this.preview.addEventListener("pointerup", this.onUp);
    this.preview.addEventListener("pointercancel", () => this.snapBack());
    document.body.append(this.el);
    this.position();
    this.renderHint();
    void this.load();
  }

  private async load(): Promise<void> {
    const [src, text] = await Promise.all([this.deps.image().catch(() => ""), this.deps.text().catch(() => "")]);
    if (!this.el.isConnected) return;
    this.src = src;
    this.text = text;
    // Text by default when there is real text to take.
    this.setMode(text.split(/\s+/).filter(Boolean).length >= 3 ? "text" : "image");
    this.el.dataset.ready = "1";
  }

  private setMode(m: "image" | "text"): void {
    if (m === "text" && !this.text) {
      toast("Vùng này không có chữ đọc được (trang ảnh chưa quét OCR xong?). Dùng dạng hình nhé.");
      m = "image";
    }
    this.mode = m;
    for (const b of this.seg.querySelectorAll<HTMLElement>(".seg-btn")) b.classList.toggle("active", b.dataset.mode === m);
    this.copyBtn.hidden = !this.text;
    if (m === "image" && this.src) this.preview.replaceChildren(h("img", { src: this.src, alt: "", draggable: "false" }));
    else this.preview.replaceChildren(h("p", { class: "clip-text" }, this.text));
  }

  private renderHint(): void {
    if (this.deps.hasNotebook()) {
      this.hint.replaceChildren("Kéo thẻ này sang trang vở để dán.");
    } else {
      const b = h("button", { class: "btn btn-primary small", type: "button", "data-testid": "clip-open-nb" }, "Mở vở để dán");
      b.addEventListener("click", () => this.deps.openNotebook());
      this.hint.replaceChildren(b);
    }
  }

  /** Called when a notebook opens or closes beside the book. */
  refresh(): void {
    this.renderHint();
  }

  private position(): void {
    const n = this.deps.near;
    const w = 300;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = n.right + 12;
    if (left + w > vw - 8) left = Math.max(8, n.left - w - 12);
    if (left < 8) left = Math.min(vw - w - 8, Math.max(8, n.left));
    const top = Math.max(64, Math.min(n.top, vh - 340));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private payload(): ClipPayload | null {
    const { link, size } = this.deps;
    if (this.mode === "text" && this.text) return { kind: "text", text: this.text, w: size.w, link };
    if (this.src) return { kind: "image", src: this.src, w: size.w, h: size.h, link };
    return null;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.preview.setPointerCapture?.(e.pointerId);
    this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: r.left, y0: r.top };
    this.el.classList.add("dragging");
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    e.preventDefault();
    this.el.style.left = `${e.clientX - d.dx}px`;
    this.el.style.top = `${e.clientY - d.dy}px`;
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.el.classList.remove("dragging");
    const p = this.payload();
    const moved = Math.hypot(e.clientX - d.dx - d.x0, e.clientY - d.dy - d.y0) > 12;
    if (!moved) return;
    // Hide the card so the drop point hits the notebook under it.
    this.el.style.visibility = "hidden";
    const ok = p ? this.deps.drop(e.clientX, e.clientY, p) : false;
    this.el.style.visibility = "";
    if (ok) {
      toast(this.mode === "text" ? "Đã dán chữ vào vở." : "Đã dán hình vào vở.");
      this.close();
    } else {
      if (!this.deps.hasNotebook()) toast("Mở vở bên cạnh sách rồi kéo thẻ vào trang vở.");
      this.snapBack(d);
    }
  };

  private snapBack(d = this.drag): void {
    this.drag = null;
    this.el.classList.remove("dragging");
    if (d) {
      this.el.style.left = `${d.x0}px`;
      this.el.style.top = `${d.y0}px`;
    }
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
      toast("Đã chép chữ.");
    } catch {
      toast("Trình duyệt không cho chép tự động.", "error");
    }
  }

  close(): void {
    if (!this.el.isConnected) return;
    this.el.remove();
    this.deps.onClose();
  }
}
