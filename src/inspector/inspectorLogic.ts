/**
 * Pure inspector helpers: which tabs a selection gets, slider mappings (log speed, dB),
 * align-button maths, duration limits. No React — unit-tested in inspectorLogic.test.ts.
 */
import { LIMITS } from '../model/catalog';
import { findClip, findTransition } from '../model/project';
import { clamp } from '../model/time';
import type { Clip, ClipMask, Crop, Id, MaskShape, MediaAsset, Project, Transform, Us } from '../model/types';

// ---------------------------------------------------------------- tabs

export type InspectorTab = 'video' | 'audio' | 'speed' | 'animation' | 'adjust' | 'text';

export const TAB_LABELS: Record<InspectorTab, string> = {
  video: 'Video',
  audio: 'Audio',
  speed: 'Speed',
  animation: 'Animation',
  adjust: 'Adjust',
  text: 'Text',
};

/** CapCut tab row per clip type (SPEC §1 Inspector table). */
export function clipTabs(clip: Pick<Clip, 'type'>, asset?: Pick<MediaAsset, 'hasAudio'>): InspectorTab[] {
  switch (clip.type) {
    case 'video':
      return asset?.hasAudio === false ? ['video', 'speed', 'animation', 'adjust'] : ['video', 'audio', 'speed', 'animation', 'adjust'];
    case 'image':
      return ['video', 'animation', 'adjust'];
    case 'audio':
      return ['audio', 'speed'];
    case 'text':
      return ['text', 'animation', 'adjust'];
    case 'compound':
      // compound clip (⌥G): its transform / blend, animations and colour wrap the nested picture
      return ['video', 'animation', 'adjust'];
  }
}

/** Keeps the user's tab when the new selection has it, else the first tab. */
export const pickTab = (tabs: readonly InspectorTab[], wanted: InspectorTab | null): InspectorTab =>
  wanted && tabs.includes(wanted) ? wanted : tabs[0]!;

// ---------------------------------------------------------------- speed (log slider)

/**
 * CapCut's speed slider: six evenly spaced ticks 0.1x · 1x · 2x · 5x · 10x · 100x, log-interpolated
 * between neighbouring ticks. Slider positions run 0..SPEED_SLIDER_MAX.
 */
export const SPEED_SLIDER_MAX = 1000;
export const SPEED_TICKS = [0.1, 1, 2, 5, 10, 100] as const;
const SEG = SPEED_SLIDER_MAX / (SPEED_TICKS.length - 1);

export function speedToSlider(speed: number): number {
  const v = clamp(speed, LIMITS.speedMin, LIMITS.speedMax);
  for (let i = 0; i < SPEED_TICKS.length - 1; i++) {
    const a = SPEED_TICKS[i]!;
    const b = SPEED_TICKS[i + 1]!;
    if (v <= b) return Math.round(SEG * (i + Math.log(v / a) / Math.log(b / a)));
  }
  return SPEED_SLIDER_MAX;
}

/** Slider position → speed, rounded to 2 decimals (snapped to a tick within 1 % of it). */
export function sliderToSpeed(pos: number): number {
  const p = clamp(pos, 0, SPEED_SLIDER_MAX);
  const i = Math.min(SPEED_TICKS.length - 2, Math.floor(p / SEG));
  const a = SPEED_TICKS[i]!;
  const b = SPEED_TICKS[i + 1]!;
  const raw = a * Math.pow(b / a, (p - i * SEG) / SEG);
  for (const t of SPEED_TICKS) if (Math.abs(raw - t) / t < 0.01) return t;
  return clamp(Math.round(raw * 100) / 100, LIMITS.speedMin, LIMITS.speedMax);
}

/** Fraction (0..1) along the speed slider where a tick sits, for the tick marks. */
export const speedTickPos = (t: number): number => speedToSlider(t) / SPEED_SLIDER_MAX;

// ---------------------------------------------------------------- audio

export const formatDb = (db: number): string => (db <= LIMITS.volumeDbMin ? '-∞dB' : `${db.toFixed(1)}dB`);

/** Fade limits: in + out never exceed the clip. */
export const fadeMax = (clipDuration: Us, otherFade: Us): Us => Math.max(0, clipDuration - otherFade);

// ---------------------------------------------------------------- animation / transition limits

/** In + Out animations never exceed the clip; the minimum useful duration is 0.1 s. */
export const animationMax = (clipDuration: Us, otherDuration: Us): Us => Math.max(100_000, clipDuration - otherDuration);

/** Transition max = half the shorter of its two clips (and at least 0.1 s). */
export function transitionMax(p: Project, transitionId: Id): Us {
  const f = findTransition(p, transitionId);
  if (!f) return 100_000;
  const a = findClip(p, f.transition.fromClipId)?.clip;
  const b = findClip(p, f.transition.toClipId)?.clip;
  if (!a || !b) return 100_000;
  return Math.max(100_000, Math.floor(Math.min(a.duration, b.duration) / 2));
}

// ---------------------------------------------------------------- transform / align

/** On-canvas size of a clip at scale 1 = "contain" fit, times scale; axis-aligned box after rotation. */
export function displayedBox(
  src: { width: number; height: number },
  canvas: { width: number; height: number },
  scale: number | { x: number; y: number },
  rotationDeg: number,
  fit = true,
): { width: number; height: number } {
  const k = fit && src.width > 0 && src.height > 0 ? Math.min(canvas.width / src.width, canvas.height / src.height) : 1;
  const sx = typeof scale === 'number' ? scale : scale.x;
  const sy = typeof scale === 'number' ? scale : scale.y;
  const w = src.width * k * sx;
  const h = src.height * k * sy;
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { width: w * c + h * s, height: w * s + h * c };
}

export type AlignKind = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';

/** Position (from the canvas centre) that puts the box against the given canvas edge / centre. */
export function alignPosition(kind: AlignKind, box: { width: number; height: number }, canvas: { width: number; height: number }): { x?: number; y?: number } {
  const dx = Math.round((canvas.width - box.width) / 2);
  const dy = Math.round((canvas.height - box.height) / 2);
  switch (kind) {
    case 'left':
      return { x: -dx };
    case 'center-h':
      return { x: 0 };
    case 'right':
      return { x: dx };
    case 'top':
      return { y: -dy };
    case 'center-v':
      return { y: 0 };
    case 'bottom':
      return { y: dy };
  }
}

/** Degrees normalised to (-180, 180]. */
export function normalizeAngle(deg: number): number {
  let r = deg % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.round(r * 100) / 100;
}

/** Angle of a pointer around the dial centre: 0° = up, clockwise positive. */
export const dialAngle = (cx: number, cy: number, px: number, py: number): number =>
  normalizeAngle((Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI);

// ---------------------------------------------------------------- apply to all

/** "Apply to all": every clip on tracks of the same kind (main + overlay count as one kind), unlocked. */
export function applyAllTargets(p: Project, clipId: Id): Id[] {
  const f = findClip(p, clipId);
  if (!f) return [];
  const kind = f.track.kind === 'main' || f.track.kind === 'overlay' ? ['main', 'overlay'] : [f.track.kind];
  return p.tracks
    .filter((t) => kind.includes(t.kind) && !t.locked)
    .flatMap((t) => t.clips)
    .map((c) => c.id);
}

// ---------------------------------------------------------------- Video tab: uniform scale, mask

/**
 * Uniform scale switch. Off: width and height start from the current uniform scale. On: the
 * uniform scale takes the width scale (the clip keeps its width).
 */
export function uniformScalePatch(tf: Pick<Transform, 'scale' | 'scaleX' | 'scaleY'>, on: boolean): Partial<Transform> {
  if (on) return { uniformScale: true, scale: tf.scaleX };
  return { uniformScale: false, scaleX: tf.scale, scaleY: tf.scale };
}

/** The clip's picture at scale 1 (contain-fit, minus crop) in project px: what mask fractions refer to. */
export function pictureBox(
  src: { width?: number; height?: number } | undefined,
  canvas: { width: number; height: number },
  crop?: Crop,
): { w: number; h: number } {
  const sw = src?.width || canvas.width;
  const sh = src?.height || canvas.height;
  const k = Math.min(canvas.width / sw, canvas.height / sh);
  const c = crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  return { w: sw * k * Math.max(0, 1 - c.left - c.right), h: sh * k * Math.max(0, 1 - c.top - c.bottom) };
}

/**
 * Mask geometry when a shape tile is picked. Position, rotation, feather and invert carry over from
 * the previous shape; the size is each shape's default: Circle / Heart / Star a square half the
 * picture's shorter side, Rectangle 60 % × 40 %, Mirror a band 30 % of the height, Linear the
 * whole picture (its size is unused).
 */
export function maskForShape(shape: MaskShape, prev: ClipMask, box: { w: number; h: number }): Partial<ClipMask> {
  if (shape === 'none') return { shape };
  const keep = prev.shape === 'none' ? { x: 0, y: 0, rotation: 0 } : { x: prev.x, y: prev.y, rotation: prev.rotation };
  const side = 0.5 * Math.min(box.w, box.h);
  const sq = { width: box.w > 0 ? side / box.w : 0.5, height: box.h > 0 ? side / box.h : 0.5 };
  const size =
    shape === 'circle' || shape === 'heart' || shape === 'star'
      ? sq
      : shape === 'rectangle'
        ? { width: 0.6, height: 0.4 }
        : shape === 'mirror'
          ? { width: 1, height: 0.3 }
          : { width: 1, height: 1 };
  return { shape, ...keep, ...size, roundCorners: shape === 'rectangle' ? prev.roundCorners : 0 };
}
