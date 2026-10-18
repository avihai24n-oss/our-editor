/**
 * Pure time helpers. All document times are integer microseconds (Us).
 */
import type { Clip, Project, Track, TimedClip, Us } from './types';

export const US_PER_SEC = 1_000_000;

export const secToUs = (sec: number): Us => Math.round(sec * US_PER_SEC);
export const usToSec = (us: Us): number => us / US_PER_SEC;

/** Length of one frame in µs (fractional; do not store). */
export const frameUs = (fps: number): number => US_PER_SEC / fps;

/** Frame index containing `us` (floor). */
export const usToFrame = (us: Us, fps: number): number => Math.floor((us + 0.5) / frameUs(fps));
export const frameToUs = (frame: number, fps: number): Us => Math.round(frame * frameUs(fps));

/** Round a time to the nearest frame boundary. */
export const snapToFrame = (us: Us, fps: number): Us => frameToUs(Math.round(us / frameUs(fps)), fps);

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** CapCut player timecode: HH:MM:SS:FF. Negative values clamp to 0. */
export function formatTimecode(us: Us, fps: number): string {
  const total = usToFrame(Math.max(0, us), fps);
  const ff = total % fps;
  const totalSec = Math.floor(total / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** Short form for ruler labels and media badges: MM:SS (or H:MM:SS past an hour). */
export function formatShort(us: Us): string {
  const totalSec = Math.floor(Math.max(0, us) / US_PER_SEC);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** Seconds with one decimal, e.g. "2.3s" (inspector duration rows). */
export const formatSeconds = (us: Us, digits = 1): string => `${usToSec(us).toFixed(digits)}s`;

/** Parse "HH:MM:SS:FF", "MM:SS" or plain seconds. Returns null when unparsable. */
export function parseTimecode(text: string, fps: number): Us | null {
  const s = text.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return secToUs(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 4) {
    const [h, m, sec, f] = parts as [number, number, number, number];
    return secToUs(h * 3600 + m * 60 + sec) + frameToUs(f, fps);
  }
  if (parts.length === 3) {
    const [h, m, sec] = parts as [number, number, number];
    return secToUs(h * 3600 + m * 60 + sec);
  }
  if (parts.length === 2) {
    const [m, sec] = parts as [number, number];
    return secToUs(m * 60 + sec);
  }
  return null;
}

// ---------------------------------------------------------------- clip time

export const clipEnd = (c: Pick<Clip, 'start' | 'duration'>): Us => c.start + c.duration;

/** Half-open: start <= t < end. */
export const clipContains = (c: Pick<Clip, 'start' | 'duration'>, t: Us): boolean =>
  t >= c.start && t < clipEnd(c);

/** Source span consumed by a timed clip, in µs of source time. */
export const sourceSpan = (c: Pick<TimedClip, 'duration' | 'speed'>): Us => Math.round(c.duration * c.speed);

/**
 * Source (media) time for a timed clip at timeline time t:
 * inPoint + (t - start) * speed. Not clamped — callers clamp to [0, asset.duration].
 */
export const sourceTimeAt = (c: Pick<TimedClip, 'start' | 'inPoint' | 'speed'>, t: Us): Us =>
  Math.round(c.inPoint + (t - c.start) * c.speed);

/** The clip of a track at time t, or undefined. */
export const clipAtTime = (track: Track, t: Us): Clip | undefined => track.clips.find((c) => clipContains(c, t));

/** Every clip in the project at time t, with its track (tracks in array order). */
export function clipsAtTime(project: Project, t: Us): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of project.tracks) {
    const clip = clipAtTime(track, t);
    if (clip) out.push({ track, clip });
  }
  return out;
}

export const trackEnd = (track: Track): Us => track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

/** Project duration = the latest clip end on any track. */
export const projectDuration = (project: Project): Us =>
  project.tracks.reduce((m, tr) => Math.max(m, trackEnd(tr)), 0);

/** Sorted unique cut points (clip starts/ends) of all tracks — for ↑/↓ "previous/next edit". */
export function editPoints(project: Project): Us[] {
  const set = new Set<Us>([0]);
  for (const tr of project.tracks) for (const c of tr.clips) {
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}
export const prevEditPoint = (project: Project, t: Us): Us => {
  const pts = editPoints(project).filter((p) => p < t);
  return pts.length ? pts[pts.length - 1]! : 0;
};
export const nextEditPoint = (project: Project, t: Us): Us => {
  const p = editPoints(project).find((x) => x > t);
  return p ?? t;
};

// ---------------------------------------------------------------- snapping

/**
 * Snap candidates: 0, the playhead, every clip start/end (except excluded clips) and markers.
 */
export function snapCandidates(project: Project, playhead: Us, excludeClipIds: readonly string[] = []): Us[] {
  const ex = new Set(excludeClipIds);
  const set = new Set<Us>([0, playhead]);
  for (const tr of project.tracks) for (const c of tr.clips) {
    if (ex.has(c.id)) continue;
    set.add(c.start);
    set.add(clipEnd(c));
  }
  for (const m of project.markers) set.add(m.time);
  return [...set].sort((a, b) => a - b);
}

/**
 * Snap `t` to the nearest candidate within `thresholdUs`.
 * Timeline UI: thresholdUs = 8px / pxPerSecond * 1e6.
 */
export function snapTime(t: Us, candidates: readonly Us[], thresholdUs: number): { time: Us; snapped: boolean; target?: Us } {
  let best: Us | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best !== undefined && bestD <= thresholdUs) return { time: best, snapped: true, target: best };
  return { time: t, snapped: false };
}

/**
 * Snap a moving range [start, start+duration): tries both edges, returns the adjusted start.
 */
export function snapRange(
  start: Us,
  duration: Us,
  candidates: readonly Us[],
  thresholdUs: number,
): { start: Us; snapped: boolean; target?: Us } {
  const a = snapTime(start, candidates, thresholdUs);
  const b = snapTime(start + duration, candidates, thresholdUs);
  const da = a.snapped ? Math.abs(a.time - start) : Infinity;
  const db = b.snapped ? Math.abs(b.time - (start + duration)) : Infinity;
  if (da === Infinity && db === Infinity) return { start, snapped: false };
  if (da <= db) return { start: a.time, snapped: true, target: a.time };
  return { start: b.time - duration, snapped: true, target: b.time };
}

/** Pixel ↔ time for the timeline. */
export const usToPx = (us: Us, pxPerSecond: number): number => (us / US_PER_SEC) * pxPerSecond;
export const pxToUs = (px: number, pxPerSecond: number): Us => Math.round((px / pxPerSecond) * US_PER_SEC);

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
