/**
 * Priority job queue with limited concurrency. Used to serialise page and
 * thumbnail rendering so the visible page always renders first and work for
 * pages that scrolled away is dropped before it starts.
 */
export interface Job {
  key: string;
  priority: number; // lower runs first
  run: (signal: AbortSignal) => Promise<void>;
}

interface Entry extends Job {
  ctrl: AbortController;
  seq: number;
}

export class JobScheduler {
  private queue: Entry[] = [];
  private running = new Map<string, Entry>();
  private seq = 0;

  constructor(private readonly concurrency = 1) {}

  /** Adds or re-prioritises a job. Returns false if already running. */
  enqueue(job: Job): boolean {
    if (this.running.has(job.key)) return false;
    const existing = this.queue.find((e) => e.key === job.key);
    if (existing) {
      existing.priority = job.priority;
      existing.run = job.run;
    } else {
      this.queue.push({ ...job, ctrl: new AbortController(), seq: this.seq++ });
    }
    this.pump();
    return true;
  }

  cancel(key: string): void {
    this.queue = this.queue.filter((e) => e.key !== key);
    const r = this.running.get(key);
    if (r) r.ctrl.abort();
  }

  cancelWhere(pred: (key: string) => boolean): void {
    for (const e of [...this.queue]) if (pred(e.key)) this.cancel(e.key);
    for (const k of [...this.running.keys()]) if (pred(k)) this.cancel(k);
  }

  isPending(key: string): boolean {
    return this.running.has(key) || this.queue.some((e) => e.key === key);
  }

  get pendingCount(): number {
    return this.queue.length + this.running.size;
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const e = this.queue.shift()!;
      this.running.set(e.key, e);
      e.run(e.ctrl.signal)
        .catch((err) => {
          if (!e.ctrl.signal.aborted) console.warn("job failed", e.key, err);
        })
        .finally(() => {
          if (this.running.get(e.key) === e) this.running.delete(e.key);
          this.pump();
        });
    }
  }
}
