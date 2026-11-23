import type { Stroke } from "./types";

/** Pure geometry for strokes: hit-testing, bounds, straightening. */

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True if the point is within `radius` of the stroke's drawn line. */
export function strokeHit(s: Stroke, x: number, y: number, radius: number): boolean {
  const p = s.points;
  const r = radius + s.width / 2;
  if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) <= r;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) return true;
  }
  return false;
}

/** Hit test along an eraser movement so fast swipes don't skip strokes. */
export function strokeHitSegment(
  s: Stroke,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, radius)));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (strokeHit(s, ax + (bx - ax) * t, ay + (by - ay) * t, radius)) return true;
  }
  return false;
}

/**
 * If a freehand stroke is nearly a straight line (typical when highlighting
 * a line of text), returns its two end points; otherwise null.
 */
export function straighten(points: number[], tolerance: number): number[] | null {
  if (points.length < 4) return null;
  const ax = points[0];
  const ay = points[1];
  const bx = points[points.length - 2];
  const by = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < tolerance * 4) return null;
  for (let i = 2; i + 1 < points.length - 2; i += 2) {
    if (distToSegment(points[i], points[i + 1], ax, ay, bx, by) > tolerance) return null;
  }
  return snapHorizontal([ax, ay, bx, by]);
}

/** Makes a near-horizontal line exactly horizontal (within ~6°). */
export function snapHorizontal(seg: number[]): number[] {
  const [ax, ay, bx, by] = seg;
  const angle = Math.abs(Math.atan2(by - ay, bx - ax));
  const deg = (angle * 180) / Math.PI;
  if (deg < 6 || deg > 174) {
    const y = (ay + by) / 2;
    return [ax, y, bx, y];
  }
  return seg;
}

/** Drops points closer than `minDist` to the previous kept point. */
export function simplify(points: number[], minDist: number): number[] {
  if (points.length <= 4) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    const last = i === points.length - 2;
    if (last || Math.hypot(points[i] - lx, points[i + 1] - ly) >= minDist) {
      out.push(points[i], points[i + 1]);
    }
  }
  return out;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
