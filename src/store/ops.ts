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
import { adjacentNext, findClip, isRangeFree, isTimedClip, mainTrack, trackAccepts } from '../model/project';
import { clamp, clipContains, clipEnd, frameUs, sourceSpan } from '../model/time';
import type { Clip, ClipPatch, Id, Project, Track, TrackKind, TransitionType, Us } from '../model/types';

export interface EditCtx {
  magnet: boolean;
}

export const minClipUs = (p: Project): Us => Math.ceil(frameUs(p.settings.fps));

/** Deep copy that works on immer drafts and plain objects. */
const cloneClip = (c: Clip): Clip => structuredClone(isDraft(c) ? current(c) : c);

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
      if (isTimedClip(c)) c.inPoint = Math.max(0, Math.round(c.inPoint));
      if (c.type !== 'audio') {
        if (c.animationIn) c.animationIn.duration = clamp(Math.round(c.animationIn.duration), 0, c.duration);
        if (c.animationOut) {
          const room = c.duration - (c.animationIn?.duration ?? 0);
          c.animationOut.duration = clamp(Math.round(c.animationOut.duration), 0, room);
        }
      }
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
}

function pruneTransitions(p: Project, track: Track): void {
  const min = minClipUs(p);
  track.transitions = track.transitions.filter((tr) => {
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
  track.transitions = track.transitions.filter((tr) => (seen.has(tr.fromClipId) ? false : (seen.add(tr.fromClipId), true)));
}

/** Removes empty non-main tracks. Called by actions that can empty a track (move, delete). */
export function removeEmptyTracks(p: Project): void {
  p.tracks = p.tracks.filter((t) => t.kind === 'main' || t.clips.length > 0);
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
  } else if (opts.kind === 'overlay') {
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

/**
 * Moves a clip to `start` on `trackId` (default: same track).
 * Main track + magnet: reorders by insertion. Other tracks: if the spot is taken, a new track
 * of the same kind is created just above the target. Incompatible targets are refused.
 */
export function moveClip(p: Project, clipId: Id, to: { start: Us; trackId?: Id }, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const target = to.trackId ? p.tracks.find((t) => t.id === to.trackId) : f.track;
  if (!target || target.locked || !trackAccepts(target.kind, f.clip)) return false;
  const clip = detach(p, clipId)!;
  const start = Math.max(0, Math.round(to.start));
  if (target.kind === 'main') insertOnMain(p, clip, start + clip.duration / 2 - 1, ctx);
  else placeOnTrack(p, clip, target, start);
  removeEmptyTracks(p);
  return true;
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
  const magnetMain = f.track.kind === 'main' && ctx.magnet;
  if (prev && !magnetMain) s = Math.max(s, clipEnd(prev));
  if (isTimedClip(c)) {
    // inPoint must stay >= 0: earliest start = start - inPoint / speed
    s = Math.max(s, c.start - Math.floor(c.inPoint / c.speed));
    c.inPoint = Math.round(c.inPoint + (s - c.start) * c.speed);
  }
  c.duration = end - s;
  c.start = s;
  return true;
}

/** Drag of the RIGHT edge to timeline time `newEnd`. */
export function trimEnd(p: Project, clipId: Id, newEnd: Us, ctx: EditCtx): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip;
  let e = Math.round(newEnd);
  e = Math.max(e, c.start + minClipUs(p));
  const next = f.track.clips[f.index + 1];
  const magnetMain = f.track.kind === 'main' && ctx.magnet;
  if (next && !magnetMain) e = Math.min(e, next.start);
  if (isTimedClip(c)) {
    const asset = p.assets[c.assetId];
    if (asset) e = Math.min(e, c.start + Math.floor((asset.duration - c.inPoint) / c.speed));
  }
  c.duration = Math.max(minClipUs(p), e - c.start);
  return true;
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
  a.duration = t - a.start;
  if (isTimedClip(b) && isTimedClip(a)) b.inPoint = Math.round(a.inPoint + a.duration * a.speed);
  if (a.type !== 'audio' && b.type !== 'audio') {
    a.animationOut = null;
    b.animationIn = null;
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
    track.clips = track.clips.filter((c) => !set.has(c.id));
    n += before - track.clips.length;
    track.transitions = track.transitions.filter((t) => !set.has(t.fromClipId) && !set.has(t.toClipId));
  }
  removeEmptyTracks(p);
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

const MERGE_KEYS = ['transform', 'crop', 'adjust', 'audio'] as const;

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
    if (!(key in c)) continue; // field not on this clip type
    if ((MERGE_KEYS as readonly string[]).includes(key)) {
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
  if ((c.type === 'video' || c.type === 'audio') && patch.audio?.volumeDb !== undefined) {
    c.audio.volumeDb = clamp(c.audio.volumeDb, LIMITS.volumeDbMin, LIMITS.volumeDbMax);
  }
  return true;
}

/** Changes speed; the source span stays the same, the timeline duration changes. */
export function setSpeed(p: Project, clipId: Id, speed: number): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked || !isTimedClip(f.clip)) return false;
  const c = f.clip;
  const span = sourceSpan(c);
  const s = clamp(speed, LIMITS.speedMin, LIMITS.speedMax);
  c.speed = s;
  c.duration = Math.max(minClipUs(p), Math.round(span / s));
  return true;
}

/** Sets the timeline duration. Timed clips back-compute speed; image/text just change length. */
export function setDuration(p: Project, clipId: Id, duration: Us): boolean {
  const f = findClip(p, clipId);
  if (!f || f.track.locked) return false;
  const c = f.clip;
  const d = Math.max(minClipUs(p), Math.round(duration));
  if (isTimedClip(c)) return setSpeed(p, clipId, sourceSpan(c) / d);
  c.duration = d;
  return true;
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
