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
export function strokeSvg(s: Stroke): string {
  const esc = s.color.replace(/[^#0-9a-zA-Z(),.%\s]/g, "");
  if (s.tool === "highlighter") {
    if (s.rects?.length) return `<path d="${svgRectsData(s.rects)}" fill="${esc}" fill-opacity="${HIGHLIGHT_OPACITY}"/>`;
    return `<path d="${svgPathData(s.points)}" fill="none" stroke="${esc}" stroke-opacity="${HIGHLIGHT_OPACITY}" stroke-width="${s.width}" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }
  return `<path d="${svgPathData(s.points)}" fill="none" stroke="${esc}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
