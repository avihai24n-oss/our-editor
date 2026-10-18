/**
 * Undo history caps. Snapshots are immer-frozen Project JSON (structural sharing, no Blobs, no
 * caches: media lives in IndexedDB / the URL registry, never in the document), so the count cap
 * is usually what bites. The byte cap protects against huge documents: each snapshot's JSON size
 * is measured once (WeakMap, so it does not keep snapshots alive) and the oldest steps are dropped
 * when the sum passes MEMORY_LIMITS.undoBytes. Sharing makes the real cost lower than this
 * estimate, never higher.
 */
import { MEMORY_LIMITS } from '../media/memory';
import type { Project } from '../model/types';

const sizes = new WeakMap<Project, number>();

/** Estimated bytes of one snapshot (JSON length × 2 for UTF-16), measured once. */
export function snapshotBytes(p: Project): number {
  let n = sizes.get(p);
  if (n === undefined) {
    n = JSON.stringify(p).length * 2;
    sizes.set(p, n);
  }
  return n;
}

/** Keeps the newest steps within both caps. */
export function capHistory(past: Project[], maxSteps: number = MEMORY_LIMITS.undoSteps, maxBytes: number = MEMORY_LIMITS.undoBytes): Project[] {
  let list = past.length > maxSteps ? past.slice(-maxSteps) : past;
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    total += snapshotBytes(list[i]!);
    if (total > maxBytes) {
      list = list.slice(i + 1);
      break;
    }
  }
  return list;
}
