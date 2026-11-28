import * as THREE from "three";
import { paintFrost } from "./stacks";

/**
 * Procedural materials (no downloads needed): wood grain, floor planks,
 * cork, plaster, leather spines with gilt bands, covers, notes.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function tex(c: HTMLCanvasElement, repeat = [1, 1]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/** Grain running along the canvas width. */
function drawGrain(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, seed: number, strength = 1): void {
  const r = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  // broad tonal streaks
  for (let i = 0; i < 26; i++) {
    const y = r() * h;
    const g = ctx.createLinearGradient(0, y - 30, 0, y + 30);
    const k = 0.82 + r() * 0.3;
    g.addColorStop(0, "transparent");
    g.addColorStop(0.5, shade(base, k) + "55");
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 30, w, 60);
  }
  // fine grain lines
  for (let i = 0; i < 260 * strength; i++) {
    const y0 = r() * h;
    const amp = 2 + r() * 7;
    const f = 0.002 + r() * 0.01;
    const ph = r() * 6.28;
    ctx.strokeStyle = `rgba(30,16,6,${0.05 + r() * 0.14})`;
    ctx.lineWidth = 0.6 + r() * 1.4;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = y0 + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1) * amp * 0.25;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // knots
  for (let i = 0; i < 3; i++) {
    const x = r() * w;
    const y = r() * h;
    for (let k = 0; k < 6; k++) {
      ctx.strokeStyle = `rgba(30,16,6,${0.12 - k * 0.015})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 10 + k * 7, 4 + k * 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

export function woodTexture(base: string, seed: number, repeat = [1, 1]): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 512);
  drawGrain(ctx, 1024, 512, base, seed);
  return tex(c, repeat);
}

export function floorTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(2048, 2048);
  const r = rng(77);
  const plankH = 2048 / 10;
  for (let row = 0; row < 10; row++) {
    let x = -r() * 600;
    while (x < 2048) {
      const len = 500 + r() * 700;
      const base = ["#6f4a2c", "#78502f", "#694428", "#7d5634", "#5f3e24"][Math.floor(r() * 5)];
      const [pc, pctx] = canvas(Math.ceil(len), Math.ceil(plankH));
      drawGrain(pctx, pc.width, pc.height, base, Math.floor(r() * 9999), 0.35);
      ctx.drawImage(pc, x, row * plankH);
      ctx.fillStyle = "rgba(20,10,4,0.55)";
      ctx.fillRect(x, row * plankH, 3, plankH);
      x += len;
    }
    ctx.fillStyle = "rgba(20,10,4,0.6)";
    ctx.fillRect(0, row * plankH, 2048, 3);
  }
  return tex(c, [3, 3]);
}

export function plasterTexture(base = "#d9c9a8"): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  const r = rng(5);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = `rgba(${r() > 0.5 ? "255,250,235" : "90,70,40"},${r() * 0.06})`;
    const s = 1 + r() * 6;
    ctx.fillRect(r() * 512, r() * 512, s, s);
  }
  return tex(c, [6, 3]);
}

export function corkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  const r = rng(11);
  ctx.fillStyle = "#b5865a";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 14000; i++) {
    const v = r();
    ctx.fillStyle = v < 0.5 ? `rgba(90,55,25,${0.25 + r() * 0.3})` : `rgba(235,200,150,${0.15 + r() * 0.25})`;
    const s = 1 + r() * 3.5;
    ctx.beginPath();
    ctx.ellipse(r() * 512, r() * 512, s, s * (0.5 + r() * 0.5), r() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return tex(c, [2, 2]);
}

export type SpineStyle = "up" | "down";

/** Leather (or cloth) spine with gilt bands and the title along it. */
export function spineTexture(title: string, color: string, seed: number, style: SpineStyle, cloth = false, frost = false): THREE.CanvasTexture {
  const W = 128;
  const H = 640;
  const [c, ctx] = canvas(W, H);
  const r = rng(seed);
  // leather: base + mottling + darker edges (rounded spine)
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${r() > 0.5 ? "255,240,220" : "0,0,0"},${r() * (cloth ? 0.05 : 0.07)})`;
    const s = 2 + r() * (cloth ? 2 : 10);
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
  const gold = (y: number, h: number) => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#7a5a22");
    g.addColorStop(0.5, "#f0d28a");
    g.addColorStop(1, "#7a5a22");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, h);
  };
  if (!cloth) {
    // raised bands
    for (const y of [40, 58, H - 70, H - 52]) gold(y, 5);
    for (const y of [130, 150]) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(0, y + 6, W, 3);
      gold(y, 4);
    }
  } else {
    // elastic band of a notebook
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, H * 0.62, W, 16);
  }
  // title along the spine, gilt lettering
  ctx.save();
  ctx.translate(W / 2, H / 2 + 40);
  ctx.rotate(style === "up" ? -Math.PI / 2 : Math.PI / 2);
  let size = 46;
  ctx.font = `700 ${size}px "Cormorant Garamond", Georgia, serif`;
  while (ctx.measureText(title).width > H - 260 && size > 24) {
    size -= 2;
    ctx.font = `700 ${size}px "Cormorant Garamond", Georgia, serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillText(title, 1.5, 2);
  const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  g.addColorStop(0, "#f6e2a8");
  g.addColorStop(1, "#c79a45");
  ctx.fillStyle = cloth ? "#f3ead2" : g;
  ctx.fillText(title, 0, 0);
  ctx.restore();
  if (frost) paintFrost(ctx, W, H, r);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function coverTexture(title: string, author: string, color: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 720);
  const r = rng(title.length * 31);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 512, 720);
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = `rgba(${r() > 0.5 ? "255,240,220" : "0,0,0"},${r() * 0.06})`;
    const s = 2 + r() * 12;
    ctx.fillRect(r() * 512, r() * 720, s, s);
  }
  ctx.strokeStyle = "#d9b56b";
  ctx.lineWidth = 4;
  ctx.strokeRect(34, 34, 444, 652);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(46, 46, 420, 628);
  ctx.fillStyle = "#f1dca0";
  ctx.textAlign = "center";
  ctx.font = `700 58px "Cormorant Garamond", Georgia, serif`;
  const words = title.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > 380 && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, 256, 220 + i * 66));
  ctx.font = `italic 400 30px "EB Garamond", Georgia, serif`;
  ctx.fillText(author, 256, 600);
  ctx.font = "34px serif";
  ctx.fillText("❦", 256, 220 + lines.length * 66 + 30);
  return tex(c);
}

export function pagesTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 256);
  ctx.fillStyle = "#efe4c8";
  ctx.fillRect(0, 0, 64, 256);
  for (let x = 0; x < 64; x += 2) {
    ctx.fillStyle = `rgba(120,95,60,${0.05 + ((x * 7) % 5) * 0.02})`;
    ctx.fillRect(x, 0, 1, 256);
  }
  return tex(c);
}

/** Brass plaque with an engraved name. */
export function plaqueTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 160);
  const g = ctx.createLinearGradient(0, 0, 0, 160);
  g.addColorStop(0, "#e8c97f");
  g.addColorStop(0.5, "#b8903f");
  g.addColorStop(1, "#8a6a2e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = "#5a4218";
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 492, 140);
  // shrink long names to fit the plate
  let size = 64;
  ctx.font = `700 ${size}px "Cormorant Garamond", Georgia, serif`;
  while (ctx.measureText(text).width > 460 && size > 26) {
    size -= 2;
    ctx.font = `700 ${size}px "Cormorant Garamond", Georgia, serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,240,200,0.6)";
  ctx.fillText(text, 257, 84);
  ctx.fillStyle = "#3a2810";
  ctx.fillText(text, 256, 82);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** A pinned note: paper with a few handwritten-ish lines. */
export function noteTexture(title: string, lines: string[], paper = "#fbf5e2"): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 400);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 512, 400);
  ctx.fillStyle = "#2a1f16";
  ctx.font = `700 44px "Cormorant Garamond", Georgia, serif`;
  ctx.fillText(title, 28, 64);
  ctx.font = `400 30px "EB Garamond", Georgia, serif`;
  lines.forEach((l, i) => ctx.fillText(l, 28, 120 + i * 46));
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Fine grey dust for books left on the desk (used with transparency). */
export function dustTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  const r = rng(99);
  ctx.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const g = 190 + Math.floor(r() * 50);
    ctx.fillStyle = `rgba(${g},${g - 6},${g - 16},${0.15 + r() * 0.45})`;
    const s = 0.6 + r() * 1.8;
    ctx.fillRect(r() * 256, r() * 256, s, s);
  }
  // a few wipes and smudges
  for (let i = 0; i < 6; i++) {
    const gr = ctx.createRadialGradient(r() * 256, r() * 256, 4, r() * 256, r() * 256, 60 + r() * 60);
    gr.addColorStop(0, "rgba(210,200,180,0.25)");
    gr.addColorStop(1, "rgba(210,200,180,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 256, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The paper slip left in the gap of a book taken to the desk. */
export function slipTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(96, 384);
  ctx.fillStyle = "#f3ead2";
  ctx.fillRect(0, 0, 96, 384);
  ctx.strokeStyle = "#b8903f";
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 84, 372);
  ctx.save();
  ctx.translate(48, 192);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#3b2719";
  ctx.font = `700 34px "Cormorant Garamond", Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface NoteLine {
  text: string;
  done?: boolean;
  /** Drawn in red (close deadlines, overdue). */
  urgent?: boolean;
  /** Right-aligned extra, e.g. "còn 3 ngày". */
  right?: string;
  /** Checkbox in front (tasks). */
  box?: boolean;
}

/** A pinned note with real content (pinboard). */
export function boardNoteTexture(title: string, lines: NoteLine[], paper: string, more = 0): THREE.CanvasTexture {
  const [c, ctx] = canvas(560, 440);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 560, 440);
  // faint ruled lines
  ctx.strokeStyle = "rgba(120,140,170,0.18)";
  for (let y = 108; y < 430; y += 46) {
    ctx.beginPath();
    ctx.moveTo(20, y + 12);
    ctx.lineTo(540, y + 12);
    ctx.stroke();
  }
  ctx.fillStyle = "#2a1f16";
  ctx.font = `700 46px "Cormorant Garamond", Georgia, serif`;
  ctx.fillText(title, 26, 66);
  ctx.font = `400 30px "EB Garamond", Georgia, serif`;
  const fit = (t: string, w: number) => {
    if (ctx.measureText(t).width <= w) return t;
    while (t.length > 1 && ctx.measureText(t + "…").width > w) t = t.slice(0, -1);
    return t + "…";
  };
  lines.slice(0, 6).forEach((l, i) => {
    const y = 116 + i * 46;
    let x = 26;
    ctx.fillStyle = l.urgent ? "#8c2b22" : l.done ? "#8a7a62" : "#2a1f16";
    if (l.box) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y - 20, 20, 20);
      if (l.done) {
        ctx.beginPath();
        ctx.moveTo(x + 3, y - 10);
        ctx.lineTo(x + 9, y - 3);
        ctx.lineTo(x + 19, y - 19);
        ctx.stroke();
      }
      x += 32;
    }
    const rightW = l.right ? ctx.measureText(l.right).width + 16 : 0;
    const text = fit(l.text, 534 - x - rightW);
    ctx.fillText(text, x, y);
    if (l.done) {
      ctx.fillRect(x, y - 10, ctx.measureText(text).width, 2);
    }
    if (l.right) {
      ctx.textAlign = "right";
      ctx.font = `${l.urgent ? 600 : 400} 28px "EB Garamond", Georgia, serif`;
      ctx.fillText(l.right, 534, y);
      ctx.textAlign = "left";
      ctx.font = `400 30px "EB Garamond", Georgia, serif`;
    }
  });
  if (!lines.length) {
    ctx.fillStyle = "#8a7a62";
    ctx.font = `italic 400 28px "EB Garamond", Georgia, serif`;
    ctx.fillText("Chưa có gì · chạm để ghim", 26, 130);
  }
  if (more > 0) {
    ctx.fillStyle = "#6b5843";
    ctx.font = `italic 400 26px "EB Garamond", Georgia, serif`;
    ctx.fillText(`+ ${more} mục nữa`, 26, 420);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
