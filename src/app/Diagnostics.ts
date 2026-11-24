/*
 * Stage 3 · v2.0 — what this browser on this device can do for the library,
 * measured on the device itself. Nothing here touches the books: the disk
 * test writes its own scratch file in its own folder and removes it.
 */

export interface DeviceInfo {
  browser: string;
  /** Running as an installed app (no browser bars). */
  standalone: boolean;
  /** The browser promised not to clear the library when space runs low. */
  persisted: boolean | null;
  /** What the browser reports (Chrome 133+ reports usage + 10 GiB as the quota: not free space). */
  usage: number | null;
  quota: number | null;
  /** Private file storage (where the books live). */
  opfs: boolean;
  /** Can keep the library in a folder you pick (stage 3 · v2.2). */
  folderPicker: boolean;
  fullscreen: boolean;
  memoryGB: number | null;
  cores: number | null;
}

export async function deviceInfo(): Promise<DeviceInfo> {
  const nav = navigator as Navigator & { brave?: { isBrave(): Promise<boolean> }; userAgentData?: { brands: { brand: string }[] }; deviceMemory?: number };
  let browser = "Không rõ";
  try {
    if (nav.brave && (await nav.brave.isBrave())) browser = "Brave";
  } catch {
    /* not Brave */
  }
  if (browser === "Không rõ") {
    const brands = nav.userAgentData?.brands.map((b) => b.brand) ?? [];
    const pick = ["Microsoft Edge", "Samsung Internet", "Opera", "Google Chrome", "Chromium"].find((b) => brands.includes(b));
    if (pick) browser = pick === "Chromium" ? "Chromium" : pick;
    else if (/Firefox\//.test(navigator.userAgent)) browser = "Firefox";
    else if (/Version\/.*Safari/.test(navigator.userAgent)) browser = "Safari";
    else if (/Chrome\//.test(navigator.userAgent)) browser = "Chrome";
  }
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  if (m && !browser.includes(m[1])) browser += ` (nền Chromium ${m[1]})`;
  let persisted: boolean | null = null;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
    const e = await navigator.storage?.estimate?.();
    usage = e?.usage ?? null;
    quota = e?.quota ?? null;
  } catch {
    /* not available */
  }
  return {
    browser,
    standalone: matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches,
    persisted,
    usage,
    quota,
    opfs: !!navigator.storage?.getDirectory,
    folderPicker: "showDirectoryPicker" in window,
    fullscreen: !!document.fullscreenEnabled,
    memoryGB: nav.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
  };
}

/** Asks the browser to keep the library through low space. */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

async function diagDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("diagnostics", { create: true });
}

/** Deterministic bytes for chunk i (so they can be checked without keeping them). */
function fillChunk(buf: Uint8Array, i: number): void {
  let x = (i + 1) * 0x9e3779b1;
  const w = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  for (let k = 0; k < w.length; k++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    w[k] = x >>> 0;
  }
}

export interface DiskTestResult {
  mb: number;
  writeMBps: number;
  readMBps: number;
  /** Every byte read back equals what was written. */
  ok: boolean;
  /** MB at which a difference was found. */
  badAtMB?: number;
  error?: string;
}

/** Writes `mb` MB to a scratch file, reads it back and compares every byte, then removes it. */
export async function diskTest(mb: number, onProgress: (phase: "write" | "read", fraction: number) => void, signal?: AbortSignal): Promise<DiskTestResult> {
  const CHUNK = 8 * 1024 * 1024;
  const n = Math.ceil((mb * 1024 * 1024) / CHUNK);
  const dir = await diagDir();
  const name = "rw-test.bin";
  const res: DiskTestResult = { mb: (n * CHUNK) / (1024 * 1024), writeMBps: 0, readMBps: 0, ok: false };
  const buf = new Uint8Array(CHUNK);
  try {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) {
        await w.abort();
        throw new Error("Đã dừng.");
      }
      fillChunk(buf, i);
      await w.write(buf);
      onProgress("write", (i + 1) / n);
    }
    await w.close();
    res.writeMBps = res.mb / ((performance.now() - t0) / 1000);
    const f = await h.getFile();
    const t1 = performance.now();
    res.ok = f.size === n * CHUNK;
    for (let i = 0; i < n && res.ok; i++) {
      if (signal?.aborted) throw new Error("Đã dừng.");
      const got = new Uint8Array(await f.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
      fillChunk(buf, i);
      for (let k = 0; k < CHUNK; k += 1) {
        if (got[k] !== buf[k]) {
          res.ok = false;
          res.badAtMB = Math.floor((i * CHUNK + k) / (1024 * 1024));
          break;
        }
      }
      onProgress("read", (i + 1) / n);
    }
    res.readMBps = res.mb / ((performance.now() - t1) / 1000);
  } catch (e) {
    res.ok = false;
    res.error = e instanceof DOMException && e.name === "QuotaExceededError" ? "Không đủ chỗ trống để thử." : e instanceof Error ? e.message : String(e);
  } finally {
    await dir.removeEntry(name).catch(() => {});
  }
  return res;
}

export interface Marker {
  at: number;
  token: string;
  browser: string;
}

/**
 * A marker in both places the library lives (the file area and the database).
 * Restart the tablet, come back: if both are still there, the browser kept
 * the data. (Stored in the database through `save`/`load`.)
 */
export async function placeMarker(browser: string, save: (m: Marker) => Promise<void>): Promise<Marker> {
  const m: Marker = { at: Date.now(), token: crypto.randomUUID?.() ?? String(Math.random()), browser };
  const dir = await diagDir();
  const w = await (await dir.getFileHandle("marker.json", { create: true })).createWritable();
  await w.write(JSON.stringify(m));
  await w.close();
  await save(m);
  return m;
}

export type MarkerState = { kind: "none" } | { kind: "intact"; marker: Marker } | { kind: "file-lost"; marker: Marker } | { kind: "db-lost" };

export async function checkMarker(load: () => Promise<Marker | null>): Promise<MarkerState> {
  const inDb = await load();
  let inFile: Marker | null = null;
  try {
    const dir = await diagDir();
    inFile = JSON.parse(await (await (await dir.getFileHandle("marker.json")).getFile()).text()) as Marker;
  } catch {
    inFile = null;
  }
  if (!inDb && !inFile) return { kind: "none" };
  if (inDb && inFile && inDb.token === inFile.token) return { kind: "intact", marker: inDb };
  if (inDb && !inFile) return { kind: "file-lost", marker: inDb };
  return { kind: "db-lost" };
}
