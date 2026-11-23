import { STORES, tx } from "./idb";

/**
 * Stores the user's ORIGINAL files. Originals are written once at import and
 * never modified; annotated exports (milestone 3) are always new files.
 */
export interface FileStore {
  readonly kind: string;
  write(id: string, file: Blob, onProgress?: (done: number) => void): Promise<void>;
  /** Returns a File backed by disk (not loaded into RAM). */
  read(id: string): Promise<File>;
  delete(id: string): Promise<void>;
}

/** Origin Private File System: real files on disk, read lazily by slice. */
export class OpfsFileStore implements FileStore {
  readonly kind = "opfs";
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
  }

  private dir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle("originals", { create: true }));
    }
    return this.dirPromise;
  }

  async write(id: string, file: Blob, onProgress?: (done: number) => void): Promise<void> {
    const dir = await this.dir();
    const handle = await dir.getFileHandle(id, { create: true });
    const w = await handle.createWritable();
    try {
      // Copy in 8 MB chunks so a 200 MB file never sits in memory at once.
      const CHUNK = 8 * 1024 * 1024;
      for (let off = 0; off < file.size; off += CHUNK) {
        const part = file.slice(off, Math.min(file.size, off + CHUNK));
        await w.write(await part.arrayBuffer());
        onProgress?.(Math.min(file.size, off + CHUNK));
      }
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      await dir.removeEntry(id).catch(() => {});
      throw e;
    }
  }

  async read(id: string): Promise<File> {
    const dir = await this.dir();
    const handle = await dir.getFileHandle(id);
    return handle.getFile();
  }

  async delete(id: string): Promise<void> {
    const dir = await this.dir();
    await dir.removeEntry(id).catch(() => {});
  }
}

/** Fallback: Blob in IndexedDB (browsers still store it on disk). */
export class IdbFileStore implements FileStore {
  readonly kind = "idb";

  async write(id: string, file: Blob, onProgress?: (done: number) => void): Promise<void> {
    await tx(STORES.blobs, "readwrite", (s) => s.put(file, id));
    onProgress?.(file.size);
  }

  async read(id: string): Promise<File> {
    const b = await tx<Blob | undefined>(STORES.blobs, "readonly", (s) => s.get(id));
    if (!b) throw new Error(`file ${id} missing`);
    return b instanceof File ? b : new File([b], id, { type: b.type });
  }

  async delete(id: string): Promise<void> {
    await tx(STORES.blobs, "readwrite", (s) => s.delete(id));
  }
}

/** In-memory store for unit tests. */
export class MemoryFileStore implements FileStore {
  readonly kind = "memory";
  private files = new Map<string, File>();

  async write(id: string, file: Blob): Promise<void> {
    this.files.set(id, new File([file], id));
  }

  async read(id: string): Promise<File> {
    const f = this.files.get(id);
    if (!f) throw new Error(`file ${id} missing`);
    return f;
  }

  async delete(id: string): Promise<void> {
    this.files.delete(id);
  }
}

export function createFileStore(): FileStore {
  return OpfsFileStore.isSupported() ? new OpfsFileStore() : new IdbFileStore();
}
