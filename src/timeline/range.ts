/**
 * In / out range (CapCut I / O, ⇧X, ⌥X): pure helpers shared by the timeline (drawing, handle
 * drags) and the export ("export the marked range").
 *
 * Convention — a range is the half-open span [in, out) of timeline time, like a selection between
 * two playhead positions: the first exported frame is the frame AT `in`, the last one is the frame
 * just before `out` (out − 1 frame), so the length is exactly out − in. An open end means "from
 * the start" (no in) or "to the end of the timeline" (no out), CapCut's behaviour when only one of
 * I / O is pressed.
 */
import { frameUs, snapToFrame } from '../model/time';
import type { Us } from '../model/types';

/** In / out points. Either end may be unset. Not part of the document (see store/viewState.ts). */
export interface TimelineArea {
  in: Us | null;
  out: Us | null;
}

export interface TimeRange {
  from: Us;
  to: Us;
}

export const NO_AREA: TimelineArea = { in: null, out: null };

export const hasArea = (a: TimelineArea | null | undefined): boolean => !!a && (a.in !== null || a.out !== null);

/**
 * The span an area covers on a timeline `durationUs` long (open ends filled in, clamped to the
 * timeline), or null when there is no area or it covers nothing.
 */
export function resolveArea(a: TimelineArea | null | undefined, durationUs: Us): TimeRange | null {
  if (!hasArea(a)) return null;
  const from = Math.max(0, Math.min(a!.in ?? 0, durationUs));
  const to = Math.max(0, Math.min(a!.out ?? durationUs, durationUs));
  return to > from ? { from, to } : null;
}

/**
 * Moves one edge of the area to `t` (a handle drag): frame-snapped, never past the other edge
 * (at least one frame stays marked), never before 0.
 */
export function moveAreaEdge(a: TimelineArea, edge: 'in' | 'out', t: Us, fps: number): TimelineArea {
  const f = frameUs(fps);
  const v = Math.max(0, snapToFrame(t, fps));
  if (edge === 'in') {
    const lim = a.out !== null ? snapToFrame(a.out - f, fps) : Infinity;
    return { in: Math.max(0, Math.min(v, lim)), out: a.out };
  }
  const lim = snapToFrame((a.in ?? 0) + f, fps);
  return { in: a.in, out: Math.max(v, lim) };
}

/** Sanitises a stored area (view state from disk): non-negative integers, out > in, else dropped. */
export function sanitizeArea(v: unknown): TimelineArea {
  if (!v || typeof v !== 'object') return NO_AREA;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): Us | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : null);
  const i = num(o.in);
  const out = num(o.out);
  if (i !== null && out !== null && out <= i) return NO_AREA;
  return { in: i, out };
}

/** "00-12 – 00-31": a file-name-safe tag for a range (MM-SS, HH-MM-SS past an hour). */
export function rangeFileTag(r: TimeRange): string {
  const f = (us: Us) => {
    const s = Math.floor(us / 1e6);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor(s / 60) % 60;
    const ss = s % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}-${p(mm)}-${p(ss)}` : `${p(mm)}-${p(ss)}`;
  };
  return `${f(r.from)} – ${f(r.to)}`;
}
