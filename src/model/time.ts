/**
 * Pure time helpers. All document times are integer microseconds (Us).
 */
import { curveIntegral, curveIntegralInverse, curveMean, curveSpeedAt, type SpeedCurve } from './speedCurve';
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

// ---------------------------------------------------------------- speed mapping
//
// A timed clip reads its source at speed v(τ) at local timeline time τ = t − start, so the source
// offset is src(τ) = ∫₀^τ v. Standard speed: v = speed, src = τ·speed. Curve speed: v(τ) =
// curve(τ / duration), src = duration · F(τ / duration) (see ./speedCurve). Every consumer —
// frameState (player + export frames), the audio mix, the timeline filmstrip/waveform, trim and
// split — goes through these functions.

type SpeedFields = Pick<TimedClip, 'speed'> & { speedCurve?: SpeedCurve | null };

/** Average speed over the clip: the curve's mean, or the standard speed. */
export const clipMeanSpeed = (c: SpeedFields): number => (c.speedCurve ? curveMean(c.speedCurve) : c.speed);

/** Source span consumed by a timed clip, in µs of source time (= duration × mean speed). */
export const sourceSpan = (c: Pick<TimedClip, 'duration'> & SpeedFields): Us => Math.round(c.duration * clipMeanSpeed(c));

/** Timeline duration that plays `span` µs of source with this speed / curve. */
export const durationForSpan = (span: Us, c: SpeedFields): number => span / clipMeanSpeed(c);

/**
 * Source offset (µs, fractional) after `local` µs of the clip on the timeline. Past the clip's
 * edges the end speeds continue.
 */
export function sourceOffsetAt(c: Pick<TimedClip, 'duration'> & SpeedFields, local: number): number {
  if (!c.speedCurve) return local * c.speed;
  const D = Math.max(1, c.duration);
  return D * curveIntegral(c.speedCurve, local / D);
}

/** Inverse of sourceOffsetAt: the local timeline offset (µs, fractional) that reads `offset` µs of source. */
export function localTimeForSourceOffset(c: Pick<TimedClip, 'duration'> & SpeedFields, offset: number): number {
  if (!c.speedCurve) return offset / c.speed;
  const D = Math.max(1, c.duration);
  return D * curveIntegralInverse(c.speedCurve, offset / D);
}

/** Instantaneous speed at timeline time t. */
export function speedAtTime(c: Pick<TimedClip, 'start' | 'duration'> & SpeedFields, t: Us): number {
  if (!c.speedCurve) return c.speed;
  return curveSpeedAt(c.speedCurve, (t - c.start) / Math.max(1, c.duration));
}

/**
 * Source (media) time for a timed clip at timeline time t: inPoint + ∫ speed. Not clamped —
 * callers clamp to [0, asset.duration].
 */
export const sourceTimeAt = (c: Pick<TimedClip, 'start' | 'inPoint' | 'duration'> & SpeedFields, t: Us): Us =>
  Math.round(c.inPoint + sourceOffsetAt(c, t - c.start));

// ---------------------------------------------------------------- reverse (Edit › Reverse)
//
// A reversed clip keeps its `inPoint` in REVERSED media time (measured from the media end), so
// every timeline op works on it exactly like on a forward clip of a reversed copy of the media.
// Consumers that read the real media map a reversed-media time back with `mediaTimeOf`.

/**
 * Real media time for a reversed-media time `r` (D = media duration): the frame covering the
 * instant just before D − r. REVERSE_EPS_US (> FRAME_LOOKUP_EPS_US in engine/frameState) keeps
 * the frame lookup strictly below the mirrored instant, so reversed-media time 0 shows the LAST
 * frame, not the (non-existent) frame starting at D.
 */
export const REVERSE_EPS_US = 200;
export const mirrorMediaTime = (mediaUs: Us, r: number): number => mediaUs - r - REVERSE_EPS_US;

/** Converts an inPoint between forward and reversed media time (an involution, no epsilon). */
export const mirrorInPoint = (mediaUs: Us, inPoint: Us, span: Us): Us => Math.max(0, Math.round(mediaUs - inPoint - span));

/**
 * Real media time (µs, not clamped) a timed clip shows at timeline time t, reverse included.
 * `mediaUs` = the asset duration (only read when the clip is reversed).
 */
export function mediaTimeAt(c: Pick<TimedClip, 'start' | 'inPoint' | 'duration'> & SpeedFields & { reversed?: boolean }, t: Us, mediaUs: Us): Us {
  const r = c.inPoint + sourceOffsetAt(c, t - c.start);
  return Math.round(c.reversed ? mirrorMediaTime(mediaUs, r) : r);
}

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
