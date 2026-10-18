/**
 * Memory limits and the cache registry.
 *
 * Every cache or pool that holds media memory registers here with a `flush` (drop what is not on
 * screen) and a `stats` reader. The memory watchdog calls `flushAllCaches()` when the heap passes
 * its soft limit, and the ?debug=1 readout shows `cacheStats()`.
 *
 * No DOM imports: unit-testable.
 */

export const MEMORY_LIMITS = {
  /** Filmstrip thumbnail JPEGs (timeline). */
  thumbBytes: 150 * 1024 * 1024,
  thumbEntries: 4000,
  /** Library poster frames (data URLs). */
  posterBytes: 24 * 1024 * 1024,
  /** Waveform peak envelopes. */
  peaksBytes: 32 * 1024 * 1024,
  /** Hidden <video> elements in the preview pool (each one holds a hardware/software decoder). */
  previewVideos: 6,
  /** Hidden <audio> elements in the preview audio engine. */
  previewVoices: 8,
  /** Off-screen pool elements are released this long after the preview stops needing them. */
  idleReleaseMs: 3000,
  /** The filmstrip grabber <video> is released this long after its last thumbnail. */
  grabberIdleMs: 2000,
  /** Undo history: count cap and an estimated-bytes cap (JSON size of each snapshot). */
  undoSteps: 200,
  undoBytes: 64 * 1024 * 1024,
  /** Autosave: debounce after the last change, and the minimum gap between two writes. */
  autosaveDebounceMs: 800,
  autosaveMinGapMs: 2000,
  /** Memory watchdog. */
  watchdogIntervalMs: 30_000,
  heapSoftLimitBytes: 1.5 * 1024 * 1024 * 1024,
} as const;

export interface CacheStats {
  entries: number;
  bytes: number;
}

interface Registered {
  flush: () => void;
  stats: () => CacheStats;
}

const caches = new Map<string, Registered>();

/** Registers (or replaces, e.g. after a hot reload) a named cache. */
export function registerCache(name: string, flush: () => void, stats: () => CacheStats): () => void {
  const entry = { flush, stats };
  caches.set(name, entry);
  return () => {
    if (caches.get(name) === entry) caches.delete(name);
  };
}

/** Drops everything the caches can rebuild. Returns the names that were flushed. */
export function flushAllCaches(): string[] {
  const names: string[] = [];
  for (const [name, c] of caches) {
    try {
      c.flush();
      names.push(name);
    } catch (e) {
      console.warn(`flush ${name} failed`, e);
    }
  }
  return names;
}

export function cacheStats(): Record<string, CacheStats> {
  const out: Record<string, CacheStats> = {};
  for (const [name, c] of caches) out[name] = c.stats();
  return out;
}
