/** Tiny LRU cache. onEvict lets callers release canvases / bitmaps. */
export class LruCache<K, V> {
  private map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const ov = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, ov);
    }
  }

  clear(): void {
    if (this.onEvict) for (const [k, v] of this.map) this.onEvict(k, v);
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
