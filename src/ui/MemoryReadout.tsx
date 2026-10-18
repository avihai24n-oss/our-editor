/**
 * Dev memory readout (top bar, only with ?debug=1): JS heap, cache sizes, live media elements,
 * undo steps and project writes. Refreshes every 2 s while the tab is visible; nothing runs
 * without ?debug=1.
 */
import { useEffect, useState } from 'react';
import { cacheStats, MEMORY_LIMITS } from '../media/memory';
import { liveAssetUrls } from '../media/registry';
import { lastHeapReading, readHeap, type HeapReading } from '../media/watchdog';
import { activePreviewEngine } from '../player/PreviewEngine';
import { useEditor } from '../store';
import { autosaveWrites } from '../store/autosave';
import { liveGrabbers } from '../timeline/media/thumbnails';

export interface MemorySnapshot {
  heap: HeapReading | null;
  caches: ReturnType<typeof cacheStats>;
  preview: { videos: number; images: number; voices: number; looping: boolean } | null;
  grabbers: number;
  objectUrls: number;
  undoSteps: number;
  projectWrites: number;
}

export async function memorySnapshot(): Promise<MemorySnapshot> {
  return {
    heap: (await readHeap().catch(() => null)) ?? lastHeapReading(),
    caches: cacheStats(),
    preview: activePreviewEngine()?.stats() ?? null,
    grabbers: liveGrabbers(),
    objectUrls: liveAssetUrls(),
    undoSteps: useEditor.getState().past.length,
    projectWrites: autosaveWrites(),
  };
}

export const debugEnabled = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
};

const mb = (b: number) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)}`;

export function MemoryReadout() {
  const [snap, setSnap] = useState<MemorySnapshot | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    const tick = () => void memorySnapshot().then((s) => alive && setSnap(s));
    const arm = () => {
      if (timer || document.visibilityState === 'hidden') return;
      tick();
      timer = setInterval(tick, 2000);
    };
    const disarm = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.visibilityState === 'hidden' ? disarm() : arm());
    document.addEventListener('visibilitychange', onVis);
    arm();
    return () => {
      alive = false;
      disarm();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  if (!snap) return null;
  const c = snap.caches;
  const heap = snap.heap && snap.heap.source !== 'none' ? `${mb(snap.heap.used)}/${mb(MEMORY_LIMITS.heapSoftLimitBytes)} MB` : 'n/a';
  const p = snap.preview;
  return (
    <div className="mem-readout" data-testid="memory-readout" title="Memory (debug)">
      <span>heap {heap}</span>
      <span>thumbs {c.filmstrip ? `${c.filmstrip.entries}·${mb(c.filmstrip.bytes)}MB` : '-'}</span>
      <span>peaks {c.peaks ? mb(c.peaks.bytes) : '-'}MB</span>
      <span>
        media {p ? `${p.videos}v ${p.images}i ${p.voices}a` : '-'} +{snap.grabbers}g
      </span>
      <span>urls {snap.objectUrls}</span>
      <span>undo {snap.undoSteps}</span>
      <span>writes {snap.projectWrites}</span>
    </div>
  );
}
