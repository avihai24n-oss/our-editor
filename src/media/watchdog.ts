/**
 * Memory watchdog. Every MEMORY_LIMITS.watchdogIntervalMs it reads the JS heap
 * (performance.measureUserAgentSpecificMemory when the page is cross-origin isolated, else
 * Chrome's performance.memory). Past MEMORY_LIMITS.heapSoftLimitBytes it flushes every registered
 * cache (thumbnails, posters, peaks, off-screen decoders) and tells the user.
 *
 * The interval stops while the tab is hidden and restarts when it is visible again.
 */
import { MEMORY_LIMITS, flushAllCaches } from './memory';

export interface HeapReading {
  used: number;
  limit: number | null;
  source: 'measureUserAgentSpecificMemory' | 'performance.memory' | 'none';
}

interface PerfMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export async function readHeap(): Promise<HeapReading> {
  const perf = globalThis.performance as (Performance & { memory?: PerfMemory; measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }) | undefined;
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (perf?.measureUserAgentSpecificMemory && isolated) {
    try {
      const r = await perf.measureUserAgentSpecificMemory();
      return { used: r.bytes, limit: perf.memory?.jsHeapSizeLimit ?? null, source: 'measureUserAgentSpecificMemory' };
    } catch {
      /* fall through */
    }
  }
  if (perf?.memory) return { used: perf.memory.usedJSHeapSize, limit: perf.memory.jsHeapSizeLimit, source: 'performance.memory' };
  return { used: 0, limit: null, source: 'none' };
}

/** Pure decision: flush when over the soft limit, at most once per `cooldownMs`. */
export function shouldFlush(used: number, softLimit: number, lastFlushAt: number, now: number, cooldownMs = 60_000): boolean {
  return used > softLimit && now - lastFlushAt >= cooldownMs;
}

export interface WatchdogOptions {
  intervalMs?: number;
  softLimit?: number;
  read?: () => Promise<HeapReading>;
  onFlush?: (reading: HeapReading, flushed: string[]) => void;
}

let lastReading: HeapReading | null = null;
export const lastHeapReading = (): HeapReading | null => lastReading;

export function startMemoryWatchdog(opts: WatchdogOptions = {}): () => void {
  const interval = opts.intervalMs ?? MEMORY_LIMITS.watchdogIntervalMs;
  const soft = opts.softLimit ?? MEMORY_LIMITS.heapSoftLimitBytes;
  const read = opts.read ?? readHeap;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFlushAt = -Infinity;
  let stopped = false;

  const check = async () => {
    const r = await read();
    lastReading = r;
    const now = Date.now();
    if (!stopped && shouldFlush(r.used, soft, lastFlushAt, now)) {
      lastFlushAt = now;
      const flushed = flushAllCaches();
      opts.onFlush?.(r, flushed);
    }
  };
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const arm = () => {
    if (timer || stopped || hidden()) return;
    timer = setInterval(() => void check(), interval);
  };
  const disarm = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const onVis = () => (hidden() ? disarm() : arm());
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  arm();
  return () => {
    stopped = true;
    disarm();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
  };
}

