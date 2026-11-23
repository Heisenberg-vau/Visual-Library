import "../ui/fonts";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  corkTexture,
  coverTexture,
  floorTexture,
  noteTexture,
  pagesTexture,
  plaqueTexture,
  plasterTexture,
  spineTexture,
  woodTexture,
  type SpineStyle,
} from "./textures";

/*
 * 3D prototype of the library room, following the user's sketch:
 * easel pinboard on the left, study desk + chair in the middle, parallel
 * book stacks on the right with name plaques on their ends.
 * Rendering happens only while something moves (battery friendly).
 */

type View = "hall" | "desk" | "board" | `aisle${number}`;

interface Book {
  mesh: THREE.Mesh;
  title: string;
  author: string;
  color: string;
  cloth: boolean;
  side: 1 | -1;
  home: { parent: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion };
  state: "shelf" | "out" | "desk";
}

const CATEGORIES: { name: string; books: [string, string, string?][] }[] = [
  {
    name: "Hàng không",
    books: [
      ["Động cơ phản lực", "Rolls-Royce"], ["Gas Turbine Theory", "Saravanamuttoo"], ["ATA 72 – Engine", "AMM"], ["Aerodynamics", "Anderson"],
      ["Aircraft Structures", "Megson"], ["Vở – Động cơ", "Vở ghi", "nb"], ["Flight Mechanics", "Stengel"], ["An toàn sân đỗ", "Giáo trình"],
      ["Fuel Systems", "Boeing"], ["Composites", "Baker"], ["Aviation English", "Emery"], ["ICAO Phraseology", "ICAO"],
    ],
  },
  {
    name: "Tiếng Trung",
    books: [
      ["Hán ngữ 1", "Dương Ký Châu"], ["Hán ngữ 2", "Dương Ký Châu"], ["HSK Standard 1", "Khương Lệ Bình"], ["Vở – Chữ Hán", "Vở ghi", "nb"],
      ["214 Bộ thủ", "Tham khảo"], ["Ngữ pháp", "Tham khảo"], ["Từ điển", "Tham khảo"],
    ],
  },
  {
    name: "Tâm lý học",
    books: [
      ["Tư duy nhanh và chậm", "Kahneman"], ["Thói quen nguyên tử", "Clear"], ["Deep Work", "Newport"], ["Tâm lý giao dịch", "Douglas"],
      ["Vở – Suy ngẫm", "Vở ghi", "nb"], ["Flow", "Csikszentmihalyi"],
    ],
  },
];
const COLORS = ["#6e2a22", "#2f4a3c", "#3b2f5a", "#7a5a22", "#23465e", "#5a2a3a", "#4a3a2a", "#2e5a55", "#6a3d1e", "#36402a"];

// ---------------------------------------------------------------- setup
const host = document.getElementById("scene")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(host.clientWidth, host.clientHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#1d140d");
scene.fog = new THREE.Fog("#1d140d", 12, 24);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.05, 60);
const target = new THREE.Vector3();

let spineStyle: SpineStyle = (localStorage.getItem("vl.spine") as SpineStyle) || "up";

// ---------------------------------------------------------------- materials
const mat = {
  walnut: new THREE.MeshStandardMaterial({ map: woodTexture("#4a2e1a", 3, [1, 1]), roughness: 0.62, metalness: 0.0 }),
  walnutDark: new THREE.MeshStandardMaterial({ map: woodTexture("#33200f", 9, [1, 1]), roughness: 0.68 }),
  oak: new THREE.MeshStandardMaterial({ map: woodTexture("#7a5233", 21, [1, 1]), roughness: 0.55 }),
  floor: new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.7 }),
  plaster: new THREE.MeshStandardMaterial({ map: plasterTexture(), roughness: 0.95 }),
  wainscot: new THREE.MeshStandardMaterial({ map: woodTexture("#3e2614", 41, [4, 1]), roughness: 0.6 }),
  brass: new THREE.MeshStandardMaterial({ color: "#c49a4a", roughness: 0.32, metalness: 0.9 }),
  pages: new THREE.MeshStandardMaterial({ map: pagesTexture(), roughness: 0.9 }),
  cork: new THREE.MeshStandardMaterial({ map: corkTexture(), roughness: 0.95 }),
  leather: new THREE.MeshStandardMaterial({ color: "#5a2318", roughness: 0.55 }),
  shade: new THREE.MeshStandardMaterial({ color: "#2f4a3c", roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide }),
  bulb: new THREE.MeshStandardMaterial({ color: "#fff1c8", emissive: "#ffd889", emissiveIntensity: 3 }),
  windowGlow: new THREE.MeshStandardMaterial({ color: "#000", emissive: "#9fb6c9", emissiveIntensity: 0.9 }),
};

function box(w: number, h: number, d: number, m: THREE.Material | THREE.Material[], round = 0): THREE.Mesh {
  const g = round ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- room
function buildRoom(): void {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 14), mat.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -2);
  floor.receiveShadow = true;
  scene.add(floor);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(16, 4.2), mat.plaster);
  back.position.set(0, 2.1, -8);
  back.receiveShadow = true;
  scene.add(back);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(14, 4.2), mat.plaster);
  left.rotation.y = Math.PI / 2;
  left.position.set(-7, 2.1, -2);
  left.receiveShadow = true;
  scene.add(left);
  // wainscot panelling
  const wb = box(16, 1.0, 0.06, mat.wainscot);
  wb.position.set(0, 0.5, -7.97);
  scene.add(wb);
  const wl = box(0.06, 1.0, 14, mat.wainscot);
  wl.position.set(-6.97, 0.5, -2);
  scene.add(wl);
  for (const [x, z, ry] of [[0, -7.93, 0], [-6.93, -2, Math.PI / 2]] as const) {
    const rail = box(ry ? 0.05 : 16, 0.06, ry ? 14 : 0.05, mat.walnutDark);
    rail.position.set(x, 1.02, z);
    scene.add(rail);
  }
  // tall window on the left wall: cool daylight in a warm room
  const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), mat.windowGlow);
  win.rotation.y = Math.PI / 2;
  win.position.set(-6.95, 2.3, -4.6);
  scene.add(win);
  const frameM = mat.walnutDark;
  for (const [y, h] of [[1.18, 0.08], [3.42, 0.08], [2.3, 0.05]] as const) {
    const f = box(0.08, h, 1.56, frameM);
    f.position.set(-6.9, y, -4.6);
    scene.add(f);
  }
  for (const z of [-5.36, -3.84, -4.6]) {
    const f = box(0.08, 2.3, z === -4.6 ? 0.05 : 0.08, frameM);
    f.position.set(-6.9, 2.3, z);
    scene.add(f);
  }
  // ceiling and beams
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(16, 14), mat.walnutDark);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, 4.2, -2);
  scene.add(ceil);
  for (let z = -7.5; z <= 3.5; z += 1.6) {
    const beam = box(16, 0.22, 0.18, mat.walnut);
    beam.position.set(0, 4.09, z);
    scene.add(beam);
  }
  // built-in shelves along the back wall (decor: one instanced mesh)
  const wallCase = new THREE.Group();
  const wcW = 9.2;
  const wcX = 1.2;
  const wcBack = box(wcW, 3.0, 0.04, mat.walnutDark);
  wcBack.position.set(wcX, 1.5, -7.9);
  wallCase.add(wcBack);
  for (let i = 0; i <= 8; i++) {
    const post = box(0.06, 3.0, 0.4, mat.walnut);
    post.position.set(wcX - wcW / 2 + (i * wcW) / 8, 1.5, -7.72);
    wallCase.add(post);
  }
  const rows = [0.08, 0.6, 1.12, 1.64, 2.16, 2.68];
  for (const y of rows) {
    const sh = box(wcW, 0.04, 0.4, mat.walnut);
    sh.position.set(wcX, y, -7.72);
    wallCase.add(sh);
  }
  const wcTop = box(wcW + 0.2, 0.1, 0.48, mat.walnutDark);
  wcTop.position.set(wcX, 3.03, -7.72);
  wallCase.add(wcTop);
  const bookGeo = new THREE.BoxGeometry(1, 1, 1);
  const bookMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const inst = new THREE.InstancedMesh(bookGeo, bookMat, 1400);
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  let k = 0;
  let sd = 7;
  const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (const y of rows.slice(0, -1)) {
    let x = wcX - wcW / 2 + 0.06;
    while (x < wcX + wcW / 2 - 0.08 && k < 1400) {
      const t = 0.025 + rnd() * 0.05;
      const h = 0.3 + rnd() * 0.15;
      if (Math.abs(((x - (wcX - wcW / 2)) % (wcW / 8))) < 0.05) { x += 0.06; continue; }
      m4.makeScale(t, h, 0.24).setPosition(x + t / 2, y + 0.02 + h / 2, -7.72);
      inst.setMatrixAt(k, m4);
      inst.setColorAt(k, col.set(COLORS[Math.floor(rnd() * COLORS.length)]).multiplyScalar(0.8 + rnd() * 0.4));
      k++;
      x += t + 0.002 + (rnd() < 0.04 ? 0.15 : 0);
    }
  }
  inst.count = k;
  inst.castShadow = inst.receiveShadow = true;
  wallCase.add(inst);
  scene.add(wallCase);
  // two pendant lamps over the room
  for (const [x, z] of [[-1.4, -2.9], [3.1, -3.6]]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.2, 6), mat.walnutDark);
    cord.position.set(x, 3.6, z);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.24, 0.18, 24, 1, true), mat.brass);
    shade.position.set(x, 2.95, z);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), mat.bulb);
    bulb.position.set(x, 2.9, z);
    scene.add(cord, shade, bulb);
  }
  // rug under the desk
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 2.2),
    new THREE.MeshStandardMaterial({ color: "#5a2a22", roughness: 1, map: corkTexture() }),
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(-1.4, 0.005, -2.6);
  rug.receiveShadow = true;
  scene.add(rug);
}

// ---------------------------------------------------------------- lights
const lampLight = new THREE.SpotLight("#ffcf86", 11, 6, Math.PI / 3.0, 0.8, 1.6);
function buildLights(): void {
  scene.add(new THREE.HemisphereLight("#ffe7c2", "#2a1a0e", 0.45));
  const sun = new THREE.DirectionalLight("#cfdcea", 1.3);
  sun.position.set(-9, 5, -4);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -8;
  sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -4;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  // warm ceiling fill over the stacks
  for (const x of [2.2, 4.2]) {
    const p = new THREE.PointLight("#ffd59a", 6, 7, 1.8);
    p.position.set(x, 3.4, -3.2);
    scene.add(p);
  }
}

// ---------------------------------------------------------------- bookcases
const books: Book[] = [];
const zones: THREE.Object3D[] = [];
const STACK = { W: 0.66, H: 2.25, L: 3.4, shelves: [0.1, 0.52, 0.94, 1.36, 1.78] };
const aisleX: number[] = [];
const caseX = [1.5, 3.1, 4.7];
const caseZ = -3.6; // centre along the room depth

function buildStack(ci: number): void {
  const { W, H, L, shelves } = STACK;
  const g = new THREE.Group();
  g.position.set(caseX[ci], 0, caseZ);
  g.userData.zone = `aisle${ci}`;
  // carcass
  for (const z of [-L / 2, L / 2]) {
    const end = box(W + 0.04, H, 0.05, mat.walnut);
    end.position.set(0, H / 2, z);
    g.add(end);
  }
  const mid = box(0.025, H - 0.1, L, mat.walnutDark);
  mid.position.set(0, H / 2, 0);
  g.add(mid);
  const top = box(W + 0.1, 0.06, L + 0.1, mat.walnut);
  top.position.set(0, H + 0.03, 0);
  g.add(top);
  const crown = box(W + 0.16, 0.05, L + 0.16, mat.walnutDark);
  crown.position.set(0, H + 0.085, 0);
  g.add(crown);
  for (const y of shelves) {
    const s = box(W, 0.03, L - 0.05, mat.walnut);
    s.position.set(0, y, 0);
    g.add(s);
  }
  const plinth = box(W + 0.02, 0.09, L, mat.walnutDark);
  plinth.position.set(0, 0.045, 0);
  g.add(plinth);
  // brass plaque on the aisle end facing the room
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.155), new THREE.MeshStandardMaterial({ map: plaqueTexture(CATEGORIES[ci].name), metalness: 0.75, roughness: 0.35 }));
  plaque.position.set(0, 1.62, L / 2 + 0.027);
  g.add(plaque);
  // books on both faces
  const cat = CATEGORIES[ci];
  let n = 0;
  for (const side of [1, -1] as const) {
    for (let si = 0; si < shelves.length - 1; si++) {
      let z = -L / 2 + 0.06;
      const shelfTop = shelves[si] + 0.015;
      while (z < L / 2 - 0.12) {
        const [title, author, kind] = cat.books[n % cat.books.length];
        const seed = ci * 1000 + n * 17 + side * 7;
        const cloth = kind === "nb";
        const t = 0.028 + (((seed * 9301 + 49297) % 233280) / 233280) * 0.045 + (cloth ? -0.01 : 0);
        const hgt = 0.27 + (((seed * 7 + 13) % 11) / 11) * 0.08;
        const d = 0.2;
        const color = cloth ? ["#3d5a6b", "#5a4a3a", "#4a5a3a"][ci] : COLORS[(seed >> 2) % COLORS.length];
        const spineMat = new THREE.MeshStandardMaterial({ map: spineTexture(title, color, seed, spineStyle, cloth), roughness: cloth ? 0.85 : 0.5 });
        const plain = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
        // faces: +x, -x, +y, -y, +z, -z  (spine faces the aisle)
        const mats = side === 1 ? [spineMat, mat.pages, mat.pages, mat.pages, plain, plain] : [mat.pages, spineMat, mat.pages, mat.pages, plain, plain];
        const m = box(d, hgt, t, mats);
        if (side === -1) {
          // keep the lettering readable on the other face
          spineMat.map!.wrapS = THREE.RepeatWrapping;
          spineMat.map!.repeat.x = -1;
        }
        m.position.set(side * (W / 2 - d / 2 - 0.015), shelfTop + hgt / 2, z + t / 2);
        // a gentle lean now and then
        g.add(m);
        const book: Book = {
          mesh: m, title, author, color, cloth, side,
          home: { parent: g, pos: m.position.clone(), quat: m.quaternion.clone() }, state: "shelf",
        };
        m.userData.book = book;
        books.push(book);
        z += t + 0.003;
        n++;
        if ((seed % 29) === 0) z += 0.12; // a little space here and there
      }
    }
  }
  scene.add(g);
  zones.push(g);
}

// ---------------------------------------------------------------- desk, chair, lamp
const DESK = new THREE.Vector3(-1.4, 0, -2.9);
const deskSpots: THREE.Vector3[] = [];
function buildDesk(): void {
  const g = new THREE.Group();
  g.position.copy(DESK);
  g.userData.zone = "desk";
  const top = box(1.6, 0.05, 0.82, mat.oak, 0.01);
  top.position.y = 0.76;
  g.add(top);
  const apron = box(1.5, 0.12, 0.74, mat.walnut);
  apron.position.y = 0.675;
  g.add(apron);
  for (const [x, z] of [[-0.74, -0.36], [0.74, -0.36], [-0.74, 0.36], [0.74, 0.36]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.02, 0.74, 12), mat.walnut);
    leg.position.set(x, 0.37, z);
    leg.castShadow = leg.receiveShadow = true;
    g.add(leg);
  }
  // leather blotter
  const blot = box(0.7, 0.006, 0.45, new THREE.MeshStandardMaterial({ color: "#3d1c14", roughness: 0.8 }), 0.002);
  blot.position.set(0.05, 0.788, 0.08);
  g.add(blot);
  // lamp (banker's style, green shade)
  const lamp = new THREE.Group();
  lamp.position.set(0.55, 0.785, -0.22);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.03, 24), mat.brass);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.34, 10), mat.brass);
  rod.position.y = 0.18;
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.15, 0.13, 32, 1, true), mat.shade);
  shade.position.set(-0.05, 0.36, 0.03);
  shade.rotation.z = 0.25;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), mat.bulb);
  bulb.position.set(-0.06, 0.33, 0.03);
  for (const o of [base, rod, shade]) o.castShadow = true;
  lamp.add(base, rod, shade, bulb);
  g.add(lamp);
  lampLight.position.set(DESK.x + 0.48, 1.12, DESK.z - 0.19);
  lampLight.target.position.set(DESK.x - 0.1, 0.78, DESK.z + 0.1);
  lampLight.castShadow = true;
  lampLight.shadow.mapSize.set(1024, 1024);
  lampLight.shadow.bias = -0.0006;
  scene.add(lampLight, lampLight.target);
  const glow = new THREE.PointLight("#ffc979", 2.2, 3, 2);
  glow.position.set(DESK.x + 0.48, 1.1, DESK.z - 0.15);
  scene.add(glow);
  // inkwell + pen
  const ink = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.05, 16), new THREE.MeshStandardMaterial({ color: "#10161c", roughness: 0.1, metalness: 0.2 }));
  ink.position.set(-0.55, 0.81, -0.22);
  ink.castShadow = true;
  g.add(ink);
  // chair
  const chair = new THREE.Group();
  chair.position.set(0, 0, 0.72);
  const seat = box(0.48, 0.05, 0.46, mat.leather, 0.015);
  seat.position.y = 0.47;
  chair.add(seat);
  for (const [x, z] of [[-0.21, -0.2], [0.21, -0.2], [-0.21, 0.2], [0.21, 0.2]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.018, 0.46, 10), mat.walnut);
    leg.position.set(x, 0.23, z);
    leg.castShadow = true;
    chair.add(leg);
  }
  const backrest = box(0.46, 0.42, 0.04, mat.leather, 0.015);
  backrest.position.set(0, 0.74, 0.22);
  backrest.rotation.x = -0.1;
  chair.add(backrest);
  for (const x of [-0.22, 0.22]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 10), mat.walnut);
    post.position.set(x, 0.72, 0.23);
    post.rotation.x = -0.1;
    chair.add(post);
  }
  g.add(chair);
  scene.add(g);
  zones.push(g);
  // up to 6 places on the desk (world coords)
  const spots = [[-0.5, 0.1], [-0.1, 0.2], [0.25, 0.05], [-0.45, -0.18], [-0.05, -0.15], [0.3, -0.2]];
  for (const [x, z] of spots) deskSpots.push(new THREE.Vector3(DESK.x + x, 0.8, DESK.z + z));
}

// ---------------------------------------------------------------- easel pinboard
function buildBoard(): void {
  const g = new THREE.Group();
  g.position.set(-4.4, 0, -3.0);
  g.rotation.y = 0.45;
  g.userData.zone = "board";
  const tilt = new THREE.Group();
  tilt.position.set(0, 1.45, 0.09);
  tilt.rotation.x = -0.12;
  const board = box(1.3, 0.95, 0.03, mat.cork);
  const frame = [
    [0, 0.5, 1.42, 0.06], [0, -0.5, 1.42, 0.06], [-0.68, 0, 0.06, 1.06], [0.68, 0, 0.06, 1.06],
  ];
  tilt.add(board);
  for (const [x, y, w, h] of frame) {
    const f = box(w, h, 0.06, mat.walnut);
    f.position.set(x, y, 0.01);
    tilt.add(f);
  }
  const notes: [string, string[], number, number, number, string][] = [
    ["Hôm nay", ["☑ Động cơ tr.120–140", "☐ Ôn ATA 72-30", "☐ HSK1 bài 3"], -0.34, 0.16, -0.05, "#fbf5e2"],
    ["Sự kiện", ["Thi ATSĐ · còn 3 ngày", "Kiểm tra M15 · 9 ngày", "Thi HSK1 · 41 ngày"], 0.3, 0.14, 0.04, "#fbf5e2"],
    ["Dự định", ["CMT Level I", "Đọc hết Aerodynamics"], -0.22, -0.26, 0.06, "#f3e1b0"],
    ["Tuần này", ["T2–T3 Động cơ 7–8", "T5 đề cương ATSĐ"], 0.34, -0.25, -0.03, "#fbf5e2"],
  ];
  for (const [title, lines, x, y, rz, paper] of notes) {
    const n = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.36), new THREE.MeshStandardMaterial({ map: noteTexture(title, lines, paper), roughness: 0.9 }));
    n.position.set(x, y, 0.02);
    n.rotation.z = rz;
    n.castShadow = true;
    tilt.add(n);
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.018, 14, 10), new THREE.MeshStandardMaterial({ color: title === "Sự kiện" ? "#a2261c" : "#c49a4a", roughness: 0.3, metalness: 0.3 }));
    pin.position.set(x, y + 0.15, 0.04);
    pin.castShadow = true;
    tilt.add(pin);
  }
  g.add(tilt);
  // easel legs (tripod like the sketch)
  const legM = mat.walnut;
  const leg = (x: number, z: number, rx: number, rz: number, len: number) => {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, len, 10), legM);
    l.position.set(x, len / 2 * Math.cos(rx) - 0.02, z);
    l.rotation.set(rx, 0, rz);
    l.castShadow = true;
    g.add(l);
  };
  leg(-0.45, -0.02, -0.08, 0.12, 2.05);
  leg(0.45, -0.02, -0.08, -0.12, 2.05);
  leg(0, -0.45, 0.32, 0, 2.0);
  const ledge = box(1.4, 0.04, 0.12, mat.walnut);
  ledge.position.set(0, 0.95, 0.14);
  g.add(ledge);
  scene.add(g);
  zones.push(g);
}

// ---------------------------------------------------------------- camera views
const VIEWS: Record<string, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  hall: { pos: new THREE.Vector3(0.2, 2.35, 4.6), look: new THREE.Vector3(0.2, 1.0, -3.2), fov: 50 },
  desk: { pos: new THREE.Vector3(-1.4, 1.55, -1.75), look: new THREE.Vector3(-1.4, 0.78, -2.95), fov: 48 },
  board: { pos: new THREE.Vector3(-3.55, 1.45, -1.3), look: new THREE.Vector3(-4.4, 1.38, -3.0), fov: 46 },
};
function aisleView(ci: number, along = 0): { pos: THREE.Vector3; look: THREE.Vector3; fov: number } {
  const x = caseX[ci] + STACK.W / 2;
  return { pos: new THREE.Vector3(x + 0.86, 1.12, caseZ + along), look: new THREE.Vector3(x, 1.0, caseZ + along), fov: 58 };
}

let view: View = "hall";
let aisleAlong = 0;
let anim: { from: { pos: THREE.Vector3; look: THREE.Vector3; fov: number }; to: { pos: THREE.Vector3; look: THREE.Vector3; fov: number }; t0: number; dur: number } | null = null;
const tweens: ((now: number) => boolean)[] = [];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function goTo(v: View, instant = false): void {
  const to = v.startsWith("aisle") ? aisleView(Number(v.slice(5)), aisleAlong) : VIEWS[v];
  const from = { pos: camera.position.clone(), look: target.clone(), fov: camera.fov };
  view = v;
  if (instant) {
    camera.position.copy(to.pos);
    target.copy(to.look);
    camera.fov = to.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(target);
  } else {
    // a gentle arc through the room instead of a straight cut
    anim = { from, to, t0: performance.now(), dur: 1300 };
  }
  ui();
  kick();
}

// ---------------------------------------------------------------- books: pull out, to desk, back
let pulled: Book | null = null;
const onDesk: Book[] = [];

function tweenObject(o: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion, dur: number, done?: () => void): void {
  const p0 = o.position.clone();
  const q0 = o.quaternion.clone();
  const t0 = performance.now();
  tweens.push((now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = ease(k);
    o.position.lerpVectors(p0, pos, e);
    // lift a little in the middle of the move
    o.position.y += Math.sin(e * Math.PI) * 0.06;
    o.quaternion.slerpQuaternions(q0, quat, e);
    if (k >= 1) done?.();
    return k < 1;
  });
  kick();
}

function giveCover(b: Book): void {
  const ms = b.mesh.material as THREE.Material[];
  if ((ms[4] as THREE.MeshStandardMaterial).map) return;
  const cover = new THREE.MeshStandardMaterial({ map: coverTexture(b.title, b.author, b.color), roughness: 0.5 });
  ms[4] = cover;
  b.mesh.material = ms;
}

function pull(b: Book): void {
  if (pulled && pulled !== b) putBack(pulled);
  pulled = b;
  b.state = "out";
  giveCover(b);
  scene.attach(b.mesh);
  const dir = new THREE.Vector3().subVectors(target, camera.position).normalize();
  const pos = camera.position.clone().add(dir.multiplyScalar(0.55));
  pos.y -= 0.02;
  const m = new THREE.Object3D();
  m.position.copy(pos);
  m.lookAt(camera.position);
  tweenObject(b.mesh, pos, m.quaternion, 750);
  ui();
}

function putBack(b: Book): void {
  const { parent, pos, quat } = b.home;
  const wp = parent.localToWorld(pos.clone());
  const pq = new THREE.Quaternion();
  parent.getWorldQuaternion(pq);
  tweenObject(b.mesh, wp, pq.multiply(quat.clone()), 700, () => {
    parent.attach(b.mesh);
    b.mesh.position.copy(pos);
    b.mesh.quaternion.copy(quat);
  });
  b.state = "shelf";
  const i = onDesk.indexOf(b);
  if (i >= 0) onDesk.splice(i, 1);
  if (pulled === b) pulled = null;
  ui();
}

function toDesk(b: Book): void {
  if (onDesk.length >= 6) {
    flash("Bàn đã có 6 cuốn – cất bớt một cuốn trước nhé.");
    return;
  }
  const spot = deskSpots[onDesk.length];
  onDesk.push(b);
  b.state = "desk";
  pulled = null;
  const m = new THREE.Object3D();
  m.rotation.set(-Math.PI / 2, 0, onDesk.length % 2 ? 0.18 : -0.12);
  const t = (b.mesh.geometry as THREE.BoxGeometry).parameters?.depth ?? 0.04;
  tweenObject(b.mesh, new THREE.Vector3(spot.x, spot.y + t / 2 + onDesk.length * 0.002, spot.z), m.quaternion, 1100);
  setTimeout(() => goTo("desk"), 350);
}

// ---------------------------------------------------------------- input
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag: { x: number; y: number; along: number; moved: boolean } | null = null;

renderer.domElement.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, along: aisleAlong, moved: false };
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 6) drag.moved = true;
  if (drag.moved && view.startsWith("aisle") && !anim) {
    // swipe along the shelf
    aisleAlong = THREE.MathUtils.clamp(drag.along + dx * 0.004, -STACK.L / 2 + 0.6, STACK.L / 2 - 0.6);
    const v = aisleView(Number(view.slice(5)), aisleAlong);
    camera.position.copy(v.pos);
    target.copy(v.look);
    kick();
  }
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const d = drag;
  drag = null;
  if (!d || d.moved) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(scene.children, true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    const book = o.userData.book as Book | undefined;
    if (book) {
      if (book.state === "desk" && view === "desk") return flash(`Mở "${book.title}" để đọc tiếp (bản thử chưa mở sách thật).`);
      if (view.startsWith("aisle") && book.state === "shelf") return pull(book);
    }
    while (o && !o.userData.zone) o = o.parent;
    if (o?.userData.zone && view === "hall") return goTo(o.userData.zone as View);
    if (h.object.type === "Mesh") break;
  }
});

// ---------------------------------------------------------------- UI overlay
const bar = document.getElementById("bar")!;
const panel = document.getElementById("panel")!;
const toast = document.getElementById("toast")!;
function flash(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout((toast as unknown as { t: number }).t);
  (toast as unknown as { t: number }).t = window.setTimeout(() => (toast.hidden = true), 2600);
}
function ui(): void {
  const names: Record<string, string> = { hall: "Sảnh", desk: "Bàn học", board: "Bảng ghim" };
  const where = view.startsWith("aisle") ? `Kệ sách › ${CATEGORIES[Number(view.slice(5))].name}` : names[view];
  bar.innerHTML = `<span class="brand">Visual Library</span><span class="where">· ${where}</span><span class="grow"></span>
    ${view !== "hall" ? '<button data-go="hall">← Sảnh</button>' : ""}
    <button data-go="desk">Bàn học (${onDesk.length}/6)</button><button data-go="board">Bảng ghim</button>
    <button data-spine>Gáy: ${spineStyle === "up" ? "Kiểu 2 (đầu sang trái)" : "Kiểu 1 (đầu sang phải)"}</button>`;
  if (pulled) {
    panel.hidden = false;
    panel.innerHTML = `<div class="k">RÚT RA KHỎI KỆ</div><div class="t">${pulled.title}</div><div class="a">${pulled.author}</div>
      <div class="row"><button class="p" data-act="desk">Mở sách · đặt lên bàn</button><button data-act="back">Cất lại</button></div>`;
  } else panel.hidden = true;
  const deskBooks = onDesk.length && view === "desk";
  if (deskBooks && !pulled) {
    panel.hidden = false;
    panel.innerHTML = `<div class="k">TRÊN BÀN · ${onDesk.length}/6</div>${onDesk.map((b, i) => `<div class="desk-row"><span>${b.title}</span><button data-back="${i}">Cất lên kệ</button></div>`).join("")}`;
  }
}
bar.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.go) goTo(b.dataset.go as View);
  if (b.dataset.spine !== undefined) {
    spineStyle = spineStyle === "up" ? "down" : "up";
    localStorage.setItem("vl.spine", spineStyle);
    location.reload();
  }
});
panel.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.act === "desk" && pulled) toDesk(pulled);
  if (b.dataset.act === "back" && pulled) putBack(pulled);
  if (b.dataset.back !== undefined) {
    const book = onDesk[Number(b.dataset.back)];
    if (book) putBack(book);
  }
});

// ---------------------------------------------------------------- render on demand
let running = false;
function kick(): void {
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}
function frame(now: number): void {
  let busy = false;
  if (anim) {
    const k = Math.min(1, (now - anim.t0) / anim.dur);
    const e = ease(k);
    camera.position.lerpVectors(anim.from.pos, anim.to.pos, e);
    camera.position.y += Math.sin(e * Math.PI) * 0.35;
    target.lerpVectors(anim.from.look, anim.to.look, e);
    camera.fov = THREE.MathUtils.lerp(anim.from.fov, anim.to.fov, e);
    camera.updateProjectionMatrix();
    if (k >= 1) anim = null;
    else busy = true;
  }
  for (let i = tweens.length - 1; i >= 0; i--) {
    if (tweens[i](now)) busy = true;
    else tweens.splice(i, 1);
  }
  camera.lookAt(target);
  renderer.render(scene, camera);
  if (busy || drag) requestAnimationFrame(frame);
  else running = false;
}
window.addEventListener("resize", () => {
  renderer.setSize(host.clientWidth, host.clientHeight);
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
  kick();
});

// ---------------------------------------------------------------- start
await document.fonts.ready;
await Promise.all(['700 40px "Cormorant Garamond"', '400 20px "EB Garamond"', 'italic 400 20px "EB Garamond"'].map((f) => document.fonts.load(f, "Hàng không")));
buildRoom();
buildLights();
caseX.forEach((_, i) => buildStack(i));
caseX.forEach((x, i) => aisleX.push(x + (i < caseX.length - 1 ? (caseX[i + 1] - x) / 2 : 0.8)));
buildDesk();
buildBoard();
// one book already on the desk, leaving its gap on the shelf
const first = books.find((b) => b.title === "Động cơ phản lực" && b.side === 1);
if (first) {
  giveCover(first);
  scene.attach(first.mesh);
  onDesk.push(first);
  first.state = "desk";
  const s = deskSpots[0];
  first.mesh.position.set(s.x, s.y + 0.02, s.z);
  first.mesh.rotation.set(-Math.PI / 2, 0, 0.18);
}
const start = (new URLSearchParams(location.search).get("view") as View) || "hall";
goTo(start, true);
(window as unknown as { __proto3d: unknown }).__proto3d = { goTo, books, pull, toDesk, putBack, renderer };
document.body.dataset.ready = "1";
