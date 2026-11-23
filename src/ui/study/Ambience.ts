import type { MetaStore } from "../../core/storage/MetaStore";
import { h, icon } from "../dom";
import { SoundScape, type SoundKind } from "./sound";

export type PaperTone = "white" | "sepia" | "dark";

export interface AmbienceSettings {
  dim: number; // 0..0.7, darkens the whole screen
  warm: number; // 0..0.7, night-light amber
  tone: PaperTone; // page colour (screen only, never exported)
  sound: SoundKind;
  volume: number; // 0..1
}

const DEFAULTS: AmbienceSettings = { dim: 0, warm: 0, tone: "white", sound: "off", volume: 0.4 };

/** Screen light and background sound. Screen-only: exports are unaffected. */
export class Ambience {
  settings: AmbienceSettings = { ...DEFAULTS };
  readonly sound = new SoundScape();
  private dimEl = h("div", { class: "amb-dim", "aria-hidden": "true" });
  private warmEl = h("div", { class: "amb-warm", "aria-hidden": "true" });

  constructor(private readonly meta: MetaStore) {
    document.body.append(this.warmEl, this.dimEl);
  }

  async init(): Promise<void> {
    const saved = await this.meta.getSetting<Partial<AmbienceSettings>>("ambience", {});
    // Sound never auto-plays on launch (browsers block it, and it would surprise).
    this.settings = { ...DEFAULTS, ...saved, sound: "off" };
    this.apply();
  }

  set(patch: Partial<AmbienceSettings>): void {
    const soundChanged = patch.sound !== undefined && patch.sound !== this.settings.sound;
    this.settings = { ...this.settings, ...patch };
    this.apply();
    if (soundChanged) this.sound.play(this.settings.sound);
    if (patch.volume !== undefined) this.sound.setVolume(this.settings.volume);
    void this.meta.setSetting("ambience", this.settings);
  }

  private apply(): void {
    const s = this.settings;
    this.dimEl.style.opacity = String(s.dim);
    this.warmEl.style.opacity = String(s.warm);
    document.body.dataset.tone = s.tone;
    this.sound.setVolume(s.volume);
  }

  /** Popover with sliders and choices. */
  open(anchor: HTMLElement): void {
    const backdrop = h("div", { class: "menu-backdrop" });
    const close = () => backdrop.remove();
    const s = this.settings;
    const slider = (label: string, key: "dim" | "warm" | "volume", max: number) => {
      const input = h("input", { type: "range", min: "0", max: String(max), step: "0.05", value: String(s[key]), "data-testid": `amb-${key}` });
      input.addEventListener("input", () => this.set({ [key]: Number(input.value) }));
      return h("label", { class: "amb-row" }, h("span", {}, label), input);
    };
    const seg = <K extends "tone" | "sound">(key: K, options: [AmbienceSettings[K], string][]) => {
      const wrap = h("div", { class: "seg", "data-testid": `amb-${key}` });
      const render = () =>
        wrap.replaceChildren(
          ...options.map(([v, label]) =>
            h(
              "button",
              {
                class: `seg-btn ${this.settings[key] === v ? "active" : ""}`,
                type: "button",
                "data-value": String(v),
                onclick: () => {
                  this.set({ [key]: v } as Partial<AmbienceSettings>);
                  render();
                },
              },
              label,
            ),
          ),
        );
      render();
      return wrap;
    };
    const panel = h(
      "div",
      { class: "palette amb-panel", "data-testid": "ambience-panel" },
      h("h4", {}, "Màu trang (chỉ trên màn hình)"),
      seg("tone", [
        ["white", "Trắng"],
        ["sepia", "Ngà"],
        ["dark", "Tối"],
      ]),
      h("h4", {}, "Ánh sáng"),
      slider("Giảm sáng", "dim", 0.7),
      slider("Lọc ánh sáng ấm", "warm", 0.7),
      h("h4", {}, "Âm thanh thư giãn"),
      seg("sound", [
        ["off", "Tắt"],
        ["rain", "Mưa"],
        ["brown", "Ồn nâu"],
        ["white", "Ồn trắng"],
      ]),
      slider("Âm lượng", "volume", 1),
      h("p", { class: "muted small" }, "Ồn nâu/trắng giúp át tiếng ồn xung quanh. Âm thanh được tạo ngay trên máy, dùng offline."),
    );
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.append(panel);
    document.body.append(backdrop);
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + 6 + panel.offsetHeight > window.innerHeight ? Math.max(8, r.top - panel.offsetHeight - 6) : r.bottom + 6;
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.left - 120))}px`;
  }

  button(): HTMLButtonElement {
    const b = h("button", { class: "icon-btn", type: "button", title: "Ánh sáng và âm thanh", "aria-label": "Ánh sáng và âm thanh", "data-testid": "ambience-btn", html: icon("sun") });
    b.addEventListener("click", () => this.open(b));
    return b;
  }
}
