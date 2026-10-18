/**
 * Pure read-only helpers over a Project (no React, no DOM). Safe to call from anywhere.
 */
import { clipEnd } from './time';
import type {
  AudioClip,
  AudioProps,
  Clip,
  Id,
  Project,
  TimedClip,
  Track,
  TrackKind,
  Us,
  VideoClip,
  VisualClip,
} from './types';

export const isVisualClip = (c: Clip): c is VisualClip => c.type !== 'audio';
export const isTimedClip = (c: Clip): c is TimedClip => c.type === 'video' || c.type === 'audio';
export const hasAudioProps = (c: Clip): c is VideoClip | AudioClip => c.type === 'video' || c.type === 'audio';
export const isVisualTrack = (t: Track): boolean => t.kind !== 'audio';

export const mainTrack = (p: Project): Track => {
  const t = p.tracks.find((x) => x.kind === 'main');
  if (!t) throw new Error('Project has no main track');
  return t;
};

export const findTrack = (p: Project, trackId: Id): Track | undefined => p.tracks.find((t) => t.id === trackId);

export function findClip(p: Project, clipId: Id): { clip: Clip; track: Track; index: number } | undefined {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { clip: track.clips[index]!, track, index };
  }
  return undefined;
}

export function findTransition(p: Project, transitionId: Id) {
  for (const track of p.tracks) {
    const transition = track.transitions.find((t) => t.id === transitionId);
    if (transition) return { transition, track };
  }
  return undefined;
}

export const allClips = (p: Project): Clip[] => p.tracks.flatMap((t) => t.clips);

/** Which clip kinds a track kind accepts. */
export function trackAccepts(kind: TrackKind, clip: Pick<Clip, 'type'>): boolean {
  switch (kind) {
    case 'main':
    case 'overlay':
      return clip.type === 'video' || clip.type === 'image';
    case 'audio':
      return clip.type === 'audio';
    case 'text':
      return clip.type === 'text';
  }
}

/**
 * Timeline display order, top to bottom: visual tracks from the highest layer down to the main
 * track, then audio tracks (in array order).
 */
export function timelineRows(p: Project): Track[] {
  const visual = p.tracks.filter(isVisualTrack).reverse();
  const audio = p.tracks.filter((t) => !isVisualTrack(t));
  return [...visual, ...audio];
}

/** Asset ids used by at least one clip ("Added" badge in the media bin). */
export function usedAssetIds(p: Project): Set<Id> {
  const s = new Set<Id>();
  for (const c of allClips(p)) if (c.type !== 'text') s.add(c.assetId);
  return s;
}

/** True when [start, end) is free on the track (ignoring `ignoreClipId`). */
export function isRangeFree(track: Track, start: Us, end: Us, ignoreClipId?: Id): boolean {
  return track.clips.every((c) => c.id === ignoreClipId || clipEnd(c) <= start || c.start >= end);
}

/** The clip that directly follows `clipId` on its track with no gap (for transitions). */
export function adjacentNext(track: Track, clipId: Id): Clip | undefined {
  const i = track.clips.findIndex((c) => c.id === clipId);
  const a = track.clips[i];
  const b = track.clips[i + 1];
  return a && b && clipEnd(a) === b.start ? b : undefined;
}

/** Every clip (video and audio) carrying the extract-audio link id. */
export function audioLinked(p: Project, link: Id): (VideoClip | AudioClip)[] {
  return allClips(p).filter((c): c is VideoClip | AudioClip => (c.type === 'video' || c.type === 'audio') && c.audioLink === link);
}

// ---------------------------------------------------------------- audio math

export const VOLUME_FLOOR_DB = -60;

/** dB → linear gain; -60 dB or lower = silence. */
export const dbToGain = (db: number): number => (db <= VOLUME_FLOOR_DB ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number): number => (g <= 0 ? VOLUME_FLOOR_DB : Math.max(VOLUME_FLOOR_DB, 20 * Math.log10(g)));

/** Linear fade envelope 0..1 at timeline time t (fades are in timeline time). */
export function fadeEnvelope(clip: Pick<Clip, 'start' | 'duration'> & { audio: Pick<AudioProps, 'fadeIn' | 'fadeOut'> }, t: Us): number {
  const local = t - clip.start;
  if (local < 0 || local >= clip.duration) return 0;
  let g = 1;
  if (clip.audio.fadeIn > 0 && local < clip.audio.fadeIn) g = Math.min(g, local / clip.audio.fadeIn);
  const remaining = clip.duration - local;
  if (clip.audio.fadeOut > 0 && remaining < clip.audio.fadeOut) g = Math.min(g, remaining / clip.audio.fadeOut);
  return Math.max(0, Math.min(1, g));
}

// ---------------------------------------------------------------- load-time migration

/**
 * Fills fields added after a project was saved (same SCHEMA_VERSION, additive only) so old
 * documents keep working. Returns a new object only when something changed.
 */
export function migrateProject(p: Project): Project {
  let changed = false;
  const tracks = p.tracks.map((t) => {
    let tChanged = false;
    const clips = t.clips.map((c) => {
      if (c.type === 'audio') return c;
      const v = c as VisualClip & Partial<Pick<VisualClip, 'blendEnabled' | 'adjustEnabled'>>;
      if (typeof v.blendEnabled === 'boolean' && typeof v.adjustEnabled === 'boolean') return c;
      tChanged = true;
      return { ...c, blendEnabled: v.blendEnabled ?? true, adjustEnabled: v.adjustEnabled ?? true } as Clip;
    });
    if (!tChanged) return t;
    changed = true;
    return { ...t, clips };
  });
  return changed ? { ...p, tracks } : p;
}
