/*
 * Stage 3 · v2.1 — the backup file (.vlbak).
 *
 *   "VLBAK1\n" · flags (1 byte: 1 = encrypted) · header length (u32) · header JSON
 *   body: entries [u16 name length · name · u64 size · bytes]…, the last one is
 *         "manifest.json"; then u64 offset of that entry · "VLEND"
 *
 * Plain files keep the body as is: a backup of 10 GB is a Blob made of the
 * book files themselves, never copied into memory. Encrypted files cut the
 * body into 1 MiB frames, each sealed with AES-GCM 256 (key from the password
 * by PBKDF2-SHA256); the frame number and a "last frame" flag are bound to
 * each frame, so a cut-off or reordered file is refused.
 *
 * Every entry carries a SHA-256 over its 4 MiB blocks (the hash of the blocks'
 * hashes): checkable for files of any size without holding them in memory.
 */

const MAGIC = new TextEncoder().encode("VLBAK1\n");
const END = new TextEncoder().encode("VLEND");
export const FRAME = 1024 * 1024;
const TAG = 16;
const BLOCK = 4 * 1024 * 1024;
export const KDF_ITERATIONS = 600_000;

export interface BackupHeader {
  format: 1;
  createdAt: number;
  app: string;
  encryption?: { alg: "AES-GCM-256"; kdf: "PBKDF2-SHA256"; iterations: number; salt: string; iv: string; frame: number };
}

export interface EntryInfo {
  name: string;
  size: number;
  /** Offset of the data in the body. */
  offset: number;
  /** SHA-256 over the 4 MiB blocks (hex). */
  sha256: string;
}

export class BackupError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}
const readU64 = (b: Uint8Array, at = 0) => Number(new DataView(b.buffer, b.byteOffset).getBigUint64(at));

/** The block-hash of some bytes, fed block by block. */
export class BlockHasher {
  private parts: Uint8Array[] = [];
  private pending: Uint8Array[] = [];
  private pendingLen = 0;

  async push(bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.length) {
      const take = Math.min(BLOCK - this.pendingLen, bytes.length - off);
      this.pending.push(bytes.subarray(off, off + take));
      this.pendingLen += take;
      off += take;
      if (this.pendingLen === BLOCK) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const buf = concat(this.pending, this.pendingLen);
    this.parts.push(new Uint8Array(await crypto.subtle.digest("SHA-256", buf as BufferSource)));
    this.pending = [];
    this.pendingLen = 0;
  }

  async digest(): Promise<string> {
    if (this.pendingLen || !this.parts.length) await this.flush();
    return hex(await crypto.subtle.digest("SHA-256", concat(this.parts, this.parts.length * 32) as BufferSource));
  }
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].byteLength === parts[0].buffer.byteLength) return parts[0];
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function deriveKey(password: string, salt: Uint8Array, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function frameIv(base: Uint8Array, i: number): Uint8Array {
  const iv = new Uint8Array(base);
  new DataView(iv.buffer).setUint32(8, (new DataView(base.buffer, base.byteOffset).getUint32(8) + i) >>> 0);
  return iv;
}
const frameAad = (i: number, last: boolean) => {
  const a = new Uint8Array(5);
  new DataView(a.buffer).setUint32(0, i);
  a[4] = last ? 1 : 0;
  return a;
};

// ------------------------------------------------------------------ writing

/** Where the backup goes: kept as Blob parts (plain) or written out (encrypted). */
export interface Sink {
  write(bytes: Uint8Array): Promise<void>;
  /** A slice of an existing file: plain sinks keep the reference, no copy. */
  writeSlice(slice: Blob, bytes: Uint8Array): Promise<void>;
  close(): Promise<Blob>;
}

export class MemorySink implements Sink {
  private parts: BlobPart[] = [];
  async write(bytes: Uint8Array): Promise<void> {
    this.parts.push(bytes.slice());
  }
  async writeSlice(slice: Blob): Promise<void> {
    this.parts.push(slice);
  }
  async close(): Promise<Blob> {
    return new Blob(this.parts, { type: "application/octet-stream" });
  }
}

/** Seals the body into frames; frames go to `out` (a file on disk in the app, memory in tests). */
class EncryptingSink implements Sink {
  private buf = new Uint8Array(FRAME);
  private len = 0;
  private index = 0;
  constructor(
    private readonly key: CryptoKey,
    private readonly iv: Uint8Array,
    private readonly out: { write(b: Uint8Array): Promise<void>; close(): Promise<Blob> },
  ) {}
  async write(bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.length) {
      // keep one full frame back: only close() knows which frame is the last
      if (this.len === FRAME) await this.seal(false);
      const take = Math.min(FRAME - this.len, bytes.length - off);
      this.buf.set(bytes.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
    }
  }
  async writeSlice(_slice: Blob, bytes: Uint8Array): Promise<void> {
    await this.write(bytes);
  }
  private async seal(last: boolean): Promise<void> {
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: frameIv(this.iv, this.index) as BufferSource, additionalData: frameAad(this.index, last) as BufferSource }, this.key, this.buf.subarray(0, this.len) as BufferSource);
    await this.out.write(new Uint8Array(ct));
    this.index++;
    this.len = 0;
  }
  async close(): Promise<Blob> {
    await this.seal(true);
    return this.out.close();
  }
}

export class BackupWriter {
  private body!: Sink;
  private offset = 0;
  private entries: EntryInfo[] = [];
  private cancelled = false;

  private constructor() {}

  /**
   * `out` receives the finished bytes. Plain backups can use a MemorySink
   * (Blob parts by reference); encrypted ones need somewhere to put frames.
   */
  static async create(opts: {
    app: string;
    password?: string;
    plainSink?: () => Sink;
    cipherOut?: () => { write(b: Uint8Array): Promise<void>; close(): Promise<Blob> };
    iterations?: number;
  }): Promise<BackupWriter> {
    const header: BackupHeader = { format: 1, createdAt: Date.now(), app: opts.app };
    let key: CryptoKey | null = null;
    let iv: Uint8Array | null = null;
    if (opts.password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      iv = crypto.getRandomValues(new Uint8Array(12));
      const iterations = opts.iterations ?? KDF_ITERATIONS;
      key = await deriveKey(opts.password, salt, iterations);
      header.encryption = { alg: "AES-GCM-256", kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), iv: b64(iv), frame: FRAME };
    }
    const hj = enc.encode(JSON.stringify(header));
    const head = new Uint8Array(MAGIC.length + 1 + 4 + hj.length);
    head.set(MAGIC, 0);
    head[MAGIC.length] = key ? 1 : 0;
    new DataView(head.buffer).setUint32(MAGIC.length + 1, hj.length);
    head.set(hj, MAGIC.length + 5);
    const w = new BackupWriter();
    if (key && iv) {
      const out = (opts.cipherOut ?? (() => new MemoryOut()))();
      await out.write(head);
      w.body = new EncryptingSink(key, iv, out);
    } else {
      w.body = (opts.plainSink ?? (() => new MemorySink()))();
      await w.body.write(head);
    }
    return w;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async raw(bytes: Uint8Array): Promise<void> {
    await this.body.write(bytes);
    this.offset += bytes.length;
  }

  private async entryHead(name: string, size: number): Promise<number> {
    const nb = enc.encode(name);
    const h = new Uint8Array(2 + nb.length + 8);
    new DataView(h.buffer).setUint16(0, nb.length);
    h.set(nb, 2);
    h.set(u64(size), 2 + nb.length);
    await this.raw(h);
    return this.offset;
  }

  /** Adds bytes held in memory (JSON and small things). */
  async addBytes(name: string, bytes: Uint8Array): Promise<EntryInfo> {
    const offset = await this.entryHead(name, bytes.length);
    const hs = new BlockHasher();
    await hs.push(bytes);
    await this.raw(bytes);
    const e = { name, size: bytes.length, offset, sha256: await hs.digest() };
    this.entries.push(e);
    return e;
  }

  /** Adds a file read block by block (never whole in memory). */
  async addBlob(name: string, blob: Blob, onBytes?: (n: number) => void): Promise<EntryInfo> {
    const offset = await this.entryHead(name, blob.size);
    const hs = new BlockHasher();
    for (let at = 0; at < blob.size; at += BLOCK) {
      if (this.cancelled) throw new BackupError("Đã dừng.");
      const slice = blob.slice(at, Math.min(blob.size, at + BLOCK));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      await hs.push(bytes);
      await this.body.writeSlice(slice, bytes);
      this.offset += bytes.length;
      onBytes?.(bytes.length);
    }
    const e = { name, size: blob.size, offset, sha256: await hs.digest() };
    this.entries.push(e);
    return e;
  }

  /** Writes the manifest (with every entry's hash) and the end mark; returns the file. */
  async finish(manifest: Record<string, unknown>): Promise<Blob> {
    const m = enc.encode(JSON.stringify({ ...manifest, entries: this.entries }));
    const at = this.offset;
    await this.entryHead("manifest.json", m.length);
    await this.raw(m);
    await this.raw(u64(at));
    await this.raw(END);
    return this.body.close();
  }
}

class MemoryOut {
  private parts: BlobPart[] = [];
  async write(b: Uint8Array): Promise<void> {
    this.parts.push(b.slice());
  }
  async close(): Promise<Blob> {
    return new Blob(this.parts, { type: "application/octet-stream" });
  }
}

// ------------------------------------------------------------------ reading

export interface OpenedBackup {
  header: BackupHeader;
  manifest: Record<string, unknown> & { entries: EntryInfo[] };
  encrypted: boolean;
  /** Bytes of an entry, block by block. */
  read(e: EntryInfo, onBytes?: (n: number) => void): AsyncGenerator<Uint8Array>;
  /** A whole entry (small ones). */
  bytes(e: EntryInfo): Promise<Uint8Array>;
  /** For plain backups: the entry as a slice of the file (no copy). */
  slice(e: EntryInfo): Blob | null;
  entry(name: string): EntryInfo | undefined;
}

export async function needsPassword(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, MAGIC.length + 1).arrayBuffer());
  if (!MAGIC.every((b, i) => head[i] === b)) throw new BackupError("Đây không phải file sao lưu của Visual Library.");
  return head[MAGIC.length] === 1;
}

export async function openBackup(file: Blob, password?: string): Promise<OpenedBackup> {
  const pre = new Uint8Array(await file.slice(0, MAGIC.length + 5).arrayBuffer());
  if (pre.length < MAGIC.length + 5 || !MAGIC.every((b, i) => pre[i] === b)) throw new BackupError("Đây không phải file sao lưu của Visual Library.");
  const encrypted = pre[MAGIC.length] === 1;
  const hlen = new DataView(pre.buffer).getUint32(MAGIC.length + 1);
  const bodyStart = MAGIC.length + 5 + hlen;
  let header: BackupHeader;
  try {
    header = JSON.parse(dec.decode(await file.slice(MAGIC.length + 5, bodyStart).arrayBuffer())) as BackupHeader;
  } catch {
    throw new BackupError("Phần đầu file sao lưu bị hỏng.");
  }
  if (header.format !== 1) throw new BackupError("File sao lưu này từ một phiên bản app mới hơn.");

  // the body as plaintext ranges
  let bodyLen: number;
  let readRange: (from: number, to: number) => Promise<Uint8Array>;
  let sliceOf: (from: number, to: number) => Blob | null;
  if (!encrypted) {
    bodyLen = file.size - bodyStart;
    readRange = async (from, to) => new Uint8Array(await file.slice(bodyStart + from, bodyStart + to).arrayBuffer());
    sliceOf = (from, to) => file.slice(bodyStart + from, bodyStart + to);
  } else {
    const e = header.encryption!;
    if (!password) throw new BackupError("Bản sao lưu này được khóa bằng mật khẩu.");
    const key = await deriveKey(password, unb64(e.salt), e.iterations);
    const iv = unb64(e.iv);
    const ctFrame = e.frame + TAG;
    const ctLen = file.size - bodyStart;
    const frames = Math.ceil(ctLen / ctFrame);
    if (!frames) throw new BackupError("File sao lưu bị cắt cụt.");
    const lastPlain = ctLen - (frames - 1) * ctFrame - TAG;
    if (lastPlain < 0) throw new BackupError("File sao lưu bị cắt cụt.");
    bodyLen = (frames - 1) * e.frame + lastPlain;
    const cache = new Map<number, Uint8Array>();
    const frame = async (i: number): Promise<Uint8Array> => {
      const hit = cache.get(i);
      if (hit) return hit;
      const from = bodyStart + i * ctFrame;
      const ct = await file.slice(from, Math.min(file.size, from + ctFrame)).arrayBuffer();
      let pt: ArrayBuffer;
      try {
        pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: frameIv(iv, i) as BufferSource, additionalData: frameAad(i, i === frames - 1) as BufferSource }, key, ct);
      } catch {
        throw new BackupError(i === 0 ? "Sai mật khẩu (hoặc file đã bị sửa)." : `Khung dữ liệu thứ ${i + 1} không khớp: file sao lưu đã bị hỏng hoặc bị cắt cụt.`);
      }
      const u = new Uint8Array(pt);
      if (cache.size > 6) cache.delete(cache.keys().next().value as number);
      cache.set(i, u);
      return u;
    };
    // the first frame proves the password before anything else
    await frame(0);
    readRange = async (from, to) => {
      const out = new Uint8Array(to - from);
      let o = 0;
      for (let i = Math.floor(from / e.frame); o < out.length; i++) {
        const f = await frame(i);
        const s = Math.max(0, from - i * e.frame);
        const take = Math.min(f.length - s, out.length - o);
        out.set(f.subarray(s, s + take), o);
        o += take;
      }
      return out;
    };
    sliceOf = () => null;
  }

  if (bodyLen < 13) throw new BackupError("File sao lưu bị cắt cụt.");
  const tail = await readRange(bodyLen - 13, bodyLen);
  if (!END.every((b, i) => tail[8 + i] === b)) throw new BackupError("File sao lưu bị cắt cụt (thiếu phần cuối).");
  const mAt = readU64(tail, 0);
  const mh = await readRange(mAt, Math.min(bodyLen, mAt + 2 + 64 + 8));
  const nlen = new DataView(mh.buffer, mh.byteOffset).getUint16(0);
  const mname = dec.decode(mh.subarray(2, 2 + nlen));
  if (mname !== "manifest.json") throw new BackupError("Không tìm thấy mục lục của bản sao lưu.");
  const msize = readU64(mh, 2 + nlen);
  const mstart = mAt + 2 + nlen + 8;
  let manifest: OpenedBackup["manifest"];
  try {
    manifest = JSON.parse(dec.decode(await readRange(mstart, mstart + msize)));
  } catch {
    throw new BackupError("Mục lục của bản sao lưu bị hỏng.");
  }
  const byName = new Map(manifest.entries.map((e) => [e.name, e]));
  async function* read(e: EntryInfo, onBytes?: (n: number) => void): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < e.size; at += BLOCK) {
      const b = await readRange(e.offset + at, e.offset + Math.min(e.size, at + BLOCK));
      onBytes?.(b.length);
      yield b;
    }
  }
  return {
    header,
    manifest,
    encrypted,
    read,
    async bytes(e) {
      return readRange(e.offset, e.offset + e.size);
    },
    slice: (e) => sliceOf(e.offset, e.offset + e.size),
    entry: (name) => byName.get(name),
  };
}

/** Re-reads every entry (or only `only`) and compares its hash. Returns the names that do not match. */
export async function verifyBackup(b: OpenedBackup, onBytes?: (n: number) => void, signal?: AbortSignal, only?: string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const e of b.manifest.entries) {
    if (only && !only.includes(e.name)) continue;
    const hs = new BlockHasher();
    try {
      for await (const chunk of b.read(e, onBytes)) {
        if (signal?.aborted) throw new BackupError("Đã dừng.");
        await hs.push(chunk);
      }
      if ((await hs.digest()) !== e.sha256) bad.push(e.name);
    } catch (err) {
      if (err instanceof BackupError && err.message === "Đã dừng.") throw err;
      bad.push(e.name);
    }
  }
  return bad;
}
