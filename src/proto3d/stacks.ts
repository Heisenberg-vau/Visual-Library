import * as THREE from "three";
import type { SpineStyle } from "./textures";

/*
 * Books on a stack, drawn cheaply: every spine of a stack is painted into one
 * atlas texture, and all its books are merged into one geometry, so a whole
 * bookcase costs one draw call instead of hundreds. Each book keeps its
 * vertex range so it can be hidden (pulled out) and restored, and a ray hit
 * maps back to the book through its triangle index.
 */

export interface ShelfBook {
  id: string;
  title: string;
  author: string;
  color: string;
  cloth: boolean;
  /** Size in metres: depth (cover width), height, thickness. */
  d: number;
  h: number;
  t: number;
  /** Centre in the stack's local space. */
  pos: THREE.Vector3;
}

const ATLAS = 2048;
const CW = 80; // cell width (spine thickness direction)
const CH = 448; // cell height (spine height)
const COLS = Math.floor(ATLAS / CW);
const ROWS = Math.floor((ATLAS - 160) / CH);
export const CELLS_PER_ATLAS = COLS * ROWS;
const STRIP_Y = ROWS * CH + 8; // pages texture + a white patch live below the cells

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Paints one spine into a cell (the same art as the single-book texture). */
export function paintSpine(ctx: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number, title: string, color: string, seed: number, style: SpineStyle, cloth: boolean): void {
  const r = rng(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, W, H);
  ctx.clip();
  ctx.translate(x0, y0);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(${r() > 0.5 ? "255,240,220" : "0,0,0"},${r() * (cloth ? 0.05 : 0.07)})`;
    const s = 1.5 + r() * (cloth ? 1.5 : 7);
    ctx.fillRect(r() * W, r() * H, s, s);
  }
  if (cloth) {
    for (let y = 0; y < H; y += 3) {
      ctx.fillStyle = "rgba(0,0,0,0.05)";
      ctx.fillRect(0, y, W, 1);
    }
  }
  const edge = ctx.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, "rgba(0,0,0,0.45)");
  edge.addColorStop(0.22, "rgba(0,0,0,0)");
  edge.addColorStop(0.55, "rgba(255,245,220,0.10)");
  edge.addColorStop(0.8, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);
  const k = H / 640;
  const gold = (y: number, h: number) => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#7a5a22");
    g.addColorStop(0.5, "#f0d28a");
    g.addColorStop(1, "#7a5a22");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, h);
  };
  if (!cloth) {
    for (const y of [40, 58, 640 - 70, 640 - 52]) gold(y * k, 5 * k);
    for (const y of [130, 150]) gold(y * k, 4 * k);
  } else {
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, H * 0.62, W, 14 * k);
  }
  ctx.translate(W / 2, H / 2 + 40 * k);
  ctx.rotate(style === "up" ? -Math.PI / 2 : Math.PI / 2);
  let size = Math.min(46 * k, W * 0.5);
  const font = (s: number) => `700 ${s}px "Cormorant Garamond", Georgia, serif`;
  ctx.font = font(size);
  while (ctx.measureText(title).width > H - 260 * k && size > 14) {
    size -= 1;
    ctx.font = font(size);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillText(title, 1, 1.5);
  if (cloth) ctx.fillStyle = "#f3ead2";
  else {
    const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    g.addColorStop(0, "#f6e2a8");
    g.addColorStop(1, "#c79a45");
    ctx.fillStyle = g;
  }
  ctx.fillText(title, 0, 0);
  ctx.restore();
}

function paintStrip(ctx: CanvasRenderingContext2D): void {
  // page edges
  ctx.fillStyle = "#efe4c8";
  ctx.fillRect(0, STRIP_Y, 256, 128);
  for (let x = 0; x < 256; x += 2) {
    ctx.fillStyle = `rgba(120,95,60,${0.05 + ((x * 7) % 5) * 0.02})`;
    ctx.fillRect(x, STRIP_Y, 1, 128);
  }
  // white patch (multiplied by the vertex colour for plain covers)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(300, STRIP_Y, 64, 64);
}

const PAGES_UV = [8 / ATLAS, 1 - (STRIP_Y + 120) / ATLAS, 248 / ATLAS, 1 - (STRIP_Y + 8) / ATLAS];
const WHITE_UV = [316 / ATLAS, 1 - (STRIP_Y + 48) / ATLAS, 348 / ATLAS, 1 - (STRIP_Y + 16) / ATLAS];

/** A merged mesh for up to CELLS_PER_ATLAS books facing one side (spines toward -x). */
export class StackChunk {
  readonly mesh: THREE.Mesh;
  readonly books: ShelfBook[];
  private positions: Float32Array;
  private original: Float32Array;
  private static readonly V = 16; // 4 faces × 4 vertices
  static readonly T = 8; // triangles per book

  constructor(books: ShelfBook[], style: SpineStyle, renderer: THREE.WebGLRenderer) {
    this.books = books;
    const c = document.createElement("canvas");
    c.width = c.height = ATLAS;
    const ctx = c.getContext("2d")!;
    paintStrip(ctx);
    books.forEach((b, i) => {
      const cx = (i % COLS) * CW;
      const cy = Math.floor(i / COLS) * CH;
      paintSpine(ctx, cx + 2, cy + 2, CW - 4, CH - 4, b.title, b.color, hash(b.id), style, b.cloth);
    });
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;

    const n = books.length;
    const pos = new Float32Array(n * StackChunk.V * 3);
    const nor = new Float32Array(n * StackChunk.V * 3);
    const uv = new Float32Array(n * StackChunk.V * 2);
    const col = new Float32Array(n * StackChunk.V * 3);
    const idx = new Uint32Array(n * StackChunk.T * 3);
    const tmp = new THREE.Color();
    books.forEach((b, i) => {
      const v0 = i * StackChunk.V;
      let v = v0;
      const { d, h, t } = b;
      const [x, y, z] = [b.pos.x, b.pos.y, b.pos.z];
      const x0 = x - d / 2;
      const x1 = x + d / 2;
      const y0 = y - h / 2;
      const y1 = y + h / 2;
      const z0 = z - t / 2;
      const z1 = z + t / 2;
      const face = (p: number[][], n3: number[], u: number[][], c: THREE.Color) => {
        for (let k = 0; k < 4; k++) {
          pos.set(p[k], v * 3);
          nor.set(n3, v * 3);
          uv.set(u[k], v * 2);
          col.set([c.r, c.g, c.b], v * 3);
          v++;
        }
      };
      // spine at -x, seen from the left: screen-right is +z, up is +y
      const cx = (i % COLS) * CW;
      const cy = Math.floor(i / COLS) * CH;
      const u0 = (cx + 3) / ATLAS;
      const u1 = (cx + CW - 3) / ATLAS;
      const vTop = 1 - (cy + 3) / ATLAS;
      const vBot = 1 - (cy + CH - 3) / ATLAS;
      const white = tmp.set("#ffffff");
      face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[u0, vBot], [u1, vBot], [u1, vTop], [u0, vTop]], white);
      // top: page edges
      const [pu0, pv0, pu1, pv1] = PAGES_UV;
      face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], [[pu0, pv0], [pu0, pv1], [pu1, pv1], [pu1, pv0]], white);
      // covers (front/back), plain colour
      const cc = new THREE.Color(b.color).multiplyScalar(0.85);
      const [wu0, wv0, wu1, wv1] = WHITE_UV;
      const wuv = [[wu0, wv0], [wu1, wv0], [wu1, wv1], [wu0, wv1]];
      face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], wuv, cc);
      face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], wuv, cc);
      for (let f = 0; f < 4; f++) {
        const a = v0 + f * 4;
        idx.set([a, a + 1, a + 2, a, a + 2, a + 3], (i * 4 + f) * 6);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.positions = pos;
    this.original = pos.slice();
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.55 }));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.chunk = this;
  }

  bookAtFace(faceIndex: number): ShelfBook | null {
    return this.books[Math.floor(faceIndex / 4 / 2)] ?? null;
  }

  /** Hide (pulled out / on the desk) or show a book in place. */
  setVisible(book: ShelfBook, visible: boolean): void {
    const i = this.books.indexOf(book);
    if (i < 0) return;
    const a = i * StackChunk.V * 3;
    const b = a + StackChunk.V * 3;
    if (visible) this.positions.set(this.original.subarray(a, b), a);
    else {
      // collapse the book into a point far below the floor
      for (let k = a; k < b; k += 3) {
        this.positions[k] = 0;
        this.positions[k + 1] = -100;
        this.positions[k + 2] = 0;
      }
    }
    const attr = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
