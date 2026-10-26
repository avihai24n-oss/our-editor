/**
 * Motion keyframes (VisualFields.motionKeys): position, scale, rotation and opacity keys on
 * video, image, text and compound clips. Pure helpers shared by the preview + export frame state
 * (src/engine/frameState.ts → motionTransformAt), the inspector, the player handles and the
 * timeline diamonds.
 *
 * Each property has its own key list (CapCut: every row has its own ◇), sorted by `src`.
 *
 * WHERE A KEY SITS — on the content, like volume keys (src/model/volumeKeys.ts) and CapCut:
 *  - video:    `src` = source position (inPoint + ∫speed), so trims, splits and speed changes keep
 *              each key on its frame of footage;
 *  - compound: `src` = sequence time (inPoint + local);
 *  - image / text (no source time): `src` = time from the clip's left edge. trimStart and splitClip
 *              shift these keys (shiftLocalMotionKeys) so they stay where they were on screen.
 * Reverse is ignored, like for volume keys.
 *
 * INTERPOLATION — between two keys the value goes from a to b along a's `ease` (the curve leaving
 * that key); before the first / after the last key it holds. Default = linear (CapCut's default
 * keyframe curve). Ease in / out / in-out are the CSS cubic-béziers. Position interpolates x and y
 * together on a straight line, rotation numerically (0 → 360 is one full turn, no wrap jump).
 */
import { LIMITS } from './catalog';
import type { SpeedCurve } from './speedCurve';
import { localTimeForSourceOffset, sourceOffsetAt } from './time';
import type { ClipPatch, KeyEase, MotionKey, MotionKeys, MotionProp, Transform, Us } from './types';

export const MOTION_PROPS: readonly MotionProp[] = ['position', 'scale', 'rotation', 'opacity'];
/** The Transform section's properties (section ◇, ⌥K). */
export const TRANSFORM_PROPS: readonly MotionProp[] = ['position', 'scale', 'rotation'];

export const KEY_EASES: { id: KeyEase; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'ease-in', label: 'Ease in' },
  { id: 'ease-out', label: 'Ease out' },
  { id: 'ease-in-out', label: 'Ease in-out' },
];
export const DEFAULT_EASE: KeyEase = 'linear';

/** What the helpers need of a clip (any visual clip fits). */
export interface MotionClip {
  type: string;
  start: Us;
  duration: Us;
  transform: Transform;
  motionKeys?: MotionKeys;
  inPoint?: Us;
  speed?: number;
  speedCurve?: SpeedCurve | null;
}

// ---------------------------------------------------------------- content time

const hasSpeed = (c: MotionClip): c is MotionClip & { speed: number } => c.type === 'video' && typeof c.speed === 'number';

/** Content position (µs, fractional) shown at timeline time t (clamped to the clip). */
export function contentAt(c: MotionClip, t: number): number {
  const local = Math.min(c.duration, Math.max(0, t - c.start));
  if (hasSpeed(c)) return (c.inPoint ?? 0) + sourceOffsetAt({ duration: c.duration, speed: c.speed, speedCurve: c.speedCurve ?? null }, local);
  return (c.inPoint ?? 0) + local;
}

/** Timeline time (µs, fractional) of a content position. */
export function timeAtContent(c: MotionClip, src: number): number {
  if (hasSpeed(c)) return c.start + localTimeForSourceOffset({ duration: c.duration, speed: c.speed, speedCurve: c.speedCurve ?? null }, src - (c.inPoint ?? 0));
  return c.start + src - (c.inPoint ?? 0);
}

// ---------------------------------------------------------------- easing

/** CSS cubic-bézier(x1, y1, x2, y2) evaluated at progress x (0..1). */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (u: number) => ((ax * u + bx) * u + cx) * u;
  // bisection: X is monotonic on [0, 1] for these curves
  let lo = 0;
  let hi = 1;
  let u = x;
  for (let i = 0; i < 40; i++) {
    u = (lo + hi) / 2;
    if (X(u) < x) lo = u;
    else hi = u;
  }
  return ((ay * u + by) * u + cy) * u;
}

/** Eased progress 0..1. */
export function easeValue(ease: KeyEase | undefined, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (ease) {
    case 'ease-in':
      return bezier(0.42, 0, 1, 1, x);
    case 'ease-out':
      return bezier(0, 0, 0.58, 1, x);
    case 'ease-in-out':
      return bezier(0.42, 0, 0.58, 1, x);
    default:
      return x;
  }
}

// ---------------------------------------------------------------- values

/** A property's value vector: position [x, y], scale [scale, scaleX, scaleY], rotation [deg], opacity [0..1]. */
export function propValue(tf: Transform, prop: MotionProp): number[] {
  switch (prop) {
    case 'position':
      return [tf.x, tf.y];
    case 'scale':
      return [tf.scale, tf.scaleX ?? tf.scale, tf.scaleY ?? tf.scale];
    case 'rotation':
      return [tf.rotation];
    case 'opacity':
      return [tf.opacity];
  }
}

/** The transform fields of a value vector. */
export function propPatch(prop: MotionProp, v: readonly number[]): Partial<Transform> {
  switch (prop) {
    case 'position':
      return { x: v[0]!, y: v[1]! };
    case 'scale':
      return { scale: v[0]!, scaleX: v[1]!, scaleY: v[2]! };
    case 'rotation':
      return { rotation: v[0]! };
    case 'opacity':
      return { opacity: v[0]! };
  }
}

const FIELDS: Record<MotionProp, (keyof Transform)[]> = {
  position: ['x', 'y'],
  scale: ['scale', 'scaleX', 'scaleY'],
  rotation: ['rotation'],
  opacity: ['opacity'],
};

const clampScale = (s: number) => Math.min(LIMITS.scaleMax, Math.max(LIMITS.scaleMin, s));
function sanitize(prop: MotionProp, v: readonly number[]): number[] {
  if (prop === 'scale') return v.map(clampScale);
  if (prop === 'opacity') return [Math.min(1, Math.max(0, v[0]!))];
  return [...v];
}

/** Interpolated value of a key list at content position src. */
export function keysValueAt(keys: readonly MotionKey[], src: number): number[] {
  const first = keys[0]!;
  if (src <= first.src) return [...first.v];
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (src <= b.src) {
      const a = keys[i - 1]!;
      if (b.src === a.src) return [...b.v];
      const e = easeValue(a.ease, (src - a.src) / (b.src - a.src));
      return a.v.map((av, j) => av + ((b.v[j] ?? av) - av) * e);
    }
  }
  return [...keys[keys.length - 1]!.v];
}

export const propKeys = (c: Pick<MotionClip, 'motionKeys'>, prop: MotionProp): MotionKey[] => c.motionKeys?.[prop] ?? [];
export const hasPropKeys = (c: Pick<MotionClip, 'motionKeys'>, prop: MotionProp): boolean => propKeys(c, prop).length > 0;
export const hasMotionKeys = (c: Pick<MotionClip, 'motionKeys'>): boolean => MOTION_PROPS.some((p) => hasPropKeys(c, p));

/**
 * The clip's transform at timeline time t: keyed properties interpolated, the rest from
 * `transform`. Returns `clip.transform` itself when the clip has no keys.
 */
export function motionTransformAt(c: MotionClip, t: number): Transform {
  if (!c.motionKeys || !hasMotionKeys(c)) return c.transform;
  const src = contentAt(c, t);
  const out: Transform = { ...c.transform };
  for (const prop of MOTION_PROPS) {
    const keys = propKeys(c, prop);
    if (keys.length) Object.assign(out, propPatch(prop, keysValueAt(keys, src)));
  }
  return out;
}

// ---------------------------------------------------------------- key positions

export interface VisibleKey {
  prop: MotionProp;
  key: MotionKey;
  index: number;
  /** Timeline time, µs (fractional). */
  t: number;
}

/** Keys inside the clip's span (all properties, or one), with their timeline times. */
export function visibleMotionKeys(c: MotionClip, prop?: MotionProp): VisibleKey[] {
  const out: VisibleKey[] = [];
  for (const p of prop ? [prop] : MOTION_PROPS) {
    propKeys(c, p).forEach((key, index) => {
      const t = timeAtContent(c, key.src);
      if (t >= c.start - 0.5 && t <= c.start + c.duration + 0.5) out.push({ prop: p, key, index, t });
    });
  }
  return out;
}

/** Sorted timeline times of the visible keys (several properties at one time count once). */
export function motionKeyTimes(c: MotionClip, props?: readonly MotionProp[]): number[] {
  const ts = visibleMotionKeys(c)
    .filter((k) => !props || props.includes(k.prop))
    .map((k) => k.t)
    .sort((a, b) => a - b);
  return ts.filter((t, i) => i === 0 || t - ts[i - 1]! > 1);
}

/** Index of the prop's key within tolUs of timeline time t, or -1. */
export function motionKeyIndexAt(c: MotionClip, prop: MotionProp, t: number, tolUs: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const k of visibleMotionKeys(c, prop)) {
    const d = Math.abs(k.t - t);
    if (d <= tolUs && d < bestD) {
      best = k.index;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- edits (pure; each returns new data)

const cloneKeys = (mk: MotionKeys | undefined): MotionKeys => {
  const out: MotionKeys = {};
  for (const p of MOTION_PROPS) if (mk?.[p]?.length) out[p] = mk[p]!.map((k) => ({ ...k, v: [...k.v] }));
  return out;
};
/** null = no keys left (the patch value that clears the field). */
const orNull = (mk: MotionKeys): MotionKeys | null => (MOTION_PROPS.some((p) => mk[p]?.length) ? mk : null);
const sortKeys = (keys: MotionKey[]) => keys.sort((a, b) => a.src - b.src);

/** The prop's keys with one set to `v` at timeline time t (replacing a key within tolUs). */
export function withMotionKeyAt(c: MotionClip, prop: MotionProp, t: number, v: readonly number[], tolUs: number): MotionKeys {
  const mk = cloneKeys(c.motionKeys);
  const keys = mk[prop] ?? [];
  const i = motionKeyIndexAt(c, prop, t, tolUs);
  if (i >= 0) keys[i] = { ...keys[i]!, v: sanitize(prop, v) };
  else keys.push({ src: Math.round(contentAt(c, t)), v: sanitize(prop, v) });
  mk[prop] = sortKeys(keys);
  return mk;
}

/**
 * Patch that removes the prop's key at t. When it was the prop's last key, the clip keeps the
 * value it had there (written to `transform`), like the volume keys.
 */
export function withoutMotionKeyPatch(c: MotionClip, props: readonly MotionProp[], t: number, tolUs: number): ClipPatch {
  const mk = cloneKeys(c.motionKeys);
  const at = motionTransformAt(c, t);
  const tf: Partial<Transform> = {};
  for (const prop of props) {
    const i = motionKeyIndexAt(c, prop, t, tolUs);
    if (i < 0) continue;
    const rest = (mk[prop] ?? []).filter((_, j) => j !== i);
    if (rest.length) mk[prop] = rest;
    else {
      delete mk[prop];
      Object.assign(tf, propPatch(prop, propValue(at, prop)));
    }
  }
  return { motionKeys: orNull(mk), ...(Object.keys(tf).length ? { transform: tf } : {}) };
}

/** Every key of the prop moved by the same delta vector. */
function shiftPropKeys(keys: readonly MotionKey[], prop: MotionProp, delta: readonly number[]): MotionKey[] {
  return keys.map((k) => ({ ...k, v: sanitize(prop, k.v.map((x, j) => x + (delta[j] ?? 0))) }));
}

/** The props a transform patch touches. */
export function propsOfPatch(patch: Partial<Transform>): MotionProp[] {
  return MOTION_PROPS.filter((p) => FIELDS[p].some((f) => patch[f] !== undefined));
}

/**
 * Routes a transform edit made at timeline time t (the playhead) through the keys — CapCut's
 * behaviour, the same as the volume keys:
 *  - a property without keys: the plain `transform` value changes;
 *  - a keyed property, playhead on the clip: the key at the playhead is set (added if none);
 *  - a keyed property, playhead off the clip: every key of it moves by the same amount.
 */
export function keyedTransformPatch(c: MotionClip, patch: Partial<Transform>, t: number, tolUs: number): ClipPatch {
  const keyed = propsOfPatch(patch).filter((p) => hasPropKeys(c, p));
  if (!keyed.length) return { transform: patch };
  const rest: Partial<Transform> = { ...patch };
  const inside = t >= c.start && t < c.start + c.duration;
  const at = Math.min(c.start + c.duration - 1, Math.max(c.start, t));
  const cur = motionTransformAt(c, at);
  let mk = cloneKeys(c.motionKeys);
  for (const prop of keyed) {
    const next = { ...cur, ...patch } as Transform;
    for (const f of FIELDS[prop]) delete rest[f];
    const v = propValue(next, prop);
    if (inside) mk = withMotionKeyAt({ ...c, motionKeys: mk }, prop, t, v, tolUs);
    else {
      const old = propValue(cur, prop);
      mk[prop] = shiftPropKeys(mk[prop]!, prop, v.map((x, j) => x - old[j]!));
    }
  }
  return { motionKeys: mk, ...(Object.keys(rest).length ? { transform: rest } : {}) };
}

/** True when any of the props has a key at t. */
export const anyKeyAt = (c: MotionClip, props: readonly MotionProp[], t: number, tolUs: number): boolean =>
  props.some((p) => motionKeyIndexAt(c, p, t, tolUs) >= 0);

/**
 * ◇ for a group of properties (a row, the Transform section, ⌥K): with a key of any of them at t
 * they are removed, otherwise each gets a key with its current value. null = t is off the clip.
 */
export function toggleKeysPatch(c: MotionClip, props: readonly MotionProp[], t: number, tolUs: number): ClipPatch | null {
  if (t < c.start || t >= c.start + c.duration) return null;
  if (anyKeyAt(c, props, t, tolUs)) return withoutMotionKeyPatch(c, props, t, tolUs);
  const cur = motionTransformAt(c, t);
  let mk = cloneKeys(c.motionKeys);
  for (const prop of props) mk = withMotionKeyAt({ ...c, motionKeys: mk }, prop, t, propValue(cur, prop), tolUs);
  return { motionKeys: mk };
}

/** The ease of the keys at t (the first found), or null when no key is there. */
export function easeAt(c: MotionClip, t: number, tolUs: number): KeyEase | null {
  for (const p of MOTION_PROPS) {
    const i = motionKeyIndexAt(c, p, t, tolUs);
    if (i >= 0) return propKeys(c, p)[i]!.ease ?? DEFAULT_EASE;
  }
  return null;
}

/** Sets the curve of every key at t (the motion from those keys to the next ones). */
export function withEaseAt(c: MotionClip, t: number, tolUs: number, ease: KeyEase): MotionKeys | null {
  const mk = cloneKeys(c.motionKeys);
  let n = 0;
  for (const p of MOTION_PROPS) {
    const i = motionKeyIndexAt(c, p, t, tolUs);
    if (i < 0) continue;
    const k = mk[p]![i]!;
    if (ease === DEFAULT_EASE) delete k.ease;
    else k.ease = ease;
    n++;
  }
  return n ? mk : null;
}

/**
 * Keys at timeline time `from` (all props, or the given ones) moved to timeline time `to`
 * (clamped to the clip). A key already at `to` is replaced.
 */
export function withKeysMoved(c: MotionClip, from: number, to: number, tolUs: number, props: readonly MotionProp[] = MOTION_PROPS): MotionKeys {
  const mk = cloneKeys(c.motionKeys);
  const dest = Math.round(contentAt(c, Math.min(c.start + c.duration, Math.max(c.start, to))));
  for (const p of props) {
    const i = motionKeyIndexAt(c, p, from, tolUs);
    if (i < 0) continue;
    const keys = mk[p]!;
    const moved = { ...keys[i]!, src: dest };
    const others = keys.filter((k, j) => j !== i && Math.abs(timeAtContent(c, k.src) - timeAtContent(c, dest)) > tolUs);
    mk[p] = sortKeys([...others, moved]);
  }
  return mk;
}

/** Patch removing every key of the props (section reset). */
export function clearKeysPatch(c: Pick<MotionClip, 'motionKeys'>, props: readonly MotionProp[]): ClipPatch {
  if (!c.motionKeys) return {};
  const mk = cloneKeys(c.motionKeys);
  for (const p of props) delete mk[p];
  return { motionKeys: orNull(mk) };
}

/** Image / text keys (`src` = time from the left edge) after the left edge moved right by `shift` µs. */
export function shiftLocalMotionKeys(mk: MotionKeys | undefined, shift: number): MotionKeys | undefined {
  if (!mk || !shift) return mk;
  const out = cloneKeys(mk);
  for (const p of MOTION_PROPS) if (out[p]) out[p] = out[p]!.map((k) => ({ ...k, src: k.src - shift }));
  return out;
}

/** True for clips whose motion keys count from the clip's left edge (no source time). */
export const usesLocalKeyTime = (c: { type: string }): boolean => c.type === 'image' || c.type === 'text';

/** Every rotation key turned by `deg` (Edit › Rotate on a keyed clip). */
export function rotatedKeys(mk: MotionKeys, deg: number): MotionKeys {
  const out = cloneKeys(mk);
  if (out.rotation) out.rotation = out.rotation.map((k) => ({ ...k, v: [k.v[0]! + deg] }));
  return out;
}

// ---------------------------------------------------------------- Ken Burns

export type KenBurnsDir = 'in' | 'out';

/**
 * One-click Ken Burns: a scale key at the clip's first frame and one at its last frame (zoom in:
 * 100 % → 115 % of the current scale; zoom out: the reverse), with a small drift of the position,
 * both linear (a constant slow move). Replaces existing position / scale keys.
 */
export function kenBurnsKeys(c: MotionClip, dir: KenBurnsDir, frameUs: number, opts: { zoom?: number; pan?: { x: number; y: number } } = {}): MotionKeys {
  const zoom = opts.zoom ?? 1.15;
  const pan = opts.pan ?? { x: 0, y: 0 };
  const tf = c.transform;
  const s0 = propValue(tf, 'scale');
  const s1 = s0.map((s) => s * zoom);
  const [a, b] = dir === 'in' ? [s0, s1] : [s1, s0];
  const p0 = [tf.x, tf.y];
  const p1 = [tf.x + pan.x, tf.y + pan.y];
  const srcA = Math.round(contentAt(c, c.start));
  const srcB = Math.round(contentAt(c, c.start + Math.max(0, c.duration - frameUs)));
  const mk = cloneKeys(c.motionKeys);
  mk.scale = [
    { src: srcA, v: sanitize('scale', a) },
    { src: srcB, v: sanitize('scale', b) },
  ];
  mk.position = [
    { src: srcA, v: p0 },
    { src: srcB, v: p1 },
  ];
  return mk;
}
