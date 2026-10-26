/**
 * Edit operations. Each function MUTATES a Project draft (immer) and is called by the store
 * inside `edit()`, which then runs `normalize()`. Keep them free of React and DOM.
 */
import { current, isDraft } from 'immer';
import { LIMITS } from '../model/catalog';
import {
  DEFAULT_TRANSITION_DURATION,
  createClipFromAsset,
  createTextClip,
  createTrack,
  createTransition,
  newId,
} from '../model/defaults';
import { sequenceDuration } from '../model/compound';
import { shiftLocalMotionKeys, usesLocalKeyTime } from '../model/motionKeys';
import { adjacentNext, audioLinked, findClip, isRangeFree, isTimedClip, mainTrack, timelineRows, trackAccepts } from '../model/project';
import { curveIntegral, curveMean, extendCurve, normalizeCurve, sliceCurve, type SpeedCurve } from '../model/speedCurve';
import { clamp, clipContains, clipEnd, clipMeanSpeed, durationForSpan, frameUs, sourceOffsetAt, sourceSpan } from '../model/time';
import type { AnimationSlot, Clip, ClipAnimation, ClipPatch, Id, Project, TimedClip, Track, TrackKind, TransitionType, Us } from '../model/types';
import { ANIM_LIMITS } from '../engine/animations';
import { captionSplit, captionTrimStart, syncCaptionClip } from '../captions/ops';

export interface EditCtx {
  magnet: boolean;
}

export const minClipUs = (p: Project): Us => Math.ceil(frameUs(p.settings.fps));

/** Length of a compound clip's sequence (null = unknown sequence, or it is open for editing right now). */
function compoundAvailable(p: Project, c: Extract<Clip, { type: 'compound' }>): Us | null {
  if (!p.sequences?.[c.sequenceId] || (p.focus ?? []).some((f) => f.sequenceId === c.sequenceId)) return null;
  return sequenceDuration(p, c.sequenceId);
}

/** Deep copy that works on immer drafts and plain objects. */
const cloneClip = (c: Clip): Clip => structuredClone(isDraft(c) ? current(c) : c);

/**
 * Keeps the items that pass `keep`, IN PLACE: an immer draft is only touched when something is
 * removed. (`arr = arr.filter(…)` always writes a new array, so every edit — even a refused one —
 * produced a "changed" project and an empty undo step.)
 */
export function retain<T>(arr: T[], keep: (x: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (!keep(arr[i]!)) arr.splice(i, 1);
}

// ---------------------------------------------------------------- normalize

/**
 * Restores every invariant after an edit:
 * - clips sorted, trackId consistent, no overlaps (later clips pushed right);
 * - main track packed from 0 when magnet is on;
 * - animation / fade durations fit the clip;
 * - transitions only between adjacent clips, durations clamped to half the shorter clip;
 * - all times integers.
 */
export function normalize(p: Project, ctx: EditCtx): void {
  const min = minClipUs(p);
  for (const track of p.tracks) {
    for (const c of track.clips) {
      c.trackId = track.id;
      c.start = Math.max(0, Math.round(c.start));
      c.duration = Math.max(min, Math.round(c.duration));
      if (isTimedClip(c)) {
        c.inPoint = Math.max(0, Math.round(c.inPoint));
        const asset = p.assets[c.assetId];
        if (asset) fitToMedia(c, asset.duration, min);
      }
      if (c.type === 'compound') {
        // a compound clip never shows past the end of its sequence
        c.inPoint = Math.max(0, Math.round(c.inPoint));
        const avail = compoundAvailable(p, c);
        if (avail !== null) {
          if (c.inPoint > avail - min) c.inPoint = Math.max(0, avail - min);
          c.duration = Math.max(min, Math.min(c.duration, avail - c.inPoint));
        }
      }
      if (c.type !== 'audio') {
        if (c.animationIn) c.animationIn.duration = clamp(Math.round(c.animationIn.duration), 0, c.duration);
        if (c.animationOut) {
          const room = c.duration - (c.animationIn?.duration ?? 0);
          c.animationOut.duration = clamp(Math.round(c.animationOut.duration), 0, room);
        }
        if (c.animationCombo) c.animationCombo.duration = clamp(Math.round(c.animationCombo.duration), 0, c.duration);
        if (c.animationLoop) c.animationLoop.duration = clamp(Math.round(c.animationLoop.duration), ANIM_LIMITS.loopMinUs, ANIM_LIMITS.loopMaxUs);
      }
      if (c.type === 'text' && c.caption) syncCaptionClip(c); // captions: text = the words shown
      if (c.type === 'video' || c.type === 'audio') {
        c.audio.fadeIn = clamp(Math.round(c.audio.fadeIn), 0, c.duration);
        c.audio.fadeOut = clamp(Math.round(c.audio.fadeOut), 0, c.duration - c.audio.fadeIn);
      }
    }
    track.clips.sort((a, b) => a.start - b.start);
    if (track.kind === 'main' && ctx.magnet) {
      let t = 0;
      for (const c of track.clips) {
        c.start = t;
        t += c.duration;
      }
    } else {
      let end = 0;
      for (const c of track.clips) {
        if (c.start < end) c.start = end;
        end = clipEnd(c);
      }
    }
    pruneTransitions(p, track);
  }
  pruneAudioLinks(p);
}

/**
 * A timed clip never reads past the end of its media: [inPoint, inPoint + duration × speed] must
 * lie inside [0, mediaDuration]. Shortens the clip (or, when not even one frame is left after the
 * in-point, moves the in-point back / lowers the speed). Every op already clamps; this is the
 * safety net for rounding at fractional speeds and the 1-frame minimum.
 */
function fitToMedia(c: TimedClip, mediaUs: Us, min: Us): void {
  if (mediaUs <= 0) return;
  const EPS = 1e-3;
  const speed = clipMeanSpeed(c); // a speed curve reads duration × its mean speed of source
  if (c.inPoint + c.duration * speed <= mediaUs + EPS) return;
  const d = Math.floor((mediaUs - c.inPoint) / speed + EPS);
  if (d >= min) {
    c.duration = d;
    return;
  }
  // not even one frame fits: fall back to a standard speed that fits
  c.duration = min;
  c.speedCurve = null;
  c.speed = speed;
  if (min * c.speed > mediaUs + EPS) c.speed = Math.max(LIMITS.speedMin, mediaUs / min);
  c.inPoint = Math.max(0, Math.floor(mediaUs - min * c.speed));
}

/**
 * Extract-audio links come in pairs: a link id carried only by video clips (its audio was deleted)
 * or only by audio clips (its video was deleted) is dropped. The video stays muted; ⌘⇧S then
 * extracts again.
 */
function pruneAudioLinks(p: Project): void {
  const sides = new Map<Id, { video: boolean; audio: boolean }>();
  for (const t of p.tracks) for (const c of t.clips) {
    if ((c.type === 'video' || c.type === 'audio') && c.audioLink) {
      const s = sides.get(c.audioLink) ?? { video: false, audio: false };
      s[c.type] = true;
      sides.set(c.audioLink, s);
    }
  }
  for (const t of p.tracks) for (const c of t.clips) {
    if ((c.type === 'video' || c.type === 'audio') && c.audioLink) {
      const s = sides.get(c.audioLink)!;
      if (!s.video || !s.audio) delete c.audioLink;
    }
  }
}

/** Copies get their own link ids (pairs copied together stay paired; a lone copy is unlinked by normalize). */
function relink(clips: Clip[]): void {
  const map = new Map<Id, Id>();
  for (const c of clips) {
    if ((c.type === 'video' || c.type === 'audio') && c.audioLink) {
      if (!map.has(c.audioLink)) map.set(c.audioLink, newId('lnk'));
      c.audioLink = map.get(c.audioLink)!;
    }
  }
}

function pruneTransitions(p: Project, track: Track): void {
  const min = minClipUs(p);
  retain(track.transitions, (tr) => {
    const next = adjacentNext(track, tr.fromClipId);
    return next !== undefined && next.id === tr.toClipId;
  });
  for (const tr of track.transitions) {
    const a = track.clips.find((c) => c.id === tr.fromClipId)!;
    const b = track.clips.find((c) => c.id === tr.toClipId)!;
    const max = Math.floor(Math.min(a.duration, b.duration) / 2);
    tr.duration = clamp(Math.round(tr.duration), Math.min(min, max), max);
  }
  // one transition per cut
  const seen = new Set<Id>();
  retain(track.transitions, (tr) => (seen.has(tr.fromClipId) ? false : (seen.add(tr.fromClipId), true)));
}

/** Removes empty non-main tracks. Called by actions that can empty a track (move, delete). */
export function removeEmptyTracks(p: Project): void {
  retain(p.tracks, (t) => t.kind === 'main' || t.clips.length > 0);
}

// ---------------------------------------------------------------- tracks

/**
 * Adds a track. Default position: visual kinds go on top of all visual tracks (end of array),
 * audio goes to the bottom of the audio stack (end of array). `index` overrides the array index.
 */
export function addTrack(p: Project, kind: Exclude<TrackKind, 'main'>, index?: number): Track {
  const t = createTrack(kind);
  const i = index === undefined ? p.tracks.length : clamp(index, 1, p.tracks.length);
  p.tracks.splice(i, 0, t);
  return p.tracks[i]!;
}

/** Finds a track of `kind` free on [start, start+duration), else creates one. */
export function freeTrack(p: Project, kind: Exclude<TrackKind, 'main'>, start: Us, duration: Us, ignoreClipId?: Id): Track {
  const found = p.tracks.find((t) => t.kind === kind && !t.locked && isRangeFree(t, start, start + duration, ignoreClipId));
  return found ?? addTrack(p, kind);
}

// ---------------------------------------------------------------- placement

/** Index at which a clip starting at `at` (length `dur`) is inserted among `clips` (midpoint rule). */
function insertIndex(clips: Clip[], at: Us): number {
  let i = 0;
  for (const c of clips) {
    if (c.start + c.duration / 2 <= at) i++;
    else break;
  }
  return i;
}

/** Inserts on the main track at the cut nearest to `at`; later clips ripple right. */
export function insertOnMain(p: Project, clip: Clip, at: Us, ctx: EditCtx): void {
  const track = mainTrack(p);
  const i = insertIndex(track.clips, at);
  const prev = track.clips[i - 1];
  const next = track.clips[i];
  if (ctx.magnet) clip.start = prev ? clipEnd(prev) : 0;
  else {
    clip.start = Math.max(at, prev ? clipEnd(prev) : 0);
    if (next && clipEnd(clip) > next.start) {
      const shift = clipEnd(clip) - next.start;
      for (const c of track.clips.slice(i)) c.start += shift;
    }
  }
  clip.trackId = track.id;
  track.clips.splice(i, 0, clip);
}

/** Places a clip on a non-main track at `at`; if it overlaps, a new track of the same kind is used. */
function placeOnTrack(p: Project, clip: Clip, track: Track, at: Us): void {
  clip.start = Math.max(0, at);
  let target = track;
  if (!isRangeFree(track, clip.start, clipEnd(clip), clip.id)) {
    const idx = p.tracks.indexOf(track);
    target = addTrack(p, track.kind as Exclude<TrackKind, 'main'>, idx + 1);
  }
  clip.trackId = target.id;
  target.clips.push(clip);
}

export interface AddClipOpts {
  /** Timeline time; default = playhead (passed by the store). */
  at: Us;
  /** Target track. Must accept the clip type; otherwise a default track is chosen. */
  trackId?: Id;
  /** For video/image without trackId: 'main' (default) or 'overlay'. */
  kind?: 'main' | 'overlay';
}

export function addClipFromAsset(p: Project, assetId: Id, opts: AddClipOpts, ctx: EditCtx): Id | null {
  const asset = p.assets[assetId];
  if (!asset) return null;
  const at = Math.max(0, Math.round(opts.at));
  const clip = createClipFromAsset(asset, '', at);
  const explicit = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : undefined;
  if (explicit && !explicit.locked && trackAccepts(explicit.kind, clip)) {
    if (explicit.kind === 'main') insertOnMain(p, clip, at, ctx);
    else placeOnTrack(p, clip, explicit, at);
  } else if (clip.type === 'audio') {
    placeOnTrack(p, clip, freeTrack(p, 'audio', at, clip.duration), at);
  } else if (opts.kind === 'overlay' || mainTrack(p).locked) {
    // a locked main track is never touched: the clip goes to a free overlay track instead
    placeOnTrack(p, clip, freeTrack(p, 'overlay', at, clip.duration), at);
  } else {
    insertOnMain(p, clip, at, ctx);
  }
  return clip.id;
}

export function addTextClip(p: Project, opts: { at: Us; content?: string; trackId?: Id }): Id {
  const at = Math.max(0, Math.round(opts.at));
  const clip = createTextClip('', at, opts.content);
  const explicit = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId && t.kind === 'text' && !t.locked) : undefined;
  placeOnTrack(p, clip, explicit ?? freeTrack(p, 'text', at, clip.duration), at);
  return clip.id;
}

// ---------------------------------------------------------------- move / trim

/** Detaches a clip (and its transitions) from its track. */
function detach(p: Project, clipId: Id): Clip | null {
  const f = findClip(p, clipId);
  if (!f) return null;
  f.track.clips.splice(f.index, 1);
  return f.clip;
}

/** Kind of track a clip goes to when it needs a fresh one (video/image → overlay). */
export function newTrackKindFor(clip: Pick<Clip, 'type'>): Exclude<TrackKind, 'main'> {
  return clip.type === 'audio' ? 'audio' : clip.type === 'text' ? 'text' : 'overlay';
}

/**
 * Array index for a new track of `kind` shown directly above/below `ref` in the timeline.
 * Visual tracks display in reverse array order (index 0 = bottom); audio tracks in array order.
 * Nothing goes below the main track among the visual rows. undefined = default position.
 */
function indexNextTo(p: Project, ref: Track | undefined, kind: Exclude<TrackKind, 'main'>, side: 'above' | 'below'): number | undefined {
  if (!ref) return undefined;
  const ri = p.tracks.indexOf(ref);
  const refVisual = ref.kind !== 'audio';
  const newVisual = kind !== 'audio';
  if (refVisual !== newVisual) return undefined;
  if (newVisual) return side === 'above' || ref.kind === 'main' ? ri + 1 : ri;
  return side === 'above' ? ri : ri + 1;
}

/**
 * Moves a clip to `start` on `trackId` (default: same track).
 * Main track + magnet: reorders by insertion. Other tracks: if the spot is taken, a new track
 * of the same kind is created just above the target. Incompatible targets are refused.
 * `newTrack`: the clip goes onto a NEW track directly above/below `trackId` (or its own track).
 */
export function moveClip(p: Project, clipId: Id, to: { start: Us; trackId?: Id; newTrack?: 'above' | 'below' }, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const start = Math.max(0, Math.round(to.start));
  if (to.newTrack) {
    const ref = to.trackId ? p.tracks.find((t) => t.id === to.trackId) : f.track;
    const kind = newTrackKindFor(f.clip);
    const index = indexNextTo(p, ref, kind, to.newTrack);
    const clip = detach(p, clipId)!;
    const track = addTrack(p, kind, index);
    clip.start = start;
    clip.trackId = track.id;
    track.clips.push(clip);
    removeEmptyTracks(p);
    return true;
  }
  const target = to.trackId ? p.tracks.find((t) => t.id === to.trackId) : f.track;
  if (!target || target.locked || !trackAccepts(target.kind, f.clip)) return false;
  const clip = detach(p, clipId)!;
  if (target.kind === 'main') insertOnMain(p, clip, start + clip.duration / 2 - 1, ctx);
  else placeOnTrack(p, clip, target, start);
  removeEmptyTracks(p);
  return true;
}

/**
 * Moves several clips by the same time delta. `trackDelta` shifts each clip that many rows in the
 * timeline's display order (negative = up); a clip whose target row is missing, locked or does
 * not accept it stays on its own track. Clips on locked tracks are not moved.
 */
export function moveClips(p: Project, ids: readonly Id[], deltaUs: Us, trackDelta: number, ctx: EditCtx): boolean {
  const rows = timelineRows(p);
  const plan: { clip: Clip; target: Track; start: Us }[] = [];
  for (const id of ids) {
    const f = findClip(p, id);
    if (!f || f.track.locked) continue;
    let target = f.track;
    if (trackDelta) {
      const cand = rows[rows.indexOf(f.track) + trackDelta];
      if (cand && !cand.locked && trackAccepts(cand.kind, f.clip)) target = cand;
    }
    plan.push({ clip: f.clip, target, start: Math.max(0, Math.round(f.clip.start + deltaUs)) });
  }
  if (!plan.length) return false;
  plan.sort((a, b) => a.start - b.start);
  const detached = plan.map((x) => ({ ...x, clip: detach(p, x.clip.id)! }));
  for (const { clip, target, start } of detached) {
    if (target.kind === 'main') insertOnMain(p, clip, start + clip.duration / 2 - 1, ctx);
    else placeOnTrack(p, clip, target, start);
  }
  removeEmptyTracks(p);
  return true;
}

/**
 * Inserts re-id'd copies of clip snapshots (e.g. the clipboard after ⌘X), keeping their relative
 * offsets; the earliest lands at `at`. Each copy goes back to its original track when it still
 * exists, is unlocked and accepts it, else to the default track for its type. Media clips whose
 * asset is gone are skipped. Returns the new ids.
 */
export function insertClips(p: Project, clips: readonly Clip[], at: Us, ctx: EditCtx): Id[] {
  const usable = clips.filter((c) => c.type === 'text' || (c.type === 'compound' ? !!p.sequences?.[c.sequenceId] : p.assets[c.assetId]));
  if (!usable.length) return [];
  const minStart = Math.min(...usable.map((c) => c.start));
  const base = Math.max(0, Math.round(at));
  const out: Id[] = [];
  const sorted = [...usable].sort((a, b) => a.start - b.start);
  const copies = sorted.map(cloneClip);
  relink(copies);
  const mainLocked = mainTrack(p).locked;
  sorted.forEach((src, i) => {
    const clip = copies[i]!;
    clip.id = newId('clp');
    const start = base + (src.start - minStart);
    const orig = p.tracks.find((t) => t.id === src.trackId && !t.locked && trackAccepts(t.kind, clip));
    if (orig?.kind === 'main' || (!orig && !mainLocked && (clip.type === 'video' || clip.type === 'image'))) {
      insertOnMain(p, clip, start, ctx);
    } else {
      const kind = newTrackKindFor(clip);
      placeOnTrack(p, clip, orig ?? freeTrack(p, kind, start, clip.duration), start);
    }
    out.push(clip.id);
  });
  return out;
}

/** Drag of the LEFT edge to timeline time `newStart`. Clamped to source, neighbour and 1 frame. */
export function trimStart(p: Project, clipId: Id, newStart: Us, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip;
  const end = clipEnd(c);
  let s = Math.round(newStart);
  s = Math.min(s, end - minClipUs(p));
  s = Math.max(s, 0);
  const prev = f.track.clips[f.index - 1];
  // magnet: the main track packs itself (normalize); any other track ripples (below) — either way
  // the left edge stays put, so the neighbour is no limit
  if (prev && !ctx.magnet) s = Math.max(s, clipEnd(prev));
  if (isTimedClip(c)) {
    if (c.speedCurve) {
      const r = trimCurveStart(c, s, p.assets[c.assetId]?.duration);
      s = r.start;
    } else {
      // inPoint must stay >= 0: earliest start = start - inPoint / speed
      s = Math.max(s, c.start - Math.floor(c.inPoint / c.speed));
      // floor: the source end (inPoint + duration × speed) never grows past where it was
      c.inPoint = Math.max(0, Math.floor(c.inPoint + (s - c.start) * c.speed + 1e-6));
    }
  }
  if (c.type === 'compound') {
    s = Math.max(s, c.start - c.inPoint);
    c.inPoint = Math.max(0, c.inPoint + (s - c.start));
  }
  c.duration = end - s;
  const shift = s - c.start;
  if (usesLocalKeyTime(c) && c.type !== 'audio' && c.motionKeys) c.motionKeys = shiftLocalMotionKeys(c.motionKeys, shift);
  captionTrimStart(c, shift); // captions: the words stay on their sound
  c.start = s;
  if (ctx.magnet && f.track.kind !== 'main') {
    c.start -= shift;
    rippleTrim(f.track, c, shift);
  }
  return true;
}

/**
 * Magnet on a track other than main (CapCut only packs the main track): a trim ripples instead of
 * leaving a gap. Left edge: the clip keeps its start (it "sticks left") and the clips after it on
 * the track move by the trimmed amount. Right edge: the clips after it move with the edge. Gaps the
 * user left between clips are kept.
 */
function rippleTrim(track: Track, c: Clip, shortenedBy: Us): void {
  if (!shortenedBy) return;
  for (const o of track.clips) if (o !== c && o.start > c.start) o.start -= shortenedBy;
}

/** Drag of the RIGHT edge to timeline time `newEnd`. */
export function trimEnd(p: Project, clipId: Id, newEnd: Us, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip;
  let e = Math.round(newEnd);
  e = Math.max(e, c.start + minClipUs(p));
  const next = f.track.clips[f.index + 1];
  const ripple = ctx.magnet && f.track.kind !== 'main';
  if (next && !ctx.magnet) e = Math.min(e, next.start);
  const oldEnd = clipEnd(c);
  if (isTimedClip(c) && c.speedCurve) {
    trimCurveEnd(c, Math.max(minClipUs(p), e - c.start), p.assets[c.assetId]?.duration);
    if (ripple) rippleTrim(f.track, c, oldEnd - clipEnd(c));
    return true;
  }
  if (isTimedClip(c)) {
    const asset = p.assets[c.assetId];
    if (asset) e = Math.min(e, c.start + Math.floor((asset.duration - c.inPoint) / c.speed));
  }
  if (c.type === 'compound') {
    const avail = compoundAvailable(p, c);
    if (avail !== null) e = Math.min(e, c.start + avail - c.inPoint);
  }
  c.duration = Math.max(minClipUs(p), e - c.start);
  if (ripple) rippleTrim(f.track, c, oldEnd - clipEnd(c));
  return true;
}

// ---------------------------------------------------------------- curve trimming (exact)

/** Plain (non-draft) copy of a curve, so the integral cache keys on stable arrays. */
const plainCurve = (curve: SpeedCurve): SpeedCurve => structuredClone(isDraft(curve) ? current(curve) : curve);

/**
 * Moves the left edge of a curve clip to timeline time `s`. Inwards: the curve is cut at the new
 * edge (exact) and inPoint advances by the source played in the removed part. Outwards: the curve
 * is extended at its first speed, limited so inPoint stays >= 0. Returns the applied start.
 */
function trimCurveStart(c: TimedClip, s: Us, _assetDuration: Us | undefined): { start: Us } {
  const curve = plainCurve(c.speedCurve!);
  const D = c.duration;
  const end = c.start + D;
  if (s >= c.start) {
    const a = (s - c.start) / D;
    const cut = D * curveIntegral(curve, a);
    c.inPoint = Math.floor(c.inPoint + cut + 1e-6); // floor: never past the old source end
    c.speedCurve = sliceCurve(curve, a, 1);
    c.duration = end - s;
    c.start = s;
    return { start: s };
  }
  // extend to the left
  const srcBefore = (before: number) => {
    const ext = extendCurve(curve, D, before, 0);
    return { ext, src: (D + before) * curveIntegral(ext, before / (D + before)) };
  };
  let before = c.start - s;
  let r = srcBefore(before);
  if (r.src > c.inPoint) {
    let lo = 0;
    let hi = before;
    for (let k = 0; k < 50 && hi - lo > 0.5; k++) {
      const mid = (lo + hi) / 2;
      if (srcBefore(mid).src > c.inPoint) hi = mid;
      else lo = mid;
    }
    before = Math.floor(lo);
    r = srcBefore(before);
  }
  const ns = c.start - before;
  c.inPoint = Math.max(0, Math.round(c.inPoint - r.src));
  c.speedCurve = r.ext;
  c.duration = end - ns;
  c.start = ns;
  return { start: ns };
}

/**
 * Sets a curve clip's duration by moving its right edge. Inwards: the curve is cut (exact).
 * Outwards: extended at its last speed, limited by the end of the source.
 */
function trimCurveEnd(c: TimedClip, duration: Us, assetDuration: Us | undefined): void {
  const curve = plainCurve(c.speedCurve!);
  const D = c.duration;
  if (duration <= D) {
    c.speedCurve = sliceCurve(curve, 0, duration / D);
    c.duration = duration;
    return;
  }
  const spanFor = (after: number) => {
    const ext = extendCurve(curve, D, 0, after);
    return { ext, span: (D + after) * curveMean(ext) };
  };
  let after = duration - D;
  let r = spanFor(after);
  if (assetDuration !== undefined && c.inPoint + r.span > assetDuration) {
    let lo = 0;
    let hi = after;
    for (let k = 0; k < 50 && hi - lo > 0.5; k++) {
      const mid = (lo + hi) / 2;
      if (c.inPoint + spanFor(mid).span > assetDuration) hi = mid;
      else lo = mid;
    }
    after = Math.floor(lo);
    r = spanFor(after);
  }
  c.speedCurve = after > 0 ? r.ext : curve;
  c.duration = D + after;
}

// ---------------------------------------------------------------- split / delete

/** Splits a clip at timeline time t. Returns the id of the right-hand part, or null. */
export function splitClip(p: Project, clipId: Id, t: Us): Id | null {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return null;
  const a = f.clip;
  const min = minClipUs(p);
  if (t < a.start + min || t > clipEnd(a) - min) return null;
  const b = cloneClip(a);
  b.id = newId('clp');
  b.start = t;
  b.duration = clipEnd(a) - t;
  if (isTimedClip(b) && isTimedClip(a)) {
    // the right part starts where the left part's source ends: inPoint + ∫ speed over the left part
    // floor: the right part never reads past the original source end (rounding at fractional speeds)
    b.inPoint = Math.floor(a.inPoint + sourceOffsetAt(a, t - a.start) + 1e-6);
    if (a.speedCurve) {
      // each part keeps its own piece of the curve (exact cut)
      const curve = plainCurve(a.speedCurve);
      const x = (t - a.start) / a.duration;
      a.speedCurve = sliceCurve(curve, 0, x);
      b.speedCurve = sliceCurve(curve, x, 1);
    }
  }
  if (a.type === 'compound' && b.type === 'compound') b.inPoint = a.inPoint + (t - a.start);
  if (usesLocalKeyTime(b) && b.type !== 'audio' && b.motionKeys) b.motionKeys = shiftLocalMotionKeys(b.motionKeys, t - a.start);
  captionSplit(b, t - a.start); // captions: the right part's words stay on their sound
  a.duration = t - a.start;
  if (a.type !== 'audio' && b.type !== 'audio') {
    a.animationOut = null;
    b.animationIn = null;
    b.animationCombo = null; // the combo plays from the clip start: it stays on the left part
  }
  if ((a.type === 'video' || a.type === 'audio') && (b.type === 'video' || b.type === 'audio')) {
    a.audio.fadeOut = 0;
    b.audio.fadeIn = 0;
  }
  f.track.clips.splice(f.index + 1, 0, b);
  for (const tr of f.track.transitions) if (tr.fromClipId === a.id) tr.fromClipId = b.id;
  return b.id;
}

export function deleteClips(p: Project, ids: readonly Id[]): number {
  const set = new Set(ids);
  let n = 0;
  for (const track of p.tracks) {
    if (track.locked) continue;
    const before = track.clips.length;
    retain(track.clips, (c) => !set.has(c.id));
    n += before - track.clips.length;
    retain(track.transitions, (t) => !set.has(t.fromClipId) && !set.has(t.toClipId));
  }
  removeEmptyTracks(p);
  return n;
}

/**
 * Removes every clip that uses `assetId` (the asset is leaving the bin), on locked tracks too: a
 * clip must never outlive its media. Their transitions go with them. Returns how many.
 */
export function removeAssetClips(p: Project, assetId: Id): number {
  let n = 0;
  for (const track of p.tracks) {
    const gone = new Set(track.clips.filter((c) => c.type !== 'text' && c.type !== 'compound' && c.assetId === assetId).map((c) => c.id));
    if (!gone.size) continue;
    track.clips = track.clips.filter((c) => !gone.has(c.id));
    track.transitions = track.transitions.filter((t) => !gone.has(t.fromClipId) && !gone.has(t.toClipId));
    n += gone.size;
  }
  if (n) removeEmptyTracks(p);
  return n;
}

/** Delete-left (Q): removes the part of the clip before t. */
export function deleteLeft(p: Project, clipId: Id, t: Us, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || !clipContains(f.clip, t) || t === f.clip.start) return false;
  return trimStart(p, clipId, t, ctx);
}

/** Delete-right (W): removes the part of the clip after t. */
export function deleteRight(p: Project, clipId: Id, t: Us, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || !clipContains(f.clip, t) || t === f.clip.start) return false;
  return trimEnd(p, clipId, t, ctx);
}

/** Duplicates clips right after themselves. Returns the new ids. */
export function duplicateClips(p: Project, ids: readonly Id[], ctx: EditCtx): Id[] {
  const out: Id[] = [];
  for (const id of ids) {
    const f = findClip(p, id);
    if (!f || f.track.locked) continue;
    const copy = cloneClip(f.clip);
    copy.id = newId('clp');
    relink([copy]);
    const at = clipEnd(f.clip);
    if (f.track.kind === 'main') {
      copy.start = at;
      copy.trackId = f.track.id;
      f.track.clips.splice(f.index + 1, 0, copy);
      if (!ctx.magnet) {
        const later = f.track.clips.slice(f.index + 2);
        const overlap = later[0] ? clipEnd(copy) - later[0].start : 0;
        if (overlap > 0) for (const c of later) c.start += overlap;
      }
    } else {
      placeOnTrack(p, copy, f.track, at);
    }
    out.push(copy.id);
  }
  return out;
}

// ---------------------------------------------------------------- props / speed

const MERGE_KEYS = ['transform', 'crop', 'adjust', 'audio', 'mask', 'chroma', 'canvas'] as const;

export function updateClip(p: Project, clipId: Id, patch: ClipPatch): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip as Clip & Record<string, unknown>;
  for (const key of Object.keys(patch) as (keyof ClipPatch)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === 'name' || key === 'disabled') {
      (c as Record<string, unknown>)[key] = v;
      continue;
    }
    if (key === 'animationIn' || key === 'animationOut' || key === 'animationCombo' || key === 'animationLoop') {
      // set even on clips saved before the field existed
      if (c.type !== 'audio') (c as Record<string, unknown>)[key] = v === null ? null : { ...(v as object) };
      continue;
    }
    if (key === 'motionKeys') {
      // whole value (clips saved before the field existed get it too); null = no keys
      if (c.type !== 'audio') {
        if (v === null) delete (c as Record<string, unknown>).motionKeys;
        else (c as Record<string, unknown>).motionKeys = JSON.parse(JSON.stringify(v));
      }
      continue;
    }
    if (key === 'blendEnabled' || key === 'adjustEnabled') {
      if (c.type !== 'audio') (c as Record<string, unknown>)[key] = !!v;
      continue;
    }
    if (!(key in c)) continue; // field not on this clip type
    if (key === 'grade') {
      // each section is replaced as a whole; clone so clips never share nested objects
      Object.assign(c.grade as object, JSON.parse(JSON.stringify(v)) as object);
    } else if ((MERGE_KEYS as readonly string[]).includes(key)) {
      Object.assign(c[key] as object, v);
    } else if (key === 'text' && c.type === 'text') {
      const tp = v as NonNullable<ClipPatch['text']>;
      const { stroke, background, shadow, ...rest } = tp;
      Object.assign(c.text, rest);
      if (stroke) Object.assign(c.text.stroke, stroke);
      if (background) Object.assign(c.text.background, background);
      if (shadow) Object.assign(c.text.shadow, shadow);
      if (rest.content !== undefined) c.name = rest.content.split('\n')[0] || 'Text';
    } else {
      (c as Record<string, unknown>)[key] = v === null ? null : typeof v === 'object' ? { ...(v as object) } : v;
    }
  }
  if (c.type !== 'audio' && patch.transform?.scale !== undefined) {
    c.transform.scale = clamp(c.transform.scale, LIMITS.scaleMin, LIMITS.scaleMax);
  }
  if (c.type !== 'audio' && patch.transform) {
    if (patch.transform.scaleX !== undefined) c.transform.scaleX = clamp(c.transform.scaleX, LIMITS.scaleMin, LIMITS.scaleMax);
    if (patch.transform.scaleY !== undefined) c.transform.scaleY = clamp(c.transform.scaleY, LIMITS.scaleMin, LIMITS.scaleMax);
  }
  if ((c.type === 'video' || c.type === 'image') && patch.mask) {
    const m = c.mask;
    m.feather = clamp(m.feather, 0, 100);
    m.roundCorners = clamp(m.roundCorners, 0, 100);
    m.width = clamp(m.width, 0.01, 20);
    m.height = clamp(m.height, 0.01, 20);
  }
  if ((c.type === 'video' || c.type === 'image') && patch.chroma) {
    c.chroma.intensity = clamp(c.chroma.intensity, 0, 100);
    c.chroma.shadow = clamp(c.chroma.shadow, 0, 100);
  }
  if ((c.type === 'video' || c.type === 'image') && patch.canvas?.blur !== undefined) {
    c.canvas.blur = clamp(Math.round(c.canvas.blur), 1, 4);
  }
  if ((c.type === 'video' || c.type === 'audio') && patch.audio?.volumeDb !== undefined) {
    c.audio.volumeDb = clamp(c.audio.volumeDb, LIMITS.volumeDbMin, LIMITS.volumeDbMax);
  }
  return true;
}

/**
 * Sets an animation slot the CapCut way. `type`: an id to apply, null to remove, undefined to
 * keep the current one (duration-only change).
 * - In / Out: default 0.5 s (or the slot's current duration), at least 0.1 s, at most the clip.
 *   In + Out never exceed the clip: the slot being edited wins and the OTHER one shrinks.
 *   Applying In or Out removes a Combo.
 * - Combo: default = the whole clip, at most the clip. Applying it removes In and Out.
 * - Loop (text): duration = one cycle, 0.1–5 s, default 1 s. Combines with In / Out.
 */
export function setClipAnimation(p: Project, clipId: Id, slot: AnimationSlot, type: string | null | undefined, duration?: Us): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked || f.clip.type === 'audio') return false;
  const c = f.clip;
  const key = SLOT_KEY[slot];
  const cur = (c[key] ?? null) as ClipAnimation | null;
  if (type === null) {
    c[key] = null;
    return true;
  }
  const id = type ?? cur?.type;
  if (!id) return false;
  const total = c.duration;
  const lo = Math.min(ANIM_LIMITS.minUs, total);
  if (slot === 'loop') {
    const d = clamp(Math.round(duration ?? cur?.duration ?? ANIM_LIMITS.defaultLoopUs), ANIM_LIMITS.loopMinUs, ANIM_LIMITS.loopMaxUs);
    c.animationLoop = { type: id, duration: d };
    return true;
  }
  if (slot === 'combo') {
    const d = clamp(Math.round(duration ?? cur?.duration ?? total), lo, total);
    c.animationCombo = { type: id, duration: d };
    c.animationIn = null;
    c.animationOut = null;
    return true;
  }
  const d = clamp(Math.round(duration ?? cur?.duration ?? ANIM_LIMITS.defaultInOutUs), lo, total);
  c[key] = { type: id, duration: d };
  c.animationCombo = null;
  const otherKey = slot === 'in' ? 'animationOut' : 'animationIn';
  const other = c[otherKey];
  if (other && other.duration > total - d) c[otherKey] = { ...other, duration: Math.max(0, total - d) };
  if (c[otherKey] && c[otherKey]!.duration <= 0) c[otherKey] = null;
  return true;
}

const SLOT_KEY = { in: 'animationIn', out: 'animationOut', combo: 'animationCombo', loop: 'animationLoop' } as const;

/**
 * Source span of a timed clip for a speed change. µs rounding of the timeline duration would
 * otherwise make the span drift by a µs per change; a span that ends within a few µs of the
 * source end is snapped to it (the common "whole clip" case), and never runs past it.
 */
function spanForSpeedChange(p: Project, c: TimedClip): Us {
  const span = sourceSpan(c);
  const asset = p.assets[c.assetId];
  if (!asset || asset.duration <= 0) return span;
  const room = asset.duration - c.inPoint;
  return Math.abs(span - room) <= 4 ? room : Math.min(span, room);
}

/**
 * Standard speed: the source span stays the same, the timeline duration changes. Like CapCut,
 * choosing a standard speed replaces a speed curve.
 */
export function setSpeed(p: Project, clipId: Id, speed: number): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked || !isTimedClip(f.clip)) return false;
  const c = f.clip;
  const min = minClipUs(p);
  const asset = p.assets[c.assetId];
  const avail = asset && asset.duration > 0 ? asset.duration - c.inPoint : Infinity;
  const span = Math.min(spanForSpeedChange(p, c), avail);
  let s = clamp(speed, LIMITS.speedMin, LIMITS.speedMax);
  // one frame at this speed must still fit in the media after the in-point
  if (min * s > avail) s = Math.max(LIMITS.speedMin, avail / min);
  c.speed = s;
  c.speedCurve = null;
  // floor: duration × speed stays within the source span (never past the media end)
  c.duration = Math.max(min, Math.floor(span / s + 1e-6));
  return true;
}

/** Sets the timeline duration. Timed clips back-compute (standard) speed; image/text just change length. */
export function setDuration(p: Project, clipId: Id, duration: Us): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip;
  const d = Math.max(minClipUs(p), Math.round(duration));
  if (isTimedClip(c)) return setSpeed(p, clipId, sourceSpan(c) / d);
  c.duration = d;
  return true;
}

/**
 * Speed › Curve. Applies (or with null removes) a speed curve; the source span stays the same
 * and the timeline duration becomes span / mean(curve). Applying a curve sets the standard speed
 * to 1x; removing it ("None") leaves the clip at 1x (CapCut).
 */
export function setSpeedCurve(p: Project, clipId: Id, curve: SpeedCurve | null): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked || !isTimedClip(f.clip)) return false;
  const c = f.clip;
  const span = spanForSpeedChange(p, c);
  c.speed = 1;
  c.speedCurve = curve ? normalizeCurve(plainCurve(curve)) : null;
  c.duration = Math.max(minClipUs(p), Math.round(durationForSpan(span, c)));
  return true;
}

// ---------------------------------------------------------------- extract / restore audio

/**
 * CapCut "Extract audio": a new audio clip on a NEW audio track, reading the same asset over the
 * same source span (inPoint, speed, pitch) at the same timeline position and carrying the video's
 * volume and fades. The video clip's own audio is muted and both get the same `audioLink` id.
 * Returns the new clip id, or null when the clip is not an unlocked video clip with audio, or its
 * audio is already extracted.
 */
export function extractAudio(p: Project, videoClipId: Id): Id | null {
  const f = findClip(p, videoClipId);
  if (!f || f.track.locked || f.clip.type !== 'video') return null;
  const v = f.clip;
  const asset = p.assets[v.assetId];
  if (!asset || asset.hasAudio === false) return null;
  if (v.audioLink && audioLinked(p, v.audioLink).some((c) => c.type === 'audio')) return null;
  const link = newId('lnk');
  const track = addTrack(p, 'audio');
  const clip = createClipFromAsset({ ...asset, kind: 'audio' }, track.id, v.start);
  if (clip.type !== 'audio') return null;
  clip.duration = v.duration;
  clip.inPoint = v.inPoint;
  clip.speed = v.speed;
  clip.speedCurve = v.speedCurve ? plainCurve(v.speedCurve) : null;
  clip.preservePitch = v.preservePitch;
  clip.reversed = v.reversed === true;
  clip.disabled = v.disabled;
  clip.audio = { ...v.audio, muted: false };
  clip.audioLink = link;
  track.clips.push(clip);
  v.audio.muted = true;
  v.audioLink = link;
  return clip.id;
}

/**
 * "Restore audio": removes the audio clips linked to this video clip, unmutes every linked video
 * clip and clears the link. Refused (false) when a linked clip sits on a locked track.
 */
export function restoreAudio(p: Project, videoClipId: Id): boolean {
  const f = findClip(p, videoClipId);
  if (!f || f.track.locked || f.clip.type !== 'video' || !f.clip.audioLink) return false;
  const linked = audioLinked(p, f.clip.audioLink);
  if (linked.some((c) => findClip(p, c.id)?.track.locked)) return false;
  for (const c of linked) {
    if (c.type === 'video') {
      c.audio.muted = false;
      delete c.audioLink;
    }
  }
  deleteClips(
    p,
    linked.filter((c) => c.type === 'audio').map((c) => c.id),
  );
  return true;
}

// ---------------------------------------------------------------- linkage

/** A video clip and its extracted audio clip that line up (same link id, same start). */
export interface LinkedPair {
  videoId: Id;
  audioId: Id;
  videoStart: Us;
  videoDuration: Us;
  audioStart: Us;
}

/** Every lined-up video/audio pair of extract-audio links in `p`. */
export function linkedPairs(p: Project): LinkedPair[] {
  const audio = new Map<Id, Clip[]>();
  for (const t of p.tracks) for (const c of t.clips) {
    if (c.type === 'audio' && c.audioLink) audio.set(c.audioLink, [...(audio.get(c.audioLink) ?? []), c]);
  }
  const out: LinkedPair[] = [];
  if (!audio.size) return out;
  for (const t of p.tracks) for (const v of t.clips) {
    if (v.type !== 'video' || !v.audioLink) continue;
    const a = audio.get(v.audioLink)?.find((x) => x.start === v.start);
    if (a) out.push({ videoId: v.id, audioId: a.id, videoStart: v.start, videoDuration: v.duration, audioStart: a.start });
  }
  return out;
}

/**
 * Linkage: after an edit, an audio clip whose linked video was MOVED (start changed, length kept)
 * while the audio itself stayed put follows it by the same time delta. Trims (length changed) and
 * audio on locked tracks are left alone. Returns true when something moved.
 */
export function followLinked(p: Project, pairs: readonly LinkedPair[], ctx: EditCtx): boolean {
  let moved = false;
  for (const pr of pairs) {
    const v = findClip(p, pr.videoId);
    const a = findClip(p, pr.audioId);
    if (!v || !a || a.track.locked) continue;
    const delta = v.clip.start - pr.videoStart;
    if (!delta || v.clip.duration !== pr.videoDuration || a.clip.start !== pr.audioStart) continue;
    moveClip(p, pr.audioId, { start: pr.audioStart + delta }, ctx);
    moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------- transitions

/** Adds (or replaces) the transition on the cut after `fromClipId`. Returns its id or null. */
export function addTransition(p: Project, fromClipId: Id, type: TransitionType, duration: Us = DEFAULT_TRANSITION_DURATION): Id | null {
  const f = findClip(p, fromClipId);
  if (!f || f.track.locked || f.clip.type === 'audio') return null;
  const next = adjacentNext(f.track, fromClipId);
  if (!next) return null;
  const existing = f.track.transitions.find((t) => t.fromClipId === fromClipId);
  if (existing) {
    existing.type = type;
    existing.toClipId = next.id;
    existing.duration = duration;
    return existing.id;
  }
  const tr = createTransition(fromClipId, next.id, type, duration);
  f.track.transitions.push(tr);
  return tr.id;
}

/** Copies a transition's type and duration onto every cut of its track ("Apply to all"). */
export function applyTransitionToTrack(p: Project, transitionId: Id): void {
  for (const track of p.tracks) {
    const src = track.transitions.find((t) => t.id === transitionId);
    if (!src) continue;
    for (const c of track.clips) if (adjacentNext(track, c.id)) addTransition(p, c.id, src.type, src.duration);
  }
}
