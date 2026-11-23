import { LINK_FONT } from "../notebook/links";
import { CLIP_BAR, CLIP_BAR_COLOR, CLIP_FONT, CLIP_FONT_FAMILY, CLIP_LINE, CLIP_PAD } from "../notebook/clips";

/** Arrow icon of a link tag, relative to the tag box. */
export function linkArrow(x: number, y: number, h: number): number[] {
  const cy = y + h / 2;
  return [x + 8, cy + 3.5, x + 14, cy - 3.5, x + 10, cy - 3.5, x + 14, cy - 3.5, x + 14, cy + 0.5];
}
import type { Stroke } from "./types";

/**
 * Stroke outline as drawing commands, shared by the screen (SVG) and the
 * PDF export, so what you see is exactly what gets exported.
 */
export type PathCmd = ["M", number, number] | ["L", number, number] | ["Q", number, number, number, number];

/** Smooth polyline through midpoints (quadratic curves). */
export function strokeCommands(points: number[]): PathCmd[] {
  const p = points;
  if (p.length < 2) return [];
  const cmds: PathCmd[] = [["M", p[0], p[1]]];
  if (p.length === 2) {
    cmds.push(["L", p[0] + 0.01, p[1]]); // a dot, drawn with a round cap
    return cmds;
  }
  if (p.length === 4) {
    cmds.push(["L", p[2], p[3]]);
    return cmds;
  }
  for (let i = 2; i < p.length - 2; i += 2) {
    cmds.push(["Q", p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2]);
  }
  cmds.push(["L", p[p.length - 2], p[p.length - 1]]);
  return cmds;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function svgPathData(points: number[]): string {
  return strokeCommands(points)
    .map((c) => c[0] + c.slice(1).map((n) => f(n as number)).join(" "))
    .join("");
}

export function svgRectsData(rects: number[]): string {
  let d = "";
  for (let i = 0; i + 3 < rects.length; i += 4) {
    d += `M${f(rects[i])} ${f(rects[i + 1])}h${f(rects[i + 2])}v${f(rects[i + 3])}h${f(-rects[i + 2])}Z`;
  }
  return d;
}

export const HIGHLIGHT_OPACITY = 0.38;

/** SVG markup of one stroke (coordinates in PDF points). */
const xmlEscape = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function strokeSvg(s: Stroke): string {
  const esc = s.color.replace(/[^#0-9a-zA-Z(),.%\s]/g, "");
  if (s.tool === "clip") return clipSvg(s, esc);
  if (s.tool === "link" && s.rects && s.link) {
    const [x, y, w, h] = s.rects;
    return (
      `<g class="ink-link" data-id="${xmlEscape(s.id)}">` +
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" fill="#e8f0fb" stroke="${esc}" stroke-width="0.8"/>` +
      `<path d="${(() => {
        const a = linkArrow(x, y, h);
        return `M${f(a[0])} ${f(a[1])}L${f(a[2])} ${f(a[3])}M${f(a[4])} ${f(a[5])}L${f(a[6])} ${f(a[7])}L${f(a[8])} ${f(a[9])}`;
      })()}" fill="none" stroke="${esc}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<text x="${f(x + 18)}" y="${f(y + h / 2 + LINK_FONT * 0.35)}" font-size="${LINK_FONT}" font-family="system-ui, sans-serif" fill="${esc}">${xmlEscape(s.link.label)}</text></g>`
    );
  }
  if (s.tool === "highlighter") {
    if (s.rects?.length) return `<path d="${svgRectsData(s.rects)}" fill="${esc}" fill-opacity="${HIGHLIGHT_OPACITY}"/>`;
    return `<path d="${svgPathData(s.points)}" fill="none" stroke="${esc}" stroke-opacity="${HIGHLIGHT_OPACITY}" stroke-width="${s.width}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }
  return `<path d="${svgPathData(s.points)}" fill="none" stroke="${esc}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** A pasted clip: a picture, or text with a thin quote bar on its left. */
function clipSvg(s: Stroke, color: string): string {
  if (!s.rects || !s.clip) return "";
  const [x, y, w, h] = s.rects;
  const id = xmlEscape(s.id);
  if (s.clip.kind === "image" && s.clip.src && /^data:image\/(png|jpeg);base64,/.test(s.clip.src)) {
    return `<g class="ink-clip" data-id="${id}"><image href="${s.clip.src}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" preserveAspectRatio="none"/></g>`;
  }
  const fs = s.clip.fontSize ?? CLIP_FONT;
  const lines = s.clip.lines ?? [];
  let t = "";
  lines.forEach((line, i) => {
    t += `<tspan x="${f(x + CLIP_PAD)}" y="${f(y + fs * (0.95 + i * CLIP_LINE))}">${xmlEscape(line)}</tspan>`;
  });
  return (
    `<g class="ink-clip" data-id="${id}">` +
    `<rect x="${f(x)}" y="${f(y)}" width="${f(CLIP_BAR)}" height="${f(h)}" fill="${CLIP_BAR_COLOR}"/>` +
    `<text font-size="${f(fs)}" font-family="${CLIP_FONT_FAMILY.replace(/"/g, "'")}" fill="${color}" xml:space="preserve">${t}</text>` +
    `<rect class="clip-box" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="transparent"/></g>`
  );
}
