import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { CELLS_PER_ATLAS, StackChunk, hash, type ShelfBook } from "./stacks";
import { bustOnColumn, framedPainting, globe, pictureTexture, plant, urnOnPedestal, type PaintingKind } from "./decor";
import { boardNoteTexture, corkTexture, dustTexture, floorTexture, pagesTexture, type NoteLine, plaqueTexture, plasterTexture, slipTexture, spineTexture, woodTexture, type SpineStyle } from "./textures";

/*
 * The 3D library room: stacks of the user's real books, a study desk and an
 * easel pinboard. Fixed camera spots with smooth flights between them; the
 * scene renders only while something moves (battery friendly). The DOM
 * around it (bars, panels) lives in HomeView.
 */

export interface WorldBook {
  id: string;
  title: string;
  subtitle: string;
  pages: number;
  color: string;
  cloth: boolean;
  ribbon: boolean;
  favorite: boolean;
  /** In cold storage: frosted spine. */
  cold?: boolean;
  cover: () => Promise<Blob | undefined>;
}
export interface WorldTier {
  name: string;
  books: WorldBook[];
}
export interface WorldStack {
  /** Category id (null = not shelved yet). */
  id: string | null;
  name: string;
  tiers: WorldTier[];
}
export type WorldView = { kind: "hall" } | { kind: "desk" } | { kind: "board" } | { kind: "stack"; index: number };

export type NoteKey = "today" | "week" | "goals" | "events";
export interface BoardNote {
  key: NoteKey;
  title: string;
  lines: NoteLine[];
  more: number;
  /** Red pin (something close or overdue). */
  alert: boolean;
}

export interface DeskEntry {
  id: string;
  /** 0 clean … 1 very dusty. */
  dust: number;
}

export interface WorldEvents {
  onView: (v: WorldView) => void;
  /** A book was pulled out of (or put back on) a shelf. */
  onPulled: (b: WorldBook | null) => void;
  /** Tapped the pinboard / desk from the hall (HomeView may intercept). */
  onZone?: (zone: "desk" | "board") => boolean;
  /** Tapped a book lying on the desk. */
  onDeskBook?: (id: string) => void;
  /** Tapped a note on the pinboard. */
  onNote?: (key: NoteKey) => void;
  /** Tapped a painting on the back wall (in the hall). */
  onPainting?: (index: number) => void;
}

interface Placed {
  data: WorldBook;
  shelf: ShelfBook;
  chunk: StackChunk;
  stack: THREE.Group;
  stackIndex: number;
  mesh: THREE.Mesh | null;
  /** On the desk: its gap on the shelf holds a paper slip. */
  slip: THREE.Mesh | null;
}

interface Spot {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

const SHELF_GAP = 0.42;
const STACK_W = 0.66;
const STACK_Z = -3.6;
/** Stack spacing: the aisle must hold the camera (1.75 m from the books) clear of the stack behind it. */
const STACK_DX = 2.6;
const STACK_X0 = 1.5;
/** Widest stretch of room the hall view frames (m). */
const HALL_SPAN_MAX = 16.5;
const BOOK_D = 0.2;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class LibraryWorld {
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 80);
  private target = new THREE.Vector3();
  private mat!: Record<string, THREE.MeshStandardMaterial>;
  private stacksGroup = new THREE.Group();
  private stackInfo: { x: number; L: number; H: number; group: THREE.Group }[] = [];
  private placed: Placed[] = [];
  private stacks: WorldStack[] = [];
  private pulled: Placed | null = null;
  private desk: DeskEntry[] = [];
  private notes = new Map<NoteKey, { mesh: THREE.Mesh; pin: THREE.Mesh; lines: string[] }>();
  private dustTex: THREE.Texture | null = null;
  private view: WorldView = { kind: "hall" };
  private along = 0;
  private anim: { from: Spot; to: Spot; t0: number; dur: number; path: THREE.CatmullRomCurve3 | null } | null = null;
  private reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private tweens: ((now: number) => boolean)[] = [];
  private running = false;
  private moving = false;
  private paused = false;
  private drag: { x: number; y: number; along: number; moved: boolean } | null = null;
  private ray = new THREE.Raycaster();
  private tmpV = new THREE.Vector3();
  private dprIdle = Math.min(window.devicePixelRatio || 1, 2);
  private dprMoving = Math.min(this.dprIdle, 1.1);
  private resizeObs: ResizeObserver;
  private roomRight = 8;
  private roomGroup = new THREE.Group();
  /** Paintings on the back wall: their canvas, the original texture, the user's picture if any. */
  private frames: { mesh: THREE.Mesh; original: THREE.Texture; aspect: number }[] = [];
  private pictures = new Map<number, ImageBitmap>();
  spineStyle: SpineStyle;

  constructor(
    private readonly events: WorldEvents,
    spineStyle: SpineStyle,
  ) {
    this.spineStyle = spineStyle;
    this.el = document.createElement("div");
    this.el.className = "world";
    this.el.dataset.testid = "world";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.dprIdle);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.el.append(this.renderer.domElement);
    this.scene.background = new THREE.Color("#1d140d");
    this.scene.fog = new THREE.Fog("#1d140d", 14, 30);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.35;
    this.scene.add(this.roomGroup, this.stacksGroup);
    this.makeMaterials();
    this.buildLights();
    this.buildDesk();
    this.buildBoard();
    const c = this.renderer.domElement;
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", () => (this.drag = null));
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.el);
  }

  // ------------------------------------------------------------ public API

  /** (Re)builds the shelves from the library. Keeps the current view. */
  setStacks(stacks: WorldStack[], desk: DeskEntry[] = this.desk): void {
    this.pulled = null;
    for (const p of this.placed) {
      this.dropMesh(p);
      p.slip = null; // disposed with its stack
    }
    this.placed = [];
    this.disposeGroup(this.stacksGroup);
    this.stackInfo = [];
    this.stacks = stacks;
    stacks.forEach((s, i) => this.buildStack(s, i));
    const lastX = this.stackInfo.length ? this.stackInfo[this.stackInfo.length - 1].x : STACK_X0;
    const right = Math.max(8, lastX + 2.2);
    if (right !== this.roomRight || !this.roomGroup.children.length) {
      this.roomRight = right;
      this.disposeGroup(this.roomGroup);
      this.buildRoom();
    }
    this.setDesk(desk);
    // keep a valid view
    if (this.view.kind === "stack" && this.view.index >= stacks.length) this.view = { kind: "hall" };
    this.goTo(this.view, true);
    this.renderer.shadowMap.needsUpdate = true;
    this.warmUp();
    this.events.onPulled(null);
  }

  get currentView(): WorldView {
    return this.view;
  }

  stackCount(): number {
    return this.stacks.length;
  }

  stackAt(i: number): WorldStack | null {
    return this.stacks[i] ?? null;
  }

  goTo(v: WorldView, instant = false): void {
    if (v.kind === "stack" && v.index !== (this.view.kind === "stack" ? this.view.index : -1)) this.along = 0;
    if (this.pulled && !(v.kind === "stack" && this.view.kind === "stack" && v.index === this.view.index)) this.putBack();
    const to = this.spotFor(v);
    const prev = this.view;
    this.view = v;
    if (instant || this.reduceMotion) {
      this.camera.position.copy(to.pos);
      this.target.copy(to.look);
      this.camera.fov = to.fov;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.target);
    } else {
      const from = { pos: this.camera.position.clone(), look: this.target.clone(), fov: this.camera.fov };
      const path = this.walkway(from.pos, prev, to.pos, v);
      const len = path ? path.getLength() : from.pos.distanceTo(to.pos);
      // walking pace: longer trips take longer, but never drag
      const dur = THREE.MathUtils.clamp(650 + len * 170, 800, 1900);
      this.anim = { from, to, t0: performance.now(), dur, path };
    }
    this.events.onView(v);
    this.kick();
  }

  /** Puts the pulled-out book back in its place. */
  putBack(): void {
    const p = this.pulled;
    if (!p) return;
    this.pulled = null;
    const m = this.bookMesh(p);
    const home = p.stack.localToWorld(p.shelf.pos.clone());
    this.tween(m, home, new THREE.Quaternion(), 650, () => {
      p.chunk.setVisible(p.shelf, true);
      this.dropMesh(p);
      this.renderer.shadowMap.needsUpdate = true;
    });
    this.events.onPulled(null);
  }

  /** For tests and the "open book" button. */
  pullById(id: string): boolean {
    const p = this.placed.find((x) => x.data.id === id);
    if (!p) return false;
    if (this.view.kind !== "stack" || this.view.index !== p.stackIndex) this.goTo({ kind: "stack", index: p.stackIndex }, true);
    this.focusOn(p);
    this.pull(p);
    return true;
  }

  /** Ids of the books lying on the desk (tests/diagnostics). */
  get deskIds(): string[] {
    return this.desk.map((d) => d.id);
  }

  /** Is the book's own spine on its shelf (not taken out)? */
  onShelf(id: string): boolean {
    const p = this.placed.find((x) => x.data.id === id);
    return !!p && !p.mesh && !p.slip;
  }

  /** Nothing is moving (camera flight, books). */
  get idle(): boolean {
    return !this.anim && this.tweens.length === 0;
  }

  get pulledBook(): WorldBook | null {
    return this.pulled?.data ?? null;
  }

  // ------------------------------------------------------------ the desk

  /** Lays the desk out: those books leave a slip in their gap and lie on the desk. */
  setDesk(entries: DeskEntry[]): void {
    this.desk = entries.filter((e) => this.placed.some((p) => p.data.id === e.id));
    for (const p of this.placed) {
      const i = this.desk.findIndex((e) => e.id === p.data.id);
      if (i < 0) {
        if (p.slip) this.dropSlip(p);
        if (p.mesh && p !== this.pulled) {
          p.chunk.setVisible(p.shelf, true);
          this.dropMesh(p);
        }
        continue;
      }
      p.chunk.setVisible(p.shelf, false);
      this.addSlip(p);
      const m = this.bookMesh(p);
      const { pos, quat } = this.deskPose(i, p);
      m.position.copy(pos);
      m.quaternion.copy(quat);
      this.setDust(m, p, this.desk[i].dust);
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.kick();
  }

  /** The pulled-out book goes to the desk (next free place). Resolves when it has landed. */
  moveToDesk(id: string, dust = 0): Promise<void> {
    const p = this.placed.find((x) => x.data.id === id);
    if (!p) return Promise.resolve();
    if (this.pulled === p) this.pulled = null;
    this.events.onPulled(null);
    if (!this.desk.some((e) => e.id === id)) this.desk.push({ id, dust });
    const i = this.desk.findIndex((e) => e.id === id);
    p.chunk.setVisible(p.shelf, false);
    this.addSlip(p);
    const m = this.bookMesh(p);
    const { pos, quat } = this.deskPose(i, p);
    return new Promise((resolve) =>
      this.tween(m, pos, quat, 1000, () => {
        this.renderer.shadowMap.needsUpdate = true;
        resolve();
      }),
    );
  }

  /** A desk book flies back into its gap on the shelf. */
  returnFromDesk(id: string): Promise<void> {
    const p = this.placed.find((x) => x.data.id === id);
    this.desk = this.desk.filter((e) => e.id !== id);
    if (!p) return Promise.resolve();
    const m = this.bookMesh(p);
    this.setDust(m, p, 0);
    const home = p.stack.localToWorld(p.shelf.pos.clone());
    return new Promise((resolve) =>
      this.tween(m, home, new THREE.Quaternion(), 1100, () => {
        p.chunk.setVisible(p.shelf, true);
        this.dropSlip(p);
        this.dropMesh(p);
        this.renderer.shadowMap.needsUpdate = true;
        resolve();
      }),
    );
  }

  private deskPose(i: number, p: Placed): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    // two rows of three, a little askew like real books put down
    const spots = [[-0.6, 0.17], [-0.27, 0.19], [0.06, 0.16], [-0.55, -0.2], [-0.22, -0.18], [0.12, -0.21]];
    const [x, z] = spots[i % spots.length];
    const tilt = [0.12, -0.08, 0.05, -0.1, 0.09, -0.04][i % 6];
    const pos = new THREE.Vector3(this.DESK.x + x, 0.788 + p.shelf.t / 2, this.DESK.z + z);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, tilt));
    return { pos, quat };
  }

  private addSlip(p: Placed): void {
    if (p.slip) return;
    const sb = p.shelf;
    const slip = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.03, sb.t * 0.9), sb.h * 0.55), new THREE.MeshStandardMaterial({ map: slipTexture("Trên bàn học"), roughness: 0.9 }));
    slip.rotation.y = -Math.PI / 2;
    const at = sb.pos.clone();
    at.x = -STACK_W / 2 + 0.03;
    at.y = sb.pos.y - sb.h / 2 + (sb.h * 0.55) / 2 + 0.005;
    slip.position.copy(at);
    slip.rotation.x = 0.06;
    p.stack.add(slip);
    p.slip = slip;
  }

  private dropSlip(p: Placed): void {
    if (!p.slip) return;
    p.stack.remove(p.slip);
    p.slip.geometry.dispose();
    const m = p.slip.material as THREE.MeshStandardMaterial;
    m.map?.dispose();
    m.dispose();
    p.slip = null;
  }

  private setDust(m: THREE.Mesh, p: Placed, level: number): void {
    let dust = m.getObjectByName("dust") as THREE.Mesh | undefined;
    if (level <= 0) {
      if (dust) {
        m.remove(dust);
        dust.geometry.dispose();
        (dust.material as THREE.Material).dispose();
      }
      return;
    }
    this.dustTex ??= dustTexture();
    if (!dust) {
      dust = new THREE.Mesh(new THREE.PlaneGeometry(p.shelf.d, p.shelf.h), new THREE.MeshStandardMaterial({ map: this.dustTex, transparent: true, depthWrite: false, roughness: 1 }));
      dust.name = "dust";
      dust.position.z = p.shelf.t / 2 + 0.0008; // just over the cover
      m.add(dust);
    }
    (dust.material as THREE.MeshStandardMaterial).opacity = 0.35 + level * 0.6;
  }

  // ------------------------------------------------------------ the pinboard

  /** Writes the planner onto the four notes. */
  setBoard(notes: BoardNote[]): void {
    for (const n of notes) {
      const slot = this.notes.get(n.key);
      if (!slot) continue;
      const m = slot.mesh.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.map = boardNoteTexture(n.title, n.lines, slot.mesh.userData.paper as string, n.more);
      m.color.set("#ffffff");
      m.needsUpdate = true;
      (slot.pin.material as THREE.MeshStandardMaterial).color.set(n.alert ? "#a2261c" : "#c49a4a");
      slot.lines = n.lines.map((l) => l.text);
    }
    this.kick();
  }

  /** What a note shows (tests). */
  noteLines(key: NoteKey): string[] {
    return this.notes.get(key)?.lines ?? [];
  }

  /** Screen point of a note's centre (tests). */
  noteScreenPoint(key: NoteKey): { x: number; y: number } | null {
    const n = this.notes.get(key);
    if (!n) return null;
    const w = n.mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((w.x + 1) / 2) * r.width, y: r.top + ((1 - w.y) / 2) * r.height };
  }

  /** Stop drawing (another screen is shown). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.resize();
  }

  setSpineStyle(style: SpineStyle): void {
    this.spineStyle = style;
    this.setStacks(this.stacks);
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.disposeGroup(this.scene);
    this.renderer.dispose();
    this.el.remove();
  }

  /** Numbers for tests/diagnostics. */
  info(): { calls: number; textures: number; books: number } {
    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    return { calls: this.renderer.info.render.calls, textures: this.renderer.info.memory.textures, books: this.placed.length };
  }

  /** Camera position and the stacks' footprints (tests: flights never cut through a bookcase). */
  layout(): { cam: [number, number, number]; look: [number, number, number]; stacks: { x0: number; x1: number; z0: number; z1: number }[] } {
    const c = this.camera.position;
    const t = this.target;
    return {
      cam: [c.x, c.y, c.z],
      look: [t.x, t.y, t.z],
      stacks: this.stackInfo.map((s) => ({ x0: s.x - STACK_W / 2, x1: s.x + STACK_W / 2, z0: STACK_Z - s.L / 2, z1: STACK_Z + s.L / 2 })),
    };
  }

  /** Number of frames on the wall (some hide in a small room). */
  get paintingSlots(): number[] {
    return this.frames.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  }

  /** Puts the user's picture in a frame (null: back to the original painting). */
  setPicture(i: number, img: ImageBitmap | null): void {
    const old = this.pictures.get(i);
    if (old && old !== img) old.close();
    if (img) this.pictures.set(i, img);
    else this.pictures.delete(i);
    const f = this.frames[i];
    if (!f) return;
    const mat = f.mesh.material as THREE.MeshStandardMaterial;
    if (img) this.applyPicture(i, img);
    else if (mat.map !== f.original) {
      mat.map?.dispose();
      mat.map = f.original;
      mat.needsUpdate = true;
    }
    this.kick();
  }

  private applyPicture(i: number, img: ImageBitmap): void {
    const f = this.frames[i];
    const mat = f.mesh.material as THREE.MeshStandardMaterial;
    if (mat.map && mat.map !== f.original) mat.map.dispose();
    mat.map = pictureTexture(img, f.aspect);
    mat.needsUpdate = true;
  }

  /** "custom" or "original" (tests). */
  pictureState(i: number): string {
    const f = this.frames[i];
    return f && (f.mesh.material as THREE.MeshStandardMaterial).map !== f.original ? "custom" : "original";
  }

  /** Screen position of a painting's centre (tests). */
  paintingScreenPoint(i: number): { x: number; y: number } | null {
    const f = this.frames[i];
    if (!f) return null;
    const v = f.mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** What a tap at a client point would hit (diagnostics). */
  probe(x: number, y: number): string[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
    return this.ray.intersectObjects(this.scene.children, true).slice(0, 5).map((h) => `${h.object.type}:${h.object.userData.chunk ? "chunk" : h.object.name || (h.object as THREE.Mesh).geometry?.type}@${h.distance.toFixed(2)} f${h.faceIndex}`);
  }

  /** Screen position of a book's spine (for tests). */
  spineScreenPoint(id: string): { x: number; y: number } | null {
    const p = this.placed.find((x) => x.data.id === id);
    if (!p) return null;
    const w = p.stack.localToWorld(p.shelf.pos.clone().add(new THREE.Vector3(-BOOK_D / 2, 0, 0)));
    w.project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((w.x + 1) / 2) * r.width, y: r.top + ((1 - w.y) / 2) * r.height };
  }

  // ------------------------------------------------------------ building

  private makeMaterials(): void {
    this.mat = {
      walnut: new THREE.MeshStandardMaterial({ map: woodTexture("#4a2e1a", 3), roughness: 0.62 }),
      walnutDark: new THREE.MeshStandardMaterial({ map: woodTexture("#33200f", 9), roughness: 0.68 }),
      oak: new THREE.MeshStandardMaterial({ map: woodTexture("#7a5233", 21), roughness: 0.55 }),
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
    for (const m of Object.values(this.mat)) m.userData.shared = true;
  }

  private box(w: number, h: number, d: number, m: THREE.Material | THREE.Material[], round = 0): THREE.Mesh {
    const g = round ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildRoom(): void {
    const R = this.roomRight;
    const L = -7;
    const W = R - L;
    const cx = (R + L) / 2;
    const g = this.roomGroup;
    const mat = this.mat;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, 14), mat.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, -2);
    floor.receiveShadow = true;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, 4.2), mat.plaster);
    back.position.set(cx, 2.1, -8);
    back.receiveShadow = true;
    const left = new THREE.Mesh(new THREE.PlaneGeometry(14, 4.2), mat.plaster);
    left.rotation.y = Math.PI / 2;
    left.position.set(L, 2.1, -2);
    left.receiveShadow = true;
    const right = new THREE.Mesh(new THREE.PlaneGeometry(14, 4.2), mat.plaster);
    right.rotation.y = -Math.PI / 2;
    right.position.set(R, 2.1, -2);
    g.add(floor, back, left, right);
    const wb = this.box(W, 1.0, 0.06, mat.wainscot);
    wb.position.set(cx, 0.5, -7.97);
    const wl = this.box(0.06, 1.0, 14, mat.wainscot);
    wl.position.set(L + 0.03, 0.5, -2);
    const wr = this.box(0.06, 1.0, 14, mat.wainscot);
    wr.position.set(R - 0.03, 0.5, -2);
    g.add(wb, wl, wr);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, 14), mat.walnutDark);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, 4.2, -2);
    g.add(ceil);
    for (let z = -7.5; z <= 3.5; z += 1.6) {
      const beam = this.box(W, 0.22, 0.18, mat.walnut);
      beam.position.set(cx, 4.09, z);
      g.add(beam);
    }
    // window on the left wall
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), mat.windowGlow);
    win.rotation.y = Math.PI / 2;
    win.position.set(L + 0.05, 2.3, -4.6);
    g.add(win);
    for (const [y, h] of [[1.18, 0.08], [3.42, 0.08], [2.3, 0.05]] as const) {
      const f = this.box(0.08, h, 1.56, mat.walnutDark);
      f.position.set(L + 0.1, y, -4.6);
      g.add(f);
    }
    for (const z of [-5.36, -3.84, -4.6]) {
      const f = this.box(0.08, 2.3, z === -4.6 ? 0.05 : 0.08, mat.walnutDark);
      f.position.set(L + 0.1, 2.3, z);
      g.add(f);
    }
    // back wall: paintings in gilt frames, plants, a bust, an urn and a globe
    const gold = new THREE.MeshStandardMaterial({ color: "#c9a14e", metalness: 0.85, roughness: 0.38 });
    gold.userData.shared = false;
    const paintings: [PaintingKind, number, number, number][] = [
      ["sunset", -4.6, 1.5, 1.1],
      ["starry", -1.7, 1.7, 1.25],
      ["windmill", 1.3, 1.5, 1.1],
      ["sailboat", 4.1, 1.4, 1.05],
      ["poppies", 6.9, 1.4, 1.05],
    ];
    this.frames = [];
    paintings.forEach(([kind, x, w, h], i) => {
      if (x > R - 1.2) return;
      const p = framedPainting(kind, 100 + i * 17, w, h, gold);
      p.position.set(x, 2.35, -7.98);
      p.userData.painting = i;
      g.add(p);
      const mesh = p.getObjectByName("canvas") as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      this.frames[i] = { mesh, original: mat.map!, aspect: w / h };
      const pic = this.pictures.get(i);
      if (pic) this.applyPicture(i, pic);
    });
    const plants: ["fig" | "palm", number][] = [["fig", -6.2], ["palm", 0.0], ["fig", 5.5]];
    plants.forEach(([kind, x], i) => {
      if (x > R - 0.6) return;
      const pl = plant(kind, 7 + i);
      pl.position.set(x, 0, -7.55);
      g.add(pl);
    });
    const bust = bustOnColumn();
    bust.position.set(-3.15, 0, -7.6);
    bust.rotation.y = 0.15;
    const urn = urnOnPedestal();
    urn.position.set(2.75, 0, -7.6);
    g.add(bust, urn);
    // a palm and a globe near the window corner
    const palm2 = plant("palm", 21);
    palm2.position.set(L + 0.7, 0, -6.6);
    const gl = globe(mat.walnut, mat.brass);
    gl.position.set(L + 1.0, 0, -1.3);
    g.add(palm2, gl);
    // pendant lamps
    for (const [x, z] of [[-1.4, -2.9], [STACK_X0 + STACK_DX / 2, -3.6]]) {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.2, 6), mat.walnutDark);
      cord.position.set(x, 3.6, z);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.24, 0.18, 24, 1, true), mat.brass);
      shade.position.set(x, 2.95, z);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), mat.bulb);
      bulb.position.set(x, 2.9, z);
      g.add(cord, shade, bulb);
    }
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.2), new THREE.MeshStandardMaterial({ color: "#5a2a22", roughness: 1, map: this.mat.cork.map }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-1.4, 0.005, -2.6);
    rug.receiveShadow = true;
    g.add(rug);
  }

  private lampLight = new THREE.SpotLight("#ffcf86", 11, 6, Math.PI / 3.0, 0.8, 1.6);
  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight("#ffe7c2", "#2a1a0e", 0.45));
    const sun = new THREE.DirectionalLight("#cfdcea", 1.3);
    sun.position.set(-9, 5, -4);
    sun.target.position.set(0, 0, -2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -8, right: 12, top: 6, bottom: -4 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target);
    const fill = new THREE.PointLight("#ffd59a", 9, 12, 1.6);
    fill.position.set(3.4, 3.3, -3.0);
    this.scene.add(fill);
  }

  private readonly DESK = new THREE.Vector3(-1.4, 0, -2.9);
  private buildDesk(): void {
    const g = new THREE.Group();
    const mat = this.mat;
    g.position.copy(this.DESK);
    g.userData.zone = "desk";
    const top = this.box(1.6, 0.05, 0.82, mat.oak, 0.01);
    top.position.y = 0.76;
    const apron = this.box(1.5, 0.12, 0.74, mat.walnut);
    apron.position.y = 0.675;
    g.add(top, apron);
    for (const [x, z] of [[-0.74, -0.36], [0.74, -0.36], [-0.74, 0.36], [0.74, 0.36]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.02, 0.74, 12), mat.walnut);
      leg.position.set(x, 0.37, z);
      leg.castShadow = leg.receiveShadow = true;
      g.add(leg);
    }
    const blot = this.box(0.7, 0.006, 0.45, new THREE.MeshStandardMaterial({ color: "#3d1c14", roughness: 0.8 }), 0.002);
    blot.position.set(0.05, 0.788, 0.08);
    g.add(blot);
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
    const D = this.DESK;
    this.lampLight.position.set(D.x + 0.48, 1.12, D.z - 0.19);
    this.lampLight.target.position.set(D.x - 0.1, 0.78, D.z + 0.1);
    this.lampLight.castShadow = true;
    this.lampLight.shadow.mapSize.set(1024, 1024);
    this.lampLight.shadow.bias = -0.0006;
    this.scene.add(this.lampLight, this.lampLight.target);
    const ink = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.05, 16), new THREE.MeshStandardMaterial({ color: "#10161c", roughness: 0.1, metalness: 0.2 }));
    ink.position.set(-0.55, 0.81, -0.22);
    ink.castShadow = true;
    g.add(ink);
    const chair = new THREE.Group();
    chair.position.set(0, 0, 0.72);
    const seat = this.box(0.48, 0.05, 0.46, mat.leather, 0.015);
    seat.position.y = 0.47;
    chair.add(seat);
    for (const [x, z] of [[-0.21, -0.2], [0.21, -0.2], [-0.21, 0.2], [0.21, 0.2]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.018, 0.46, 10), mat.walnut);
      leg.position.set(x, 0.23, z);
      leg.castShadow = true;
      chair.add(leg);
    }
    const backrest = this.box(0.46, 0.42, 0.04, mat.leather, 0.015);
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
    this.scene.add(g);
  }

  private buildBoard(): void {
    const g = new THREE.Group();
    const mat = this.mat;
    g.position.set(-4.4, 0, -3.0);
    g.rotation.y = 0.45;
    g.userData.zone = "board";
    const tilt = new THREE.Group();
    tilt.position.set(0, 1.45, 0.09);
    tilt.rotation.x = -0.12;
    tilt.add(this.box(1.3, 0.95, 0.03, mat.cork));
    for (const [x, y, w, h] of [[0, 0.5, 1.42, 0.06], [0, -0.5, 1.42, 0.06], [-0.68, 0, 0.06, 1.06], [0.68, 0, 0.06, 1.06]]) {
      const f = this.box(w, h, 0.06, mat.walnut);
      f.position.set(x, y, 0.01);
      tilt.add(f);
    }
    // four notes; their content comes from the planner (setBoard)
    const layout: [NoteKey, number, number, number, string][] = [
      ["today", -0.33, 0.2, -0.035, "#fbf5e2"],
      ["events", 0.33, 0.2, 0.03, "#fbf5e2"],
      ["week", -0.33, -0.24, 0.025, "#fbf5e2"],
      ["goals", 0.33, -0.24, -0.03, "#f3e1b0"],
    ];
    for (const [key, x, y, rz, paper] of layout) {
      const n = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.455), new THREE.MeshStandardMaterial({ roughness: 0.9, color: paper }));
      n.position.set(x, y, 0.02);
      n.rotation.z = rz;
      n.castShadow = true;
      n.userData.note = key;
      n.userData.paper = paper;
      tilt.add(n);
      const pin = new THREE.Mesh(new THREE.SphereGeometry(0.018, 14, 10), new THREE.MeshStandardMaterial({ color: "#c49a4a", roughness: 0.3, metalness: 0.3 }));
      pin.position.set(x, y + 0.2, 0.04);
      tilt.add(pin);
      this.notes.set(key, { mesh: n, pin, lines: [] });
    }
    g.add(tilt);
    const leg = (x: number, z: number, rx: number, rz: number, len: number) => {
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, len, 10), mat.walnut);
      l.position.set(x, (len / 2) * Math.cos(rx) - 0.02, z);
      l.rotation.set(rx, 0, rz);
      l.castShadow = true;
      g.add(l);
    };
    leg(-0.45, -0.02, -0.08, 0.12, 2.05);
    leg(0.45, -0.02, -0.08, -0.12, 2.05);
    leg(0, -0.45, 0.32, 0, 2.0);
    const ledge = this.box(1.4, 0.04, 0.12, mat.walnut);
    ledge.position.set(0, 0.95, 0.14);
    g.add(ledge);
    this.scene.add(g);
  }

  /** One stack per top-level shelf; one tier (shelf board) per sub-shelf. */
  private buildStack(s: WorldStack, si: number): void {
    const mat = this.mat;
    // Every stack has 4 equal tiers. Up to 4 sub-shelves get a tier each;
    // with more, each group goes onto the emptiest tier, after a labelled gap.
    const TIERS = 4;
    const tiers: { width: number; segs: { label: string; start: number; books: WorldBook[] }[] }[] = Array.from({ length: TIERS }, () => ({ width: 0, segs: [] }));
    s.tiers.forEach((grp, gi) => {
      const tier = s.tiers.length <= TIERS ? tiers[gi] : tiers.reduce((m, t) => (t.width < m.width ? t : m), tiers[0]);
      const start = tier.width ? tier.width + 0.14 : 0;
      const w = grp.books.reduce((sum, b) => sum + thickness(b) + 0.003, 0);
      tier.segs.push({ label: grp.name, start, books: grp.books });
      tier.width = start + Math.max(w, 0.36); // room for the label even when empty
    });
    const L = Math.max(2.4, Math.max(...tiers.map((t) => t.width)) + 0.24);
    const H = TIERS * SHELF_GAP + 0.2;
    const W = STACK_W;
    const x = STACK_X0 + si * STACK_DX;
    const g = new THREE.Group();
    g.position.set(x, 0, STACK_Z);
    g.userData.zone = `stack:${si}`;
    for (const z of [-L / 2, L / 2]) {
      const end = this.box(W + 0.04, H, 0.05, mat.walnut);
      end.position.set(0, H / 2, z);
      g.add(end);
    }
    const mid = this.box(0.025, H - 0.1, L, mat.walnutDark);
    mid.position.set(0, H / 2, 0);
    const top = this.box(W + 0.1, 0.06, L + 0.1, mat.walnut);
    top.position.set(0, H + 0.03, 0);
    const crown = this.box(W + 0.16, 0.05, L + 0.16, mat.walnutDark);
    crown.position.set(0, H + 0.085, 0);
    const plinth = this.box(W + 0.02, 0.09, L, mat.walnutDark);
    plinth.position.set(0, 0.045, 0);
    g.add(mid, top, crown, plinth);
    const shelfYs = tiers.map((_, i) => 0.1 + i * SHELF_GAP);
    for (const y of [...shelfYs, TIERS * SHELF_GAP + 0.1]) {
      const sh = this.box(W, 0.03, L - 0.05, mat.walnut);
      sh.position.set(0, y, 0);
      g.add(sh);
    }
    const plaqueMat = new THREE.MeshStandardMaterial({ map: plaqueTexture(s.name), metalness: 0.75, roughness: 0.35 });
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.155), plaqueMat);
    plaque.position.set(0, H - 0.25, L / 2 + 0.027);
    g.add(plaque);
    // books on the LEFT face; a brass label on the shelf edge where each group starts
    const shelfBooks: ShelfBook[] = [];
    const data: WorldBook[] = [];
    tiers.forEach((tier, ti) => {
      const shelfTop = shelfYs[ti] + 0.015;
      for (const seg of tier.segs) {
        const z0 = -L / 2 + 0.06 + seg.start;
        if (seg.label) {
          const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.075), new THREE.MeshStandardMaterial({ map: plaqueTexture(seg.label), metalness: 0.7, roughness: 0.35 }));
          lab.rotation.y = -Math.PI / 2;
          // on the shelf edge, proud of the plinth so the bottom one shows too
          lab.position.set(-W / 2 - 0.018, shelfYs[ti] + (ti === 0 ? 0.02 : -0.005), Math.min(L / 2 - 0.25, z0 + 0.21));
          lab.scale.set(1, 0.72, 1);
          g.add(lab);
        }
        let z = z0;
        for (const b of seg.books) {
          const t = thickness(b);
          const seed = hash(b.id);
          const h = 0.26 + (((seed >>> 10) % 100) / 100) * 0.09;
          shelfBooks.push({
            id: b.id,
            title: b.title,
            author: b.subtitle,
            color: b.color,
            cloth: b.cloth,
            d: BOOK_D,
            h,
            t,
            pos: new THREE.Vector3(-(W / 2 - BOOK_D / 2 - 0.015), shelfTop + h / 2, z + t / 2),
            ribbon: b.ribbon,
            favorite: b.favorite,
            cold: b.cold,
          });
          data.push(b);
          z += t + 0.003;
        }
      }
    });
    for (let i = 0; i < shelfBooks.length; i += CELLS_PER_ATLAS) {
      const chunk = new StackChunk(shelfBooks.slice(i, i + CELLS_PER_ATLAS), this.spineStyle, this.renderer);
      g.add(chunk.mesh);
      chunk.books.forEach((sb, k) => this.placed.push({ data: data[i + k], shelf: sb, chunk, stack: g, stackIndex: si, mesh: null, slip: null }));
    }
    this.stacksGroup.add(g);
    this.stackInfo.push({ x, L, H, group: g });
  }

  // ------------------------------------------------------------ camera

  private spotFor(v: WorldView): Spot {
    if (v.kind === "desk") return { pos: new THREE.Vector3(-1.4, 1.55, -1.75), look: new THREE.Vector3(-1.4, 0.78, -2.95), fov: 48 };
    if (v.kind === "board") return { pos: new THREE.Vector3(-3.78, 1.44, -1.72), look: new THREE.Vector3(-4.4, 1.4, -3.0), fov: 46 };
    if (v.kind === "stack") {
      const s = this.stackInfo[v.index];
      if (s) {
        const x = s.x - STACK_W / 2;
        // far enough to see all 4 tiers at once
        return { pos: new THREE.Vector3(x - 1.75, 0.98, STACK_Z + this.along), look: new THREE.Vector3(x, 0.95, STACK_Z + this.along), fov: 58 };
      }
    }
    // hall: frame the desk, the board and the stacks, but never so far that it all
    // shrinks to a strip (12 stacks would be 22 m away): beyond ~5 stacks the
    // hall shows the first ones and the strip below reaches the rest
    const right = this.stackInfo.length ? this.stackInfo[this.stackInfo.length - 1].x + 0.6 : 4.7;
    const span = Math.min(right + 4.8, HALL_SPAN_MAX);
    const cx = -4.8 + span / 2;
    const dist = Math.max(4.6, span * 0.62);
    return { pos: new THREE.Vector3(cx, 2.35, -3.2 + dist + 2.2), look: new THREE.Vector3(cx, 1.0, -3.2), fov: 50 };
  }

  /**
   * Flights in and out of an aisle go through the walkway in front of the
   * stacks (like walking), never through a bookcase.
   */
  private walkway(a: THREE.Vector3, va: WorldView, b: THREE.Vector3, vb: WorldView): THREE.CatmullRomCurve3 | null {
    const inA = va.kind === "stack";
    const inB = vb.kind === "stack";
    if (!inA && !inB) return null;
    if (inA && inB && va.index === vb.index) return null;
    const front = this.frontZ();
    const pts = [a.clone()];
    if (inA) pts.push(new THREE.Vector3(a.x, 1.25, front));
    if (inB) pts.push(new THREE.Vector3(b.x, 1.25, front));
    pts.push(b.clone());
    return new THREE.CatmullRomCurve3(pts, false, "centripetal");
  }

  private frontZ(): number {
    let z = STACK_Z + 1.2;
    for (const s of this.stackInfo) z = Math.max(z, STACK_Z + s.L / 2);
    return z + 0.85;
  }

  private focusOn(p: Placed): void {
    const s = this.stackInfo[p.stackIndex];
    const lim = this.alongLimit(s.L);
    this.along = THREE.MathUtils.clamp(p.shelf.pos.z, -lim, lim);

    const to = this.spotFor(this.view);
    this.camera.position.copy(to.pos);
    this.target.copy(to.look);
    this.camera.lookAt(this.target);
  }

  /** How far the view may slide along a stack (the view is ~3 m wide). */
  private alongLimit(L: number): number {
    return Math.max(0, L / 2 - 1.3);
  }

  // ------------------------------------------------------------ books out of the shelf

  private bookMesh(p: Placed): THREE.Mesh {
    if (p.mesh) return p.mesh;
    const sb = p.shelf;
    const spine = new THREE.MeshStandardMaterial({ map: spineTexture(sb.title, sb.color, hash(sb.id), this.spineStyle, sb.cloth, !!sb.cold), roughness: 0.5 });
    const cover = new THREE.MeshStandardMaterial({ color: sb.color, roughness: 0.5 });
    const plain = new THREE.MeshStandardMaterial({ color: sb.color, roughness: 0.55 });
    // faces: +x, -x (spine), +y, -y, +z (cover), -z
    const m = this.box(sb.d, sb.h, sb.t, [this.mat.pages, spine, this.mat.pages, this.mat.pages, cover, plain]);
    m.position.copy(p.stack.localToWorld(sb.pos.clone()));
    m.userData.placed = p;
    this.scene.add(m);
    p.mesh = m;
    // the real cover image of the file
    void p.data.cover().then(async (blob) => {
      if (!blob || p.mesh !== m) return;
      const bmp = await createImageBitmap(blob);
      const t = new THREE.Texture(bmp);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      // ImageBitmaps are not flipped on upload (flipY is ignored): flip v here
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.y = -1;
      t.offset.y = 1;
      t.needsUpdate = true;
      cover.map = t;
      cover.color.set("#ffffff");
      cover.needsUpdate = true;
      this.kick();
    });
    return m;
  }

  private dropMesh(p: Placed): void {
    if (!p.mesh) return;
    const dust = p.mesh.getObjectByName("dust") as THREE.Mesh | undefined;
    if (dust) {
      dust.geometry.dispose();
      (dust.material as THREE.Material).dispose();
    }
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    for (const m of p.mesh.material as THREE.MeshStandardMaterial[]) {
      if (m.userData.shared) continue;
      m.map?.dispose();
      m.dispose();
    }
    p.mesh = null;
  }

  private pull(p: Placed): void {
    if (this.pulled && this.pulled !== p) this.putBack();
    this.pulled = p;
    const m = this.bookMesh(p);
    p.chunk.setVisible(p.shelf, false);
    const dir = new THREE.Vector3().subVectors(this.target, this.camera.position).normalize();
    const pos = this.camera.position.clone().add(dir.multiplyScalar(0.55));
    pos.y -= 0.02;
    // a little to the left so the panel on the right does not cover it
    pos.add(new THREE.Vector3(0, 0, -0.08));
    const o = new THREE.Object3D();
    o.position.copy(pos);
    o.lookAt(this.camera.position);
    this.tween(m, pos, o.quaternion, 700, () => (this.renderer.shadowMap.needsUpdate = true));
    this.events.onPulled(p.data);
  }

  private tween(o: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion, dur: number, done?: () => void): void {
    const p0 = o.position.clone();
    const q0 = o.quaternion.clone();
    const t0 = performance.now();
    this.tweens.push((now) => {
      const k = THREE.MathUtils.clamp((now - t0) / dur, 0, 1);
      const e = ease(k);
      o.position.lerpVectors(p0, pos, e);
      o.position.y += Math.sin(e * Math.PI) * 0.05;
      o.quaternion.slerpQuaternions(q0, quat, e);
      if (k >= 1) done?.();
      return k < 1;
    });
    this.kick();
  }

  // ------------------------------------------------------------ input

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, y: e.clientY, along: this.along, moved: false };
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 6 || Math.abs(e.clientY - d.y) > 6) d.moved = true;
    if (d.moved && this.view.kind === "stack" && !this.anim) {
      const s = this.stackInfo[this.view.index];
      const lim = this.alongLimit(s.L);
      // the shelf follows the finger
      this.along = THREE.MathUtils.clamp(d.along - dx * 0.0055, -lim, lim);

      const to = this.spotFor(this.view);
      this.camera.position.copy(to.pos);
      this.target.copy(to.look);
      this.kick();
    }
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hits = this.ray.intersectObjects(this.scene.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      const chunk = o.userData.chunk as StackChunk | undefined;
      if (chunk && h.faceIndex != null && this.view.kind === "stack") {
        const sb = chunk.bookAtFace(h.faceIndex);
        const p = sb ? this.placed.find((x) => x.shelf === sb) : undefined;
        if (p) return this.pull(p);
      }
      if (o.userData.note && this.view.kind === "board") return this.events.onNote?.(o.userData.note as NoteKey);
      const placed = (o.userData.placed ?? o.parent?.userData.placed) as Placed | undefined;
      if (placed) {
        const onDesk = this.desk.some((d) => d.id === placed.data.id);
        if (onDesk && this.view.kind === "desk") this.events.onDeskBook?.(placed.data.id);
        else if (onDesk && this.view.kind === "hall") this.goTo({ kind: "desk" });
        return; // the pulled-out book itself
      }
      if (this.view.kind === "hall") {
        let q: THREE.Object3D | null = h.object;
        while (q && q.userData.painting == null) q = q.parent;
        if (q) return this.events.onPainting?.(q.userData.painting as number);
      }
      while (o && !o.userData.zone) o = o.parent;
      const zone = o?.userData.zone as string | undefined;
      if (zone && this.view.kind === "hall") {
        if (zone.startsWith("stack:")) return this.goTo({ kind: "stack", index: Number(zone.slice(6)) });
        if (zone === "desk" || zone === "board") {
          if (this.events.onZone?.(zone)) return;
          return this.goTo({ kind: zone });
        }
      }
      if (h.object.type === "Mesh") break;
    }
    // tap on empty space in an aisle: put the pulled book back
    if (this.pulled) this.putBack();
  };

  // ------------------------------------------------------------ rendering

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  private warmUp(): void {
    const keep = { pos: this.camera.position.clone(), look: this.target.clone(), fov: this.camera.fov };
    this.renderer.compile(this.scene, this.camera);
    const views: WorldView[] = [{ kind: "desk" }, { kind: "board" }, ...this.stackInfo.map((_, i) => ({ kind: "stack" as const, index: i }))];
    for (const v of views) {
      const s = this.spotFor(v);
      this.camera.position.copy(s.pos);
      this.camera.lookAt(s.look);
      this.renderer.render(this.scene, this.camera);
    }
    this.camera.position.copy(keep.pos);
    this.target.copy(keep.look);
    this.camera.fov = keep.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.target);
    this.kick();
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  private setMoving(m: boolean): void {
    if (m === this.moving) return;
    this.moving = m;
    this.renderer.setPixelRatio(m ? this.dprMoving : this.dprIdle);
    this.renderer.setSize(this.el.clientWidth, this.el.clientHeight);
  }

  private frame = (now: number): void => {
    if (this.paused || !this.el.isConnected) {
      this.running = false;
      return;
    }
    let busy = false;
    if (this.anim) {
      const a = this.anim;
      // the frame's timestamp can be a little older than the flight's start
      const k = THREE.MathUtils.clamp((now - a.t0) / a.dur, 0, 1);
      const e = ease(k);
      if (a.path) a.path.getPointAt(e, this.camera.position);
      else {
        this.camera.position.lerpVectors(a.from.pos, a.to.pos, e);
        this.camera.position.y += Math.sin(e * Math.PI) * 0.35;
      }
      this.target.lerpVectors(a.from.look, a.to.look, e);
      if (a.path) {
        // mid-walk, look where you are going, but only when that is roughly
        // ahead of you: stepping back out of an aisle must not spin the view round
        const ahead = a.path.getPointAt(THREE.MathUtils.clamp(e + 0.12, 0, 1), this.tmpV);
        ahead.y -= 0.15;
        const go = ahead.clone().sub(this.camera.position).setY(0);
        const view = this.target.clone().sub(this.camera.position).setY(0);
        const facing = go.lengthSq() > 1e-6 && view.lengthSq() > 1e-6 ? go.normalize().dot(view.normalize()) : 0;
        const w = Math.sin(e * Math.PI) * 0.6 * THREE.MathUtils.clamp(facing, 0, 1);
        if (w > 0) this.target.lerp(ahead.add(ahead.clone().sub(this.camera.position).multiplyScalar(2)), w);
      }
      this.camera.fov = THREE.MathUtils.lerp(a.from.fov, a.to.fov, e);
      this.camera.updateProjectionMatrix();
      if (k >= 1) this.anim = null;
      else busy = true;
    }
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      if (this.tweens[i](now)) busy = true;
      else this.tweens.splice(i, 1);
    }
    this.camera.lookAt(this.target);
    const keepGoing = busy || !!this.drag;
    if (keepGoing) this.setMoving(true);
    else if (this.moving) this.setMoving(false);
    this.renderer.render(this.scene, this.camera);
    if (keepGoing) requestAnimationFrame(this.frame);
    else this.running = false;
  };

  private disposeGroup(g: THREE.Object3D): void {
    const kids = [...g.children];
    for (const o of kids) {
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const ms = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of ms as THREE.MeshStandardMaterial[]) {
          if (mt.userData.shared) continue;
          if (mt.map && mt.map !== this.mat.cork.map) mt.map.dispose();
          mt.dispose();
        }
      });
      if (g !== this.scene) g.remove(o);
    }
  }
}

/** Spine thickness from the page count (a 650-page book ≈ 7 cm). */
export function thickness(b: WorldBook): number {
  const t = 0.012 + Math.min(b.pages, 900) * 0.00009;
  return Math.max(b.cloth ? 0.016 : 0.014, Math.min(0.075, t));
}
