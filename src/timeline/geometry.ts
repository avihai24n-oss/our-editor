/**
 * Pure timeline geometry: ruler ticks, zoom maths, scroll anchoring, auto-scroll, magnet insert
 * position, cut lookup. No React, no DOM — unit-tested in geometry.test.ts.
 */
import { LIMITS } from '../model/catalog';
import { clipEnd, formatShort, frameToUs, US_PER_SEC, usToFrame, usToPx } from '../model/time';
import type { Clip, Id, Track, Us } from '../model/types';

/** Width of the track-header column (matches --tl-header-w). */
export const HEADER_W = 140;
/** Snap distance in screen px (CapCut ≈ 8px). */
export const SNAP_PX = 8;
/** Minimum px a pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 3;

// ---------------------------------------------------------------- ruler

export interface RulerScale {
  /** Distance between labelled ticks. */
  majorUs: Us;
  /** Distance between small ticks. */
  minorUs: Us;
  /** True when labels need a frame part (major step shorter than one second). */
  frames: boolean;
}

/** Major step candidates in frames (sub-second) and in seconds. */
const FRAME_STEPS = [1, 2, 5, 10, 15];
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/**
 * Picks a tick spacing so labels sit at least `minLabelPx` apart (CapCut: `|00:00 |03:00 …` far out,
 * frame ticks close in).
 */
export function rulerScale(pxPerSecond: number, fps: number, minLabelPx = 80): RulerScale {
  const frameSec = 1 / fps;
  for (const f of FRAME_STEPS) {
    if (f >= fps) break;
    if (f * frameSec * pxPerSecond >= minLabelPx) {
      const majorUs = Math.round((f * US_PER_SEC) / fps);
      const minorUs = f === 1 ? majorUs : Math.round(US_PER_SEC / fps);
      return { majorUs, minorUs, frames: true };
    }
  }
  for (const s of SECOND_STEPS) {
    if (s * pxPerSecond >= minLabelPx) {
      return { majorUs: s * US_PER_SEC, minorUs: minorFor(s, pxPerSecond), frames: false };
    }
  }
  const last = SECOND_STEPS[SECOND_STEPS.length - 1]!;
  return { majorUs: last * US_PER_SEC, minorUs: (last / 10) * US_PER_SEC, frames: false };
}

/** Minor subdivision of a major step in seconds: as many as fit ≥ 8px apart (5 or 10 or 2). */
function minorFor(majorSec: number, pxPerSecond: number): Us {
  for (const n of [10, 5, 2]) {
    const sub = majorSec / n;
    if (sub * pxPerSecond >= 8) return Math.round(sub * US_PER_SEC);
  }
  return majorSec * US_PER_SEC;
}

export interface Tick {
  t: Us;
  major: boolean;
  label?: string;
}

/** Ticks covering [fromUs, toUs]. Labels: `MM:SS`, or `NNf` for frame ticks inside a second. */
export function rulerTicks(fromUs: Us, toUs: Us, scale: RulerScale, fps: number): Tick[] {
  const out: Tick[] = [];
  const maxTicks = 4000; // guard against absurd counts
  if (scale.frames) {
    // Frame mode: walk whole frames; majors restart at every second boundary.
    const minorF = Math.max(1, Math.round((scale.minorUs * fps) / US_PER_SEC));
    const majorF = Math.max(1, Math.round((scale.majorUs * fps) / US_PER_SEC));
    let f = Math.max(0, Math.floor(usToFrame(fromUs, fps) / minorF) * minorF);
    for (let n = 0; n < maxTicks; n++, f += minorF) {
      const t = frameToUs(f, fps);
      if (t > toUs) break;
      const major = (f % fps) % majorF === 0;
      out.push(major ? { t, major, label: tickLabel(t, scale, fps) } : { t, major });
    }
    return out;
  }
  const step = scale.minorUs;
  if (step <= 0) return out;
  let i = Math.max(0, Math.floor(fromUs / step));
  for (let n = 0; n < maxTicks; n++, i++) {
    const t = Math.round(i * step);
    if (t > toUs) break;
    const major = isMultiple(t, scale.majorUs);
    out.push(major ? { t, major, label: tickLabel(t, scale, fps) } : { t, major });
  }
  return out;
}

const isMultiple = (t: Us, step: Us): boolean => {
  const r = t / step;
  return Math.abs(r - Math.round(r)) < 1e-6;
};

export function tickLabel(t: Us, scale: RulerScale, fps: number): string {
  if (scale.frames) {
    const frame = usToFrame(t, fps) % fps;
    if (frame !== 0) return `${frame}f`;
  }
  return formatShort(t);
}

// ---------------------------------------------------------------- zoom

/** Zoom that fits `durationUs` into `viewportPx` (leaving a small margin). */
export function fitZoom(durationUs: Us, viewportPx: number, marginPx = 48): number {
  if (durationUs <= 0 || viewportPx <= 0) return LIMITS.zoomDefault;
  const usable = Math.max(40, viewportPx - marginPx);
  return clampZoom(usable / (durationUs / US_PER_SEC));
}

export const clampZoom = (z: number): number => Math.min(LIMITS.zoomMax, Math.max(LIMITS.zoomMin, z));

/** Zoom slider uses a log scale: 0..1000 ↔ zoomMin..zoomMax. */
export const SLIDER_MAX = 1000;
export function zoomToSlider(z: number): number {
  const lo = Math.log(LIMITS.zoomMin);
  const hi = Math.log(LIMITS.zoomMax);
  return Math.round(((Math.log(clampZoom(z)) - lo) / (hi - lo)) * SLIDER_MAX);
}
export function sliderToZoom(v: number): number {
  const lo = Math.log(LIMITS.zoomMin);
  const hi = Math.log(LIMITS.zoomMax);
  return clampZoom(Math.exp(lo + (Math.min(SLIDER_MAX, Math.max(0, v)) / SLIDER_MAX) * (hi - lo)));
}

/**
 * scrollLeft that keeps `anchorUs` at the same on-screen offset (`offsetPx` from the lane's left
 * visible edge) after zooming to `zoom`.
 */
export const anchoredScroll = (anchorUs: Us, offsetPx: number, zoom: number): number =>
  Math.max(0, usToPx(anchorUs, zoom) - offsetPx);

/** Total lane width: the edit plus room to drop after the end, never less than the viewport. */
export function contentWidth(durationUs: Us, zoom: number, viewportPx: number): number {
  // filling the view stays 1px short of it: at a fractional page zoom a lane exactly as wide as the
  // view can overflow by a sub-pixel and toggle the scrollbars every frame (the timeline shook)
  return Math.max(Math.floor(viewportPx) - 1, Math.ceil(usToPx(durationUs, zoom) + Math.max(200, viewportPx * 0.6)));
}

/**
 * Lane width that never shrinks under the part of the timeline the user is looking at. Deleting or
 * trimming the last clip shortens the edit; without this the browser clamps scrollLeft and the
 * whole timeline jumps sideways (under the pointer, mid-trim). The extra room goes away as soon as
 * the user scrolls back.
 */
export function stableContentWidth(durationUs: Us, zoom: number, viewportPx: number, scrollLeft: number): number {
  // only when actually scrolled: at scrollLeft 0 this would make the lane exactly as wide as the
  // view and bring back the sub-pixel overflow contentWidth avoids
  const keep = scrollLeft > 0 ? Math.ceil(scrollLeft + viewportPx) : 0;
  return Math.max(contentWidth(durationUs, zoom, viewportPx), keep);
}

/** Where the playhead rides while playback follows it (fraction of the lane from the left). */
export const FOLLOW_AT = 0.75;

/**
 * Follow the playhead while playing. CapCut keeps the playhead in view without paging: once it
 * passes FOLLOW_AT of the lane the view scrolls along with it, so the content glides instead of
 * jumping a whole screen. A playhead that is off-screen (playback started elsewhere, or looped)
 * is brought in 10 % from the left. Returns the new scrollLeft or null.
 */
export function followScroll(playheadPx: number, scrollLeft: number, viewportPx: number): number | null {
  if (viewportPx <= 0) return null;
  if (playheadPx < scrollLeft || playheadPx > scrollLeft + viewportPx) return Math.max(0, Math.round(playheadPx - viewportPx * 0.1));
  const lead = viewportPx * FOLLOW_AT;
  if (playheadPx > scrollLeft + lead) return Math.round(playheadPx - lead);
  return null;
}

/**
 * Heights of the empty bands above and below the track stack. The main track keeps the place it
 * has in an empty project (55 % of the free space above it) while tracks are added or removed:
 * a new audio track below or overlay above takes space from its own band, so nothing the user is
 * looking at moves. Only when the stack no longer fits does the main track move up, so that
 * everything stays visible before a vertical scrollbar is needed.
 */
export function bandHeights(rowsAreaH: number, aboveH: number, mainH: number, belowH: number, bandMin: number): { top: number; bottom: number } {
  const homeY = bandMin + Math.floor(Math.max(0, rowsAreaH - mainH - 2 * bandMin) * 0.55);
  const fitTop = rowsAreaH - aboveH - mainH - belowH - bandMin;
  const top = Math.max(bandMin, Math.min(homeY - aboveH, fitTop));
  const bottom = Math.max(bandMin, rowsAreaH - top - aboveH - mainH - belowH);
  return { top, bottom };
}

// ---------------------------------------------------------------- placement helpers

/**
 * Where a clip dropped at `at` lands on a magnetic main track (mirrors the store's midpoint rule):
 * the cut after the last clip whose midpoint is ≤ at. Clips listed in `exclude` are ignored and
 * the remaining clips are treated as packed from 0 (as they will be after the move).
 */
export function magnetInsertCut(clips: readonly Clip[], at: Us, exclude: readonly Id[] = []): Us {
  const ex = new Set(exclude);
  let t = 0;
  for (const c of clips) {
    if (ex.has(c.id)) continue;
    if (t + c.duration / 2 <= at) t += c.duration;
    else break;
  }
  return t;
}

/** The cut between two adjacent clips of `track` nearest to `t` within `thresholdUs`. */
export function nearestCut(track: Track, t: Us, thresholdUs: number): { fromClipId: Id; toClipId: Id; at: Us } | null {
  let best: { fromClipId: Id; toClipId: Id; at: Us } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < track.clips.length - 1; i++) {
    const a = track.clips[i]!;
    const b = track.clips[i + 1]!;
    if (clipEnd(a) !== b.start) continue;
    const d = Math.abs(b.start - t);
    if (d < bestD && d <= thresholdUs) {
      bestD = d;
      best = { fromClipId: a.id, toClipId: b.id, at: b.start };
    }
  }
  return best;
}

/** Clips of a track whose span intersects [t0, t1). */
export const clipsInSpan = (track: Track, t0: Us, t1: Us): Clip[] =>
  track.clips.filter((c) => c.start < t1 && clipEnd(c) > t0);

/** "2.0x" speed badge text, or null at 1×. */
export function speedBadge(speed: number): string | null {
  if (Math.abs(speed - 1) < 1e-6) return null;
  return speed >= 10 ? `${Math.round(speed)}x` : `${speed.toFixed(1)}x`;
}
