/** Memory guards: the byte-budgeted LRU, the cache registry and the watchdog decision/loop. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ByteLRU } from './lru';
import { cacheStats, flushAllCaches, MEMORY_LIMITS, registerCache } from './memory';
import { shouldFlush, startMemoryWatchdog, type HeapReading } from './watchdog';

describe('ByteLRU', () => {
  it('evicts least-recently-used entries past the byte budget and reports every eviction', () => {
    const evicted: string[] = [];
    const c = new ByteLRU<string>({ maxBytes: 100, onEvict: (k) => evicted.push(k) });
    c.set('a', 'A', 40);
    c.set('b', 'B', 40);
    expect(c.get('a')).toBe('A'); // a is now the most recent
    c.set('c', 'C', 40); // 120 > 100 → the LRU one (b) goes
    expect(evicted).toEqual(['b']);
    expect(c.keys()).toEqual(['a', 'c']);
    expect(c.bytes).toBe(80);
  });

  it('caps the entry count too', () => {
    const c = new ByteLRU<number>({ maxBytes: 1e9, maxEntries: 3 });
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i, 1);
    expect(c.size).toBe(3);
    expect(c.keys()).toEqual(['k7', 'k8', 'k9']);
  });

  it('rejects an entry bigger than the whole budget and evicts it at once', () => {
    const onEvict = vi.fn();
    const c = new ByteLRU<string>({ maxBytes: 10, onEvict });
    expect(c.set('big', 'X', 11)).toBe(false);
    expect(c.size).toBe(0);
    expect(onEvict).toHaveBeenCalledWith('big', 'X');
  });

  it('replacing a key evicts the old value (so its URL / frame can be released)', () => {
    const closed: string[] = [];
    const c = new ByteLRU<string>({ maxBytes: 100, onEvict: (_k, v) => closed.push(v) });
    c.set('k', 'v1', 10);
    c.set('k', 'v2', 20);
    expect(closed).toEqual(['v1']);
    expect(c.bytes).toBe(20);
  });

  it('delete, deleteWhere and clear release everything and keep the byte count right', () => {
    const closed: string[] = [];
    const c = new ByteLRU<string>({ maxBytes: 1000, onEvict: (k) => closed.push(k) });
    c.set('a@1', '1', 10);
    c.set('a@2', '2', 10);
    c.set('b@1', '3', 10);
    expect(c.deleteWhere((k) => k.startsWith('a@'))).toBe(2);
    expect(c.bytes).toBe(10);
    c.clear();
    expect(c.bytes).toBe(0);
    expect(closed.sort()).toEqual(['a@1', 'a@2', 'b@1']);
  });

  it('closes VideoFrame-like values on eviction', () => {
    const frames = Array.from({ length: 5 }, () => ({ close: vi.fn() }));
    const c = new ByteLRU<{ close: () => void }>({ maxBytes: 3 * 8_000_000, onEvict: (_k, f) => f.close() });
    frames.forEach((f, i) => c.set(`f${i}`, f, 8_000_000));
    expect(frames.filter((f) => f.close.mock.calls.length === 1)).toHaveLength(2);
    expect(c.size).toBe(3);
  });
});

describe('cache registry', () => {
  it('flushes every registered cache and reports stats; re-registering replaces', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerCache('t-a', a, () => ({ entries: 1, bytes: 2 }));
    registerCache('t-b', () => undefined, () => ({ entries: 0, bytes: 0 }));
    const offB2 = registerCache('t-b', b, () => ({ entries: 5, bytes: 6 }));
    const names = flushAllCaches();
    expect(names).toEqual(expect.arrayContaining(['t-a', 't-b']));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(cacheStats()['t-b']).toEqual({ entries: 5, bytes: 6 });
    offA();
    offB2();
    expect(cacheStats()['t-a']).toBeUndefined();
  });
});

describe('memory watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('decides to flush only past the soft limit, with a cooldown', () => {
    const soft = MEMORY_LIMITS.heapSoftLimitBytes;
    expect(shouldFlush(soft - 1, soft, -Infinity, 0)).toBe(false);
    expect(shouldFlush(soft + 1, soft, -Infinity, 0)).toBe(true);
    expect(shouldFlush(soft + 1, soft, 1000, 30_000)).toBe(false);
    expect(shouldFlush(soft + 1, soft, 1000, 61_000)).toBe(true);
  });

  it('polls on its interval, flushes the caches past the limit, and stops while the tab is hidden', async () => {
    vi.useFakeTimers();
    let vis: 'visible' | 'hidden' = 'visible';
    const handlers = new Set<() => void>();
    vi.stubGlobal('document', {
      get visibilityState() {
        return vis;
      },
      addEventListener: (_: string, fn: () => void) => handlers.add(fn),
      removeEventListener: (_: string, fn: () => void) => handlers.delete(fn),
    });
    let used = 100;
    const read = vi.fn(async (): Promise<HeapReading> => ({ used, limit: null, source: 'performance.memory' }));
    const flushed = vi.fn();
    const cacheFlush = vi.fn();
    const off = registerCache('t-wd', cacheFlush, () => ({ entries: 0, bytes: 0 }));
    const stop = startMemoryWatchdog({ intervalMs: 1000, softLimit: 1000, read, onFlush: flushed });

    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(flushed).not.toHaveBeenCalled();

    used = 5000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).toHaveBeenCalledOnce();
    expect(cacheFlush).toHaveBeenCalledOnce();

    // hidden → no more reads
    vis = 'hidden';
    handlers.forEach((h) => h());
    const n = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(n);

    // visible again → polling resumes
    vis = 'visible';
    handlers.forEach((h) => h());
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(n + 1);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(n + 1);
    expect(vi.getTimerCount()).toBe(0);
    off();
  });
});
