/**
 * Pure read-only helpers over a Project (no React, no DOM). Safe to call from anywhere.
 */
import { migrateColorPage } from './colorPage';
import { allClipsDeep, rootProject } from './compound';
import { defaultAdjust, defaultCanvasBackground, defaultChroma, defaultGrade, defaultMask } from './defaults';
import type { SpeedCurve } from './speedCurve';
import { clipEnd } from './time';
import type {
  Adjust,
  AudioClip,
  ColorGrade,
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
      return clip.type === 'video' || clip.type === 'image' || clip.type === 'compound';
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
  for (const c of allClipsDeep(p)) if (c.type !== 'text' && c.type !== 'compound') s.add(c.assetId);
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
 * documents keep working. Every feature that added clip fields registers one step in
 * CLIP_MIGRATIONS; migrateProject runs all of them on every clip, in order. Each step returns the
 * SAME object when it has nothing to do, so an up-to-date project comes back unchanged (===).
 */
export function migrateProject(p0: Project): Project {
  // a document saved with a compound clip open for editing loads on the main timeline
  const p = rootProject(p0);
  let out = p;
  const tracks = migrateTracks(p.tracks);
  if (tracks !== p.tracks) out = { ...out, tracks };
  // compound clips (⌥G): the clips of every nested sequence and of the focus stack get the same steps
  if (p.sequences) {
    let sChanged = false;
    const sequences: NonNullable<Project['sequences']> = {};
    for (const [id, sq] of Object.entries(p.sequences)) {
      const t = migrateTracks(sq.tracks);
      sequences[id] = t === sq.tracks ? sq : { ...sq, tracks: t };
      if (t !== sq.tracks) sChanged = true;
    }
    if (sChanged) out = { ...out, sequences };
  }
  if (p.focus && p.focus.length) {
    let fChanged = false;
    const focus = p.focus.map((f) => {
      const t = migrateTracks(f.parentTracks);
      if (t === f.parentTracks) return f;
      fChanged = true;
      return { ...f, parentTracks: t };
    });
    if (fChanged) out = { ...out, focus };
  }
  return out;
}

/** Runs the clip migrations over a track list; the same array when nothing changed. */
function migrateTracks(list: Track[]): Track[] {
  let changed = false;
  const tracks = list.map((t) => {
    let tChanged = false;
    const clips = t.clips.map((c) => {
      const out = migrateClip(c);
      if (out !== c) tChanged = true;
      return out;
    });
    if (!tChanged) return t;
    changed = true;
    return { ...t, clips };
  });
  return changed ? tracks : list;
}

/** Runs every clip migration in order. */
export function migrateClip(c: Clip): Clip {
  let out = c;
  for (const step of CLIP_MIGRATIONS) out = step(out);
  return out;
}

/** v1 additions: blend / adjust on-off checkboxes. */
function migrateEnabledFlags(c: Clip): Clip {
  if (c.type === 'audio') return c;
  const v = c as VisualClip & Partial<Pick<VisualClip, 'blendEnabled' | 'adjustEnabled'>>;
  if (typeof v.blendEnabled === 'boolean' && typeof v.adjustEnabled === 'boolean') return c;
  return { ...c, blendEnabled: v.blendEnabled ?? true, adjustEnabled: v.adjustEnabled ?? true } as Clip;
}

/** tab-speed: Speed › Curve — missing or malformed → Standard speed. */
function migrateSpeed(c: Clip): Clip {
  if (c.type !== 'video' && c.type !== 'audio') return c;
  let out: Clip = c;
  const tc = c as TimedClip & { speedCurve?: unknown };
  const curve = tc.speedCurve as SpeedCurve | null | undefined;
  const valid =
    curve === null ||
    (!!curve &&
      Array.isArray(curve.points) &&
      curve.points.length >= 2 &&
      curve.points.every((q) => Number.isFinite(q?.x) && Number.isFinite(q?.v) && q.v > 0));
  if (curve === undefined || !valid) out = { ...out, speedCurve: null } as Clip;
  else if (curve && tc.speed !== 1) out = { ...out, speed: 1 } as Clip;
  if (typeof tc.speed !== 'number' || !(tc.speed > 0)) out = { ...out, speed: 1 } as Clip;
  return out;
}

/** tab-audio: normalize, reduce noise, fill channel, voice filter. */
function migrateAudio(c: Clip): Clip {
  if (c.type !== 'video' && c.type !== 'audio') return c;
  const audio = migrateAudioProps(c.audio);
  return audio === c.audio ? c : ({ ...c, audio } as Clip);
}

/** tab-animation: Combo / text Loop slots. */
function migrateAnimationSlots(c: Clip): Clip {
  if (c.type === 'audio') return c;
  const v = c as VisualClip & Partial<Pick<VisualClip, 'animationCombo' | 'animationLoop'>>;
  if (v.animationCombo !== undefined && v.animationLoop !== undefined) return c;
  return { ...c, animationCombo: v.animationCombo ?? null, animationLoop: v.animationLoop ?? null } as Clip;
}

/** tab-adjust: new Adjust sliders and the colour grade (see migrateVisualClip). */
const migrateGrade = (c: Clip): Clip => (c.type === 'audio' ? c : migrateVisualClip(c));

/**
 * Every clip migration, in the order the features were added: v1 checkboxes, tab-speed,
 * tab-audio, tab-video (migrateVideoTabFields), tab-adjust (migrateGrade), tab-animation, ctx-edit (reverse),
 * ctx-compound. (ctx-isolate's voiceIsolation is filled by migrateAudio.)
 */
const CLIP_MIGRATIONS: readonly ((c: Clip) => Clip)[] = [migrateEnabledFlags, migrateSpeed, migrateAudio, migrateVideoTabFields, migrateColorPage, migrateGrade, migrateAnimationSlots, migrateReverse, migrateCompound];

/** ctx-edit: Edit › Reverse — missing or non-boolean → false (forward). */
function migrateReverse(c: Clip): Clip {
  if (c.type !== 'video' && c.type !== 'audio') return c;
  const r = (c as TimedClip & { reversed?: unknown }).reversed;
  if (typeof r === 'boolean') return c;
  return { ...c, reversed: r === true } as Clip;
}

/** ctx-compound: a compound clip's in-point must be a non-negative integer. */
function migrateCompound(c: Clip): Clip {
  if (c.type !== 'compound') return c;
  const ok = Number.isInteger(c.inPoint) && c.inPoint >= 0;
  return ok ? c : { ...c, inPoint: Math.max(0, Math.round(Number(c.inPoint) || 0)) };
}

const FILL_CHANNELS: readonly string[] = ['left', 'right'];

/**
 * Audio fields added after v1 (normalize, reduceNoise, fillChannel, voiceFilter, voiceIsolation): missing or
 * malformed values get the defaults. Returns the same object when nothing changed.
 */
export function migrateAudioProps(a: AudioProps): AudioProps {
  const x = a as Partial<AudioProps>;
  const vf = x.voiceFilter;
  const voiceOk = vf === null || (typeof vf === 'object' && vf !== undefined && typeof vf.id === 'string' && typeof vf.strength === 'number');
  const fillOk = x.fillChannel === null || (typeof x.fillChannel === 'string' && FILL_CHANNELS.includes(x.fillChannel));
  const vi = x.voiceIsolation;
  const isoOk =
    vi === null ||
    (typeof vi === 'object' && vi !== undefined && (vi.mode === 'isolate' || vi.mode === 'remove') && typeof vi.strength === 'number' && Number.isFinite(vi.strength));
  if (typeof x.normalize === 'boolean' && typeof x.reduceNoise === 'boolean' && fillOk && voiceOk && isoOk) return a;
  return {
    ...a,
    normalize: typeof x.normalize === 'boolean' ? x.normalize : false,
    reduceNoise: typeof x.reduceNoise === 'boolean' ? x.reduceNoise : false,
    fillChannel: fillOk ? (x.fillChannel ?? null) : null,
    voiceFilter: voiceOk ? (vf ?? null) : null,
    voiceIsolation: isoOk ? (vi ?? null) : null,
  };
}

/**
 * Video-tab fields added on 19 Oct 2026: transform.uniformScale / scaleX / scaleY on every visual
 * clip, and mask / chroma / canvas on video and image clips. Missing fields get their defaults
 * (scaleX / scaleY start from the clip's uniform scale). Returns the same object when nothing is
 * missing.
 */
export function migrateVideoTabFields(c: Clip): Clip {
  if (c.type === 'audio') return c;
  let out: Clip = c;
  const tf = c.transform as VisualClip['transform'] & Partial<Pick<VisualClip['transform'], 'uniformScale' | 'scaleX' | 'scaleY'>>;
  if (typeof tf.uniformScale !== 'boolean' || typeof tf.scaleX !== 'number' || typeof tf.scaleY !== 'number') {
    out = {
      ...out,
      transform: { ...tf, uniformScale: tf.uniformScale ?? true, scaleX: tf.scaleX ?? tf.scale, scaleY: tf.scaleY ?? tf.scale },
    } as Clip;
  }
  if (c.type === 'video' || c.type === 'image') {
    const m = c as Partial<Pick<VideoClip, 'mask' | 'chroma' | 'canvas'>>;
    if (!m.mask || !m.chroma || !m.canvas) {
      out = {
        ...out,
        mask: m.mask ? { ...defaultMask(), ...m.mask } : defaultMask(),
        chroma: m.chroma ? { ...defaultChroma(), ...m.chroma } : defaultChroma(),
        canvas: m.canvas ? { ...defaultCanvasBackground(), ...m.canvas } : defaultCanvasBackground(),
      } as Clip;
    }
  }
  return out;
}

const ADJUST_KEYS = Object.keys(defaultAdjust()) as (keyof Adjust)[];
const GRADE_KEYS = Object.keys(defaultGrade()) as (keyof ColorGrade)[];

/** Fills missing visual-clip fields (blend/adjust checkboxes, new Adjust sliders, the colour grade). */
export function migrateVisualClip(c: VisualClip): VisualClip {
  const v = c as VisualClip & Partial<Pick<VisualClip, 'blendEnabled' | 'adjustEnabled' | 'grade'>>;
  const adjustOk = !!v.adjust && ADJUST_KEYS.every((k) => typeof v.adjust[k] === 'number');
  const gradeOk = !!v.grade && GRADE_KEYS.every((k) => v.grade![k] && typeof v.grade![k] === 'object') && !!v.grade.hsl.bands;
  if (typeof v.blendEnabled === 'boolean' && typeof v.adjustEnabled === 'boolean' && adjustOk && gradeOk) return c;
  const grade = defaultGrade();
  if (v.grade) {
    for (const k of GRADE_KEYS) if (v.grade[k] && typeof v.grade[k] === 'object') Object.assign(grade[k], v.grade[k]);
    grade.hsl.bands = { ...defaultGrade().hsl.bands, ...(v.grade.hsl?.bands ?? {}) };
  }
  return {
    ...c,
    blendEnabled: v.blendEnabled ?? true,
    adjustEnabled: v.adjustEnabled ?? true,
    adjust: { ...defaultAdjust(), ...(v.adjust ?? {}) },
    grade,
  } as VisualClip;
}
