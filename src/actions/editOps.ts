/**
 * Edit › operations (clip right-click "Edit" submenu). Each function MUTATES a Project draft and
 * runs inside the store's `editProject` (one undo step, normalize() after). No DOM, no React:
 * the async parts (frame capture for Freeze, the file picker for Replace) live in ./editMenu.ts.
 */
import { current, isDraft } from 'immer';
import { createClipFromAsset, newId } from '../model/defaults';
import { findClip } from '../model/project';
import { clamp, clipContains, clipEnd, frameUs, mirrorInPoint, sourceSpan } from '../model/time';
import type { Clip, Crop, Id, ImageClip, Project, Us, VideoClip } from '../model/types';
import { splitClip } from '../store/ops';

/** CapCut's freeze frame: a 3 s still. */
export const FREEZE_DURATION: Us = 3_000_000;

const editable = (p: Project, id: Id) => {
  const f = findClip(p, id);
  return f && !f.track.locked ? f : undefined;
};

/** Mirror: toggles the horizontal flip of every visual clip. Returns how many changed. */
export function toggleMirror(p: Project, ids: readonly Id[]): number {
  let n = 0;
  for (const id of ids) {
    const f = editable(p, id);
    if (!f || f.clip.type === 'audio') continue;
    f.clip.transform.flipH = !f.clip.transform.flipH;
    n++;
  }
  return n;
}

/** Rotate: +90° (clockwise) in the inspector's −180..180 range. */
export function rotate90(p: Project, ids: readonly Id[], deg = 90): number {
  let n = 0;
  for (const id of ids) {
    const f = editable(p, id);
    if (!f || f.clip.type === 'audio') continue;
    let r = (f.clip.transform.rotation + deg) % 360;
    if (r > 180) r -= 360;
    if (r <= -180) r += 360;
    f.clip.transform.rotation = r;
    n++;
  }
  return n;
}

/** A crop that leaves at least 2 % of the picture on each axis, every side in 0..1. */
export function sanitizeCrop(c: Crop): Crop {
  const MIN = 0.02;
  let left = clamp(c.left, 0, 1);
  let top = clamp(c.top, 0, 1);
  let right = clamp(c.right, 0, 1);
  let bottom = clamp(c.bottom, 0, 1);
  if (left + right > 1 - MIN) right = Math.max(0, 1 - MIN - left);
  if (left + right > 1 - MIN) left = 1 - MIN;
  if (top + bottom > 1 - MIN) bottom = Math.max(0, 1 - MIN - top);
  if (top + bottom > 1 - MIN) top = 1 - MIN;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { left: r(left), top: r(top), right: r(right), bottom: r(bottom) };
}

/** Crop: sets the crop rectangle (fractions of the source) of visual media clips. */
export function setCrop(p: Project, ids: readonly Id[], crop: Crop): number {
  const c = sanitizeCrop(crop);
  let n = 0;
  for (const id of ids) {
    const f = editable(p, id);
    if (!f || (f.clip.type !== 'video' && f.clip.type !== 'image')) continue;
    f.clip.crop = { ...c };
    n++;
  }
  return n;
}

/**
 * Reverse: toggles `reversed` on video / audio clips, mirroring the inPoint so the clip keeps
 * the same source span (model/types TimedMediaFields). Audio extracted from a reversed video
 * (same audioLink, same start and length) is reversed with it, so picture and sound stay in sync.
 */
export function toggleReverse(p: Project, ids: readonly Id[]): number {
  const targets = new Set<Id>();
  for (const id of ids) {
    const f = editable(p, id);
    if (!f || (f.clip.type !== 'video' && f.clip.type !== 'audio')) continue;
    targets.add(id);
    const link = f.clip.audioLink;
    if (link) {
      for (const t of p.tracks) for (const c of t.clips) {
        if (t.locked || (c.type !== 'video' && c.type !== 'audio') || c.audioLink !== link) continue;
        if (c.start === f.clip.start && c.duration === f.clip.duration) targets.add(c.id);
      }
    }
  }
  let n = 0;
  for (const id of targets) {
    const c = findClip(p, id)?.clip;
    if (!c || (c.type !== 'video' && c.type !== 'audio')) continue;
    const asset = p.assets[c.assetId];
    if (!asset || asset.duration <= 0) continue;
    c.inPoint = mirrorInPoint(asset.duration, c.inPoint, sourceSpan(c));
    c.reversed = !c.reversed;
    n++;
  }
  return n;
}

/** Visual fields a freeze / replace carries over from the original clip. */
function copyVisual(from: VideoClip | ImageClip, to: VideoClip | ImageClip): void {
  to.transform = plain(from.transform);
  to.crop = plain(from.crop);
  to.blend = from.blend;
  to.blendEnabled = from.blendEnabled;
  to.filter = from.filter ? plain(from.filter) : null;
  to.adjust = plain(from.adjust);
  to.adjustEnabled = from.adjustEnabled;
  to.grade = plain(from.grade);
  to.mask = plain(from.mask);
  to.chroma = plain(from.chroma);
  to.canvas = plain(from.canvas);
}

/** Deep copy of a (possibly immer-draft) value. */
const plain = <T,>(x: T): T => structuredClone(isDraft(x) ? current(x) : x);

/**
 * Freeze: splits the video clip at `t` and inserts a still (`imageAssetId`, the frame shown at
 * t) of `duration` between the two parts; the clips after it on the same track move right by
 * `duration`. The still keeps the clip's look (transform, crop, blend, filter, adjust, grade,
 * mask, chroma key, canvas). At the clip's first / last frame the still goes before / after the
 * clip without a split. Returns the still's clip id.
 */
export function insertFreeze(p: Project, clipId: Id, t: Us, imageAssetId: Id, duration: Us = FREEZE_DURATION): Id | null {
  const f = editable(p, clipId);
  const asset = p.assets[imageAssetId];
  if (!f || f.clip.type !== 'video' || !asset || asset.kind !== 'image') return null;
  if (!clipContains(f.clip, t)) return null;
  const min = Math.ceil(frameUs(p.settings.fps));
  const src = f.clip;
  // where the still goes: a cut inside the clip, or the clip's start / end near its edges
  let at: Us = t;
  if (t < src.start + min) at = src.start;
  else if (t > clipEnd(src) - min) at = clipEnd(src);
  else if (!splitClip(p, clipId, t)) return null;
  const track = f.track;
  for (const c of track.clips) if (c.start >= at) c.start += duration;
  const still = createClipFromAsset(asset, track.id, at) as ImageClip;
  still.id = newId('clp');
  still.duration = duration;
  still.name = `${src.name} (freeze)`;
  const left = findClip(p, clipId)!.clip as VideoClip;
  copyVisual(left, still);
  const i = track.clips.findIndex((c) => c.start > at);
  track.clips.splice(i < 0 ? track.clips.length : i, 0, still);
  return still.id;
}

export type ReplaceResult = { ok: true } | { ok: false; reason: string };

/**
 * Replace clip: the clip shows another asset, keeping its timing (start, duration, speed,
 * reverse) and its attributes (look, audio settings, animations). Video ↔ image also works (the
 * clip changes type). A video / audio replacement shorter than the clip's source span is refused,
 * like CapCut ("The media is too short"). The in-point is kept when the new media is long
 * enough there, else moved back so the span fits.
 */
export function replaceClip(p: Project, clipId: Id, assetId: Id): ReplaceResult {
  const f = editable(p, clipId);
  const asset = p.assets[assetId];
  if (!f) return { ok: false, reason: 'The clip is locked or gone.' };
  if (!asset) return { ok: false, reason: 'Unknown media.' };
  const c = f.clip;
  if (c.type === 'text') return { ok: false, reason: 'Text clips cannot be replaced with media.' };
  if (c.type === 'audio' && asset.kind !== 'audio' && !(asset.kind === 'video' && asset.hasAudio !== false)) return { ok: false, reason: 'Pick an audio file to replace an audio clip.' };
  if (c.type !== 'audio' && asset.kind === 'audio') return { ok: false, reason: 'Pick a video or an image to replace this clip.' };
  if (c.type === 'audio' || (c.type === 'video' && asset.kind === 'video')) {
    const span = sourceSpan(c);
    if (asset.duration > 0 && asset.duration + 0.5 < span) return { ok: false, reason: 'The media is too short to replace this clip.' };
    c.assetId = asset.id;
    c.name = asset.name;
    if (c.inPoint + span > asset.duration) c.inPoint = Math.max(0, Math.floor(asset.duration - span));
    return { ok: true };
  }
  // video ↔ image, image → image: rebuild the clip of the new type, keeping id, place and look
  const next = createClipFromAsset(asset, f.track.id, c.start) as VideoClip | ImageClip;
  next.id = c.id;
  next.duration = c.duration;
  next.disabled = c.disabled;
  copyVisual(c, next);
  next.animationIn = c.animationIn && plain(c.animationIn);
  next.animationOut = c.animationOut && plain(c.animationOut);
  next.animationCombo = c.animationCombo && plain(c.animationCombo);
  next.animationLoop = c.animationLoop && plain(c.animationLoop);
  if (next.type === 'video') {
    if (asset.duration > 0 && asset.duration + 0.5 < next.duration) return { ok: false, reason: 'The media is too short to replace this clip.' };
    if (c.type === 'video') next.audio = plain(c.audio);
  }
  f.track.clips[f.index] = next as Clip;
  return { ok: true };
}
