import * as THREE from "three";

/*
 * Decor for the walls and corners of the library: oil paintings in gilt
 * frames (original, painted procedurally in a classical style), potted
 * plants, a marble bust on a column, a classical urn and an antique globe.
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
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

// ------------------------------------------------------------------ paintings

export type PaintingKind = "sunset" | "windmill" | "starry" | "sailboat" | "poppies";

/** The scene laid in with flat shapes, before the brushwork. */
function underpainting(kind: PaintingKind, ctx: CanvasRenderingContext2D, W: number, H: number, r: () => number): void {
  const grad = (y0: number, y1: number, stops: [number, string][]) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  };
  const hill = (y: number, amp: number, color: string, seed: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, y + Math.sin(x / W * 6 + seed) * amp + Math.sin(x / W * 13 + seed * 2) * amp * 0.3);
    ctx.lineTo(W, H);
    ctx.fill();
  };
  if (kind === "sunset") {
    ctx.fillStyle = grad(0, H * 0.58, [[0, "#3b2a5c"], [0.45, "#c0566a"], [0.8, "#f1a24a"], [1, "#f7d27a"]]);
    ctx.fillRect(0, 0, W, H * 0.58);
    ctx.fillStyle = grad(H * 0.58, H, [[0, "#c97a4a"], [0.15, "#4a5a7a"], [1, "#1c2638"]]);
    ctx.fillRect(0, H * 0.58, W, H * 0.42);
    ctx.fillStyle = "#fde3a0";
    ctx.beginPath();
    ctx.arc(W * 0.62, H * 0.52, H * 0.07, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = `rgba(253,210,130,${0.5 - i * 0.03})`;
      ctx.fillRect(W * 0.62 - 40 + r() * 20, H * 0.6 + i * 9, 60 + r() * 30, 3);
    }
    hill(H * 0.6, 6, "#2a2436", 1);
  } else if (kind === "windmill") {
    ctx.fillStyle = grad(0, H * 0.62, [[0, "#5f86b8"], [1, "#cfe0ee"]]);
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      const cx = r() * W;
      const cy = H * (0.1 + r() * 0.3);
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        ctx.ellipse(cx + k * 18 - 40, cy + Math.sin(k) * 6, 30 + r() * 20, 16 + r() * 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    hill(H * 0.62, 14, "#7a9a4a", 2);
    hill(H * 0.72, 10, "#5d7f33", 4);
    hill(H * 0.84, 8, "#b8a24a", 6);
    // windmill
    const x = W * 0.68;
    const y = H * 0.66;
    ctx.fillStyle = "#4a3324";
    ctx.beginPath();
    ctx.moveTo(x - 22, y);
    ctx.lineTo(x + 22, y);
    ctx.lineTo(x + 12, y - 110);
    ctx.lineTo(x - 12, y - 110);
    ctx.fill();
    ctx.strokeStyle = "#e9dcc0";
    ctx.lineWidth = 7;
    for (let a = 0; a < 4; a++) {
      const ang = 0.4 + (a * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 110);
      ctx.lineTo(x + Math.cos(ang) * 80, y - 110 + Math.sin(ang) * 80);
      ctx.stroke();
    }
  } else if (kind === "starry") {
    ctx.fillStyle = grad(0, H, [[0, "#14214a"], [0.6, "#2b4a8a"], [1, "#1a2a3a"]]);
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 11; i++) {
      const x = r() * W;
      const y = r() * H * 0.55;
      const rr = 6 + r() * 12;
      const g = ctx.createRadialGradient(x, y, 1, x, y, rr * 2.4);
      g.addColorStop(0, "#fff6b0");
      g.addColorStop(0.4, "#f2d35a");
      g.addColorStop(1, "rgba(80,110,180,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - rr * 3, y - rr * 3, rr * 6, rr * 6);
    }
    ctx.fillStyle = "#f6d55a";
    ctx.beginPath();
    ctx.arc(W * 0.86, H * 0.16, 22, 0, Math.PI * 2);
    ctx.fill();
    hill(H * 0.7, 16, "#24324a", 3);
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = r() > 0.6 ? "#e9c25a" : "#3a4a5e";
      ctx.fillRect(W * 0.35 + r() * W * 0.5, H * 0.74 + r() * H * 0.12, 10 + r() * 10, 8 + r() * 8);
    }
    // a dark cypress rising on the left
    ctx.fillStyle = "#14200f";
    ctx.beginPath();
    ctx.moveTo(W * 0.1, H);
    ctx.bezierCurveTo(W * 0.02, H * 0.6, W * 0.14, H * 0.3, W * 0.15, H * 0.12);
    ctx.bezierCurveTo(W * 0.2, H * 0.35, W * 0.27, H * 0.7, W * 0.24, H);
    ctx.fill();
  } else if (kind === "sailboat") {
    ctx.fillStyle = grad(0, H * 0.55, [[0, "#8fb4d0"], [1, "#e8dcc4"]]);
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = grad(H * 0.55, H, [[0, "#6f98a8"], [1, "#2f4f5e"]]);
    ctx.fillRect(0, H * 0.55, W, H * 0.45);
    ctx.fillStyle = "#6a7a6a";
    ctx.beginPath();
    ctx.ellipse(W * 0.15, H * 0.56, W * 0.22, 14, 0, Math.PI, 0);
    ctx.fill();
    const x = W * 0.55;
    const y = H * 0.72;
    ctx.fillStyle = "#5a3a24";
    ctx.fillRect(x - 50, y, 100, 14);
    ctx.fillStyle = "#f4efe2";
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y - 150);
    ctx.lineTo(x + 70, y - 6);
    ctx.fill();
    ctx.fillStyle = "#e8d9bc";
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 10);
    ctx.lineTo(x - 4, y - 120);
    ctx.lineTo(x - 56, y - 10);
    ctx.fill();
  } else {
    ctx.fillStyle = grad(0, H * 0.5, [[0, "#9ab8d0"], [1, "#eae2c8"]]);
    ctx.fillRect(0, 0, W, H);
    hill(H * 0.5, 10, "#8aa05a", 5);
    hill(H * 0.62, 8, "#6c8a3c", 7);
    ctx.fillStyle = "#3e5a2a";
    ctx.beginPath();
    ctx.arc(W * 0.78, H * 0.38, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4a3324";
    ctx.fillRect(W * 0.775, H * 0.4, 8, 50);
    for (let i = 0; i < 900; i++) {
      const y = H * 0.62 + r() * H * 0.38;
      ctx.fillStyle = r() > 0.2 ? "#c8321e" : "#e6b83a";
      ctx.beginPath();
      ctx.arc(r() * W, y, 1.5 + ((y - H * 0.6) / H) * 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Oil-paint look: thousands of short strokes picking up the underpainting colours. */
export function paintingTexture(kind: PaintingKind, seed: number): THREE.CanvasTexture {
  const W = 640;
  const H = 480;
  const r = rng(seed);
  const [base, bctx] = canvas(W, H);
  underpainting(kind, bctx, W, H, r);
  const px = bctx.getImageData(0, 0, W, H).data;
  const [c, ctx] = canvas(W, H);
  ctx.drawImage(base, 0, 0);
  ctx.lineCap = "round";
  const swirl = (x: number, y: number) => {
    if (kind !== "starry" || y > H * 0.68) return 0;
    const cx = [W * 0.35, W * 0.6];
    const cy = [H * 0.3, H * 0.22];
    let a = 0;
    for (let i = 0; i < 2; i++) {
      const dx = x - cx[i];
      const dy = y - cy[i];
      const d = Math.hypot(dx, dy);
      if (d < 140) a = Math.atan2(dy, dx) + Math.PI / 2;
    }
    return a || Math.sin(x / 40) * 0.5;
  };
  const N = kind === "starry" ? 26000 : 20000;
  for (let i = 0; i < N; i++) {
    const x = r() * W;
    const y = r() * H;
    const k = (Math.floor(y) * W + Math.floor(x)) * 4;
    const j = (v: number) => Math.max(0, Math.min(255, v + (r() - 0.5) * 36));
    ctx.strokeStyle = `rgba(${j(px[k])},${j(px[k + 1])},${j(px[k + 2])},0.75)`;
    ctx.lineWidth = 1.5 + r() * 3;
    const len = 4 + r() * 9;
    const ang = swirl(x, y) || (r() - 0.5) * 0.5;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // varnish: a warm, slightly darkened finish
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
  v.addColorStop(0, "rgba(255,230,180,0.04)");
  v.addColorStop(1, "rgba(40,20,5,0.35)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function framedPainting(kind: PaintingKind, seed: number, w: number, h: number, gold: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const canvasMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: paintingTexture(kind, seed), roughness: 0.75 }));
  canvasMesh.position.z = 0.02;
  canvasMesh.name = "canvas";
  g.add(canvasMesh);
  const f = 0.09;
  const bars: [number, number, number, number][] = [
    [0, h / 2 + f / 2, w + 2 * f, f],
    [0, -h / 2 - f / 2, w + 2 * f, f],
    [-w / 2 - f / 2, 0, f, h],
    [w / 2 + f / 2, 0, f, h],
  ];
  for (const [x, y, bw, bh] of bars) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.07), gold);
    b.position.set(x, y, 0.035);
    b.castShadow = true;
    g.add(b);
    // inner bead
    const bead = new THREE.Mesh(new THREE.BoxGeometry(bw === f ? 0.018 : bw - f, bw === f ? bh : 0.018, 0.085), gold);
    bead.position.set(x + (bw === f ? (x < 0 ? f / 2 : -f / 2) : 0), y + (bw === f ? 0 : y < 0 ? f / 2 : -f / 2), 0.04);
    g.add(bead);
  }
  // picture light above
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, w * 0.5, 12), gold);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, h / 2 + f + 0.08, 0.16);
  g.add(bar);
  return g;
}

// ------------------------------------------------------------------ plants

function leafTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 256);
  const g = ctx.createLinearGradient(0, 0, 128, 0);
  g.addColorStop(0, "#2f5a2a");
  g.addColorStop(0.5, "#4f8a3a");
  g.addColorStop(1, "#2a5226");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(64, 250);
  ctx.bezierCurveTo(0, 190, 4, 60, 64, 4);
  ctx.bezierCurveTo(124, 60, 128, 190, 64, 250);
  ctx.fill();
  ctx.strokeStyle = "rgba(200,230,160,0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, 250);
  ctx.lineTo(64, 10);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  for (let y = 40; y < 230; y += 22) {
    ctx.beginPath();
    ctx.moveTo(64, y + 14);
    ctx.lineTo(24, y);
    ctx.moveTo(64, y + 14);
    ctx.lineTo(104, y);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let leafMat: THREE.MeshStandardMaterial | null = null;

function pot(radius: number, height: number, color: string): THREE.Mesh {
  const pts = [
    [0, 0],
    [radius * 0.72, 0],
    [radius * 0.8, height * 0.1],
    [radius * 0.95, height * 0.85],
    [radius * 1.05, height * 0.88],
    [radius * 1.05, height],
    [radius * 0.9, height],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** "fig": a small tree with broad leaves; "palm": arching fronds from the pot. */
export function plant(kind: "fig" | "palm", seed: number): THREE.Group {
  const r = rng(seed);
  leafMat ??= new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 });
  const g = new THREE.Group();
  const ph = kind === "fig" ? 0.42 : 0.5;
  g.add(pot(kind === "fig" ? 0.22 : 0.26, ph, kind === "fig" ? "#a4552e" : "#6a4a2a"));
  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), new THREE.MeshStandardMaterial({ color: "#2a1a10", roughness: 1 }));
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = ph * 0.95;
  g.add(soil);
  const n = kind === "fig" ? 80 : 34;
  const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), leafMat, n);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  if (kind === "fig") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.3, 8), new THREE.MeshStandardMaterial({ color: "#5a4030", roughness: 0.9 }));
    trunk.position.y = ph + 0.6;
    trunk.castShadow = true;
    g.add(trunk);
    for (let i = 0; i < n; i++) {
      const y = ph + 0.45 + r() * 1.05;
      const a = r() * Math.PI * 2;
      e.set(-0.5 - r() * 0.6, a, 0, "YXZ");
      q.setFromEuler(e);
      const s = 0.26 + r() * 0.14;
      m4.compose(new THREE.Vector3(Math.cos(a) * 0.03, y, Math.sin(a) * 0.03), q, new THREE.Vector3(s * 0.75, s * 1.1, 1));
      leaves.setMatrixAt(i, m4);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.3;
      e.set(-0.25 - r() * 0.9, a, 0, "YXZ");
      q.setFromEuler(e);
      const s = 0.55 + r() * 0.4;
      m4.compose(new THREE.Vector3(0, ph * 0.95, 0), q, new THREE.Vector3(0.12, s, 1));
      leaves.setMatrixAt(i, m4);
    }
  }
  leaves.castShadow = true;
  g.add(leaves);
  return g;
}

// ------------------------------------------------------------------ marble, urn, globe

function marbleTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  const r = rng(31);
  ctx.fillStyle = "#ece7dd";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 18; i++) {
    ctx.strokeStyle = `rgba(120,110,100,${0.08 + r() * 0.12})`;
    ctx.lineWidth = 0.6 + r() * 1.5;
    ctx.beginPath();
    let x = r() * 256;
    let y = 0;
    ctx.moveTo(x, y);
    while (y < 256) {
      x += (r() - 0.5) * 30;
      y += 10 + r() * 20;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A classical bust (stylised) on a fluted marble column. */
export function bustOnColumn(): THREE.Group {
  const marble = new THREE.MeshStandardMaterial({ map: marbleTexture(), color: "#f2eee6", roughness: 0.35 });
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.46), marble);
  base.position.y = 0.04;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 1.0, 20), marble);
  shaft.position.y = 0.58;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.4), marble);
  cap.position.y = 1.115;
  g.add(base, shaft, cap);
  // flutes
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const fl = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.96, 0.012), new THREE.MeshStandardMaterial({ color: "#d8d2c6", roughness: 0.5 }));
    fl.position.set(Math.cos(a) * 0.158, 0.58, Math.sin(a) * 0.158);
    g.add(fl);
  }
  const bust = new THREE.Group();
  bust.position.y = 1.15;
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.06, 20), marble);
  plinth.position.y = 0.03;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), marble);
  chest.scale.set(1.25, 0.95, 0.7);
  chest.position.y = 0.06;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.14, 16), marble);
  neck.position.y = 0.28;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), marble);
  head.scale.set(0.9, 1.15, 1.0);
  head.position.set(0, 0.42, 0.01);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), marble);
  hair.scale.set(1.0, 1.05, 1.1);
  hair.position.set(0, 0.45, -0.015);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 8), marble);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.41, 0.115);
  bust.add(plinth, chest, neck, head, hair, nose);
  g.add(bust);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}

/** A Greek-style amphora on a low marble pedestal. */
export function urnOnPedestal(): THREE.Group {
  const g = new THREE.Group();
  const marble = new THREE.MeshStandardMaterial({ map: marbleTexture(), roughness: 0.4 });
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.75, 0.42), marble);
  ped.position.y = 0.375;
  g.add(ped);
  const prof = [
    [0, 0], [0.09, 0], [0.1, 0.03], [0.07, 0.07], [0.16, 0.2], [0.19, 0.32], [0.17, 0.44], [0.08, 0.56], [0.065, 0.62], [0.11, 0.66], [0.1, 0.68],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const [c, ctx] = canvas(512, 256);
  ctx.fillStyle = "#b5582c";
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = "#1b120c";
  ctx.fillRect(0, 0, 512, 40);
  ctx.fillRect(0, 200, 512, 56);
  // meander band
  ctx.strokeStyle = "#1b120c";
  ctx.lineWidth = 5;
  for (let x = 0; x < 512; x += 32) {
    ctx.strokeRect(x + 4, 150, 22, 22);
  }
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.ellipse(64 + i * 128, 100, 20, 34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const urn = new THREE.Mesh(new THREE.LatheGeometry(prof, 32), new THREE.MeshStandardMaterial({ map: t, roughness: 0.45 }));
  urn.position.y = 0.75;
  g.add(urn);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}

/** An antique globe on a wooden tripod with a brass meridian. */
export function globe(wood: THREE.Material, brass: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const [c, ctx] = canvas(512, 256);
  const r = rng(12);
  ctx.fillStyle = "#c9b48a";
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = "#8a6a3a";
  for (let i = 0; i < 9; i++) {
    const x = r() * 512;
    const y = 40 + r() * 170;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const rr = 20 + r() * 34;
      ctx.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr);
    }
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(60,40,20,0.35)";
  for (let x = 0; x < 512; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  for (let y = 0; y < 256; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 24), new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 }));
  ball.position.y = 1.0;
  ball.rotation.z = 0.41;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.012, 8, 48), brass);
  ring.position.y = 1.0;
  ring.rotation.set(0, Math.PI / 2, 0.41);
  const horizon = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.02, 8, 48), wood);
  horizon.rotation.x = Math.PI / 2;
  horizon.position.y = 1.0;
  g.add(ball, ring, horizon);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, 1.02, 8), wood);
    leg.position.set(Math.cos(a) * 0.16, 0.5, Math.sin(a) * 0.16);
    leg.rotation.set(Math.sin(a) * 0.28, 0, -Math.cos(a) * 0.28);
    g.add(leg);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
  });
  return g;
}

/** The user's own picture, cropped to fill the frame (no stretching), with a faint varnish. */
export function pictureTexture(img: ImageBitmap, aspect: number): THREE.CanvasTexture {
  const W = 1024;
  const H = Math.round(W / aspect);
  const [c, ctx] = canvas(W, H);
  const s = Math.max(W / img.width, H / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, "rgba(255,240,210,0)");
  g.addColorStop(1, "rgba(60,40,20,0.22)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
