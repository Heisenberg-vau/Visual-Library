import type { Stroke } from "./types";

/**
 * All handwriting of one open book, in memory, with undo/redo.
 * Persistence is injected so the model is testable and storage can change
 * without touching the drawing code.
 */
type Removed = { stroke: Stroke; index: number };
type Op = { kind: "add"; page: number; stroke: Stroke } | { kind: "remove"; page: number; removed: Removed[] };

export interface InkPersistence {
  savePage(page: number, strokes: Stroke[]): Promise<void>;
}

export class InkModel {
  private pages = new Map<number, Stroke[]>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private listeners = new Set<(page: number) => void>();
  private dirty = new Set<number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    initial: Map<number, Stroke[]>,
    private readonly persistence: InkPersistence,
    private readonly saveDelayMs = 400,
  ) {
    for (const [p, s] of initial) if (s.length) this.pages.set(p, [...s]);
  }

  strokes(page: number): readonly Stroke[] {
    return this.pages.get(page) ?? [];
  }

  pagesWithInk(): number[] {
    return [...this.pages.entries()]
      .filter(([, s]) => s.length)
      .map(([p]) => p)
      .sort((a, b) => a - b);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onChange(fn: (page: number) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  add(page: number, stroke: Stroke): void {
    const op: Op = { kind: "add", page, stroke };
    this.doOp(op);
    this.undoStack.push(op);
    this.redoStack = [];
    this.emit(page);
  }

  /** Removes strokes (by id) from a page as ONE undo step. */
  remove(page: number, ids: Iterable<string>): void {
    const set = new Set(ids);
    const removed = (this.pages.get(page) ?? [])
      .map((stroke, index) => ({ stroke, index }))
      .filter((e) => set.has(e.stroke.id));
    if (!removed.length) return;
    const op: Op = { kind: "remove", page, removed };
    this.doOp(op);
    this.undoStack.push(op);
    this.redoStack = [];
    this.emit(page);
  }

  undo(): number | null {
    const op = this.undoStack.pop();
    if (!op) return null;
    this.undoOp(op);
    this.redoStack.push(op);
    this.emit(op.page);
    return op.page;
  }

  redo(): number | null {
    const op = this.redoStack.pop();
    if (!op) return null;
    this.doOp(op);
    this.undoStack.push(op);
    this.emit(op.page);
    return op.page;
  }

  private doOp(op: Op): void {
    const list = [...(this.pages.get(op.page) ?? [])];
    if (op.kind === "add") {
      list.push(op.stroke);
      this.set(op.page, list);
    } else {
      const ids = new Set(op.removed.map((e) => e.stroke.id));
      this.set(op.page, list.filter((s) => !ids.has(s.id)));
    }
  }

  private undoOp(op: Op): void {
    const list = [...(this.pages.get(op.page) ?? [])];
    if (op.kind === "add") {
      this.set(op.page, list.filter((s) => s.id !== op.stroke.id));
    } else {
      // Put erased strokes back where they were, so paint order is kept.
      for (const e of [...op.removed].sort((a, b) => a.index - b.index)) {
        list.splice(Math.min(e.index, list.length), 0, e.stroke);
      }
      this.set(op.page, list);
    }
  }

  private set(page: number, list: Stroke[]): void {
    if (list.length) this.pages.set(page, list);
    else this.pages.delete(page);
    this.dirty.add(page);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDelayMs);
  }

  /** Notifies after the undo/redo stacks are updated, so UI state is right. */
  private emit(page: number): void {
    for (const fn of this.listeners) fn(page);
  }

  /** Writes pending pages now. Call before closing the book. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const pages = [...this.dirty];
    this.dirty.clear();
    this.saving = this.saving.then(async () => {
      for (const p of pages) {
        try {
          await this.persistence.savePage(p, [...(this.pages.get(p) ?? [])]);
        } catch (e) {
          this.dirty.add(p); // retried on the next change or flush
          console.error("saving ink failed", e);
        }
      }
    });
    return this.saving;
  }
}
