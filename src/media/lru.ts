/**
 * Byte-budgeted LRU cache. Every media cache in the app (filmstrip thumbnails, library posters,
 * waveform peaks) goes through this, so none of them can grow without bound.
 *
 * - `maxBytes` caps the sum of the entries' declared sizes; `maxEntries` caps their count.
 * - The least recently used entry is evicted first. `onEvict` runs for every entry that leaves
 *   the cache (eviction, delete, clear), which is where object URLs are revoked and
 *   VideoFrame / ImageBitmap objects are closed.
 * - An entry bigger than the whole budget is rejected (onEvict runs on it at once).
 *
 * Pure (no DOM): unit-tested in lru.test.ts.
 */

export interface LruOptions<V> {
  maxBytes: number;
  maxEntries?: number;
  onEvict?: (key: string, value: V) => void;
}

interface Entry<V> {
  value: V;
  bytes: number;
}

export class ByteLRU<V> {
  private map = new Map<string, Entry<V>>();
  private total = 0;
  readonly maxBytes: number;
  readonly maxEntries: number;
  private onEvict?: (key: string, value: V) => void;

  constructor(opts: LruOptions<V>) {
    this.maxBytes = opts.maxBytes;
    this.maxEntries = opts.maxEntries ?? Infinity;
    this.onEvict = opts.onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  /** Sum of the declared sizes of the entries in the cache. */
  get bytes(): number {
    return this.total;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Reads an entry and marks it most recently used. */
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Reads without touching the LRU order. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /** Inserts or replaces. Returns false when the value alone exceeds the budget (it is evicted at once). */
  set(key: string, value: V, bytes: number): boolean {
    const size = Math.max(0, bytes);
    const old = this.map.get(key);
    if (old) {
      this.map.delete(key);
      this.total -= old.bytes;
      if (old.value !== value) this.onEvict?.(key, old.value);
    }
    if (size > this.maxBytes) {
      this.onEvict?.(key, value);
      return false;
    }
    this.map.set(key, { value, bytes: size });
    this.total += size;
    this.trim();
    return true;
  }

  delete(key: string): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.total -= e.bytes;
    this.onEvict?.(key, e.value);
    return true;
  }

  /** Deletes every entry whose key matches. */
  deleteWhere(pred: (key: string) => boolean): number {
    let n = 0;
    for (const key of [...this.map.keys()]) if (pred(key) && this.delete(key)) n++;
    return n;
  }

  clear(): void {
    const all = [...this.map.entries()];
    this.map.clear();
    this.total = 0;
    for (const [k, e] of all) this.onEvict?.(k, e.value);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  private trim(): void {
    while (this.map.size > 0 && (this.total > this.maxBytes || this.map.size > this.maxEntries)) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }
}
