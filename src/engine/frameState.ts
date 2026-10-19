/**
 * THE render contract. A pure function of (project, t) that says exactly what to draw and what
 * to hear at timeline time t. The Player and the Exporter both render from it, so preview and
 * export always match. No DOM, no React. See ./README.md.
 */
import { BLEND_MODES, filterDef } from '../model/catalog';
import { defaultAdjust } from '../model/defaults';
import { fadeEnvelope, dbToGain, isTimedClip } from '../model/project';
import { clamp, clipContains, clipEnd, sourceSpan, sourceTimeAt, speedAtTime } from '../model/time';
import type {
  Adjust,
  AnimationType,
  AudioProps,
  Clip,
  Crop,
  Id,
  MediaAsset,
  Project,
  TextStyle,
  Track,
  Transition,
  TransitionType,
  Us,
  VisualClip,
} from '../model/types';

// ---------------------------------------------------------------- output types

/** Final, fully resolved transform in project pixels. Draw centred at (W/2 + x, H/2 + y). */
export interface ResolvedTransform {
  x: number;
  y: number;
  /** Multiplies the fitted size. Negative not used — see flipH/flipV. */
  scale: number;
  rotation: number; // degrees
  opacity: number; // 0..1, includes animation + transition alpha
  flipH: boolean;
  flipV: boolean;
}

/** Colour operations after filter + adjust are merged. Adjust units (−50..50 / 0..100). */
export interface ColorOps extends Adjust {
  grayscale: number; // 0..1
  sepia: number; // 0..1
}

interface DrawOpBase {
  clipId: Id;
  trackId: Id;
  /** Index of the track in project.tracks (z-order). */
  layer: number;
  transform: ResolvedTransform;
  /** canvas globalCompositeOperation */
  composite: GlobalCompositeOperation;
  color: ColorOps;
  /** Gaussian blur in project px (animations / blur transition). 0 = none. */
  blur: number;
  /** Visible rectangle in NORMALISED canvas coords (0..1). null = whole canvas. Used by wipes. */
  clipRect: { x: number; y: number; w: number; h: number } | null;
  /** Debug/info: which animation is acting and its linear progress 0..1. */
  animation: { phase: 'in' | 'out'; type: AnimationType; progress: number } | null;
  /** Debug/info: transition acting on this op and its linear progress 0..1 across the window. */
  transition: { id: Id; type: TransitionType; role: 'from' | 'to'; progress: number } | null;
}

export interface MediaDrawOp extends DrawOpBase {
  kind: 'media';
  mediaType: 'video' | 'image';
  assetId: Id;
  /** Video: source time to show, µs, clamped to [0, asset.duration]. Image: 0. */
  sourceTime: Us;
  /** Video: instantaneous playback speed at t (standard speed, or the curve's value). Image: 1. */
  speed?: number;
  /** True when the speed changes over the clip (Speed › Curve). */
  varying?: boolean;
  /** Size of the media at scale 1 = "contain" fit in the canvas, project px (before crop). */
  fitWidth: number;
  fitHeight: number;
  /** Source crop as fractions. Draw sub-rect of the source and shrink the fitted box accordingly. */
  crop: Crop;
}

export interface TextDrawOp extends DrawOpBase {
  kind: 'text';
  style: TextStyle;
  /** content split into lines. */
  lines: string[];
}

/** Full-canvas colour fill (dip-to-black / white flash transitions). Drawn in sequence. */
export interface FillDrawOp {
  kind: 'fill';
  trackId: Id;
  layer: number;
  color: string;
  opacity: number;
}

export type DrawOp = MediaDrawOp | TextDrawOp | FillDrawOp;

export interface AudioOp {
  clipId: Id;
  assetId: Id;
  trackId: Id;
  /** Source time to be heard now, µs. */
  sourceTime: Us;
  /** Instantaneous speed at t (standard speed, or the curve's value at t). */
  speed: number;
  /** True when the speed changes over the clip (Speed › Curve). */
  varying?: boolean;
  preservePitch: boolean;
  /** Linear gain including volume dB, fades. Track/clip mute already removed these ops. */
  gain: number;
  /**
   * Audio FX (Audio › Basic / Voice changer). `normalize` is applied by the audio engine with the
   * loudness measured over the source span below (src/audio/measure.ts).
   */
  fx: Pick<AudioProps, 'normalize' | 'reduceNoise' | 'fillChannel' | 'voiceFilter'>;
  /** Source span heard by the clip, µs: [inPoint, inPoint + spanLength). */
  spanIn: Us;
  spanLength: Us;
}

export interface FrameState {
  t: Us;
  width: number;
  height: number;
  background: string;
  /** Draw in this order (bottom → top). */
  ops: DrawOp[];
  /** Everything audible at t. */
  audio: AudioOp[];
}

/**
 * Look a source frame up at `sourceTime + FRAME_LOOKUP_EPS_US`, never at `sourceTime` itself.
 *
 * Timeline frame times are whole microseconds (frame 1 at 30 fps = 33 333 µs, not 33 333.3), and
 * the clip speed multiplies that rounding: at 2× timeline frame 1 maps to 66 666 µs while source
 * frame 2 starts at 66 666.7 µs, so an exact lookup lands one frame early. The error is at most
 * 0.5 µs × (speed + 1) ≈ 51 µs at 100×; 100 µs covers it and is far below half a frame at any
 * real frame rate (2 083 µs at 240 fps). The player and both exporters use this one constant, so
 * preview and export pick the same frame.
 */
export const FRAME_LOOKUP_EPS_US = 100;

/** Seconds to seek / look up for a media op's source time (see FRAME_LOOKUP_EPS_US). */
export const frameLookupSec = (sourceTime: Us): number => (sourceTime + FRAME_LOOKUP_EPS_US) / 1e6;

// ---------------------------------------------------------------- easing + effects (pure)

export const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
export const easeInOutCubic = (p: number): number => {
  const x = clamp(p, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export interface Effect {
  dx: number; // px
  dy: number; // px
  scaleMul: number;
  rotation: number; // degrees added
  alphaMul: number;
  blur: number; // px
}
const NO_EFFECT: Effect = { dx: 0, dy: 0, scaleMul: 1, rotation: 0, alphaMul: 1, blur: 0 };

/**
 * In/Out animation effect. `progress` is linear 0..1 through the animation window.
 * In: starts displaced, ends at rest. Out: starts at rest, ends displaced (continuing in the
 * named direction, e.g. Slide Left exits to the left).
 */
export function animationEffect(type: AnimationType, phase: 'in' | 'out', progress: number, W: number, H: number): Effect {
  // amount of displacement remaining: 1 = fully displaced, 0 = at rest
  const k = phase === 'in' ? 1 - easeOutCubic(progress) : easeInOutCubic(progress);
  switch (type) {
    case 'fade':
      return { ...NO_EFFECT, alphaMul: 1 - k };
    case 'zoom-in':
      return { ...NO_EFFECT, scaleMul: phase === 'in' ? 1 - 0.5 * k : 1 + 0.5 * k, alphaMul: 1 - k };
    case 'zoom-out':
      return { ...NO_EFFECT, scaleMul: phase === 'in' ? 1 + 0.5 * k : 1 - 0.5 * k, alphaMul: 1 - k };
    case 'slide-left':
      return { ...NO_EFFECT, dx: phase === 'in' ? W * k : -W * k };
    case 'slide-right':
      return { ...NO_EFFECT, dx: phase === 'in' ? -W * k : W * k };
    case 'slide-up':
      return { ...NO_EFFECT, dy: phase === 'in' ? H * k : -H * k };
    case 'slide-down':
      return { ...NO_EFFECT, dy: phase === 'in' ? -H * k : H * k };
    case 'rotate':
      return { ...NO_EFFECT, rotation: (phase === 'in' ? -180 : 180) * k, scaleMul: 1 - 0.5 * k, alphaMul: 1 - k };
    case 'blur':
      return { ...NO_EFFECT, blur: 40 * k, alphaMul: 1 - 0.5 * k };
  }
}

export interface TransitionEffect {
  from: Effect & { visible: boolean; clipRect: DrawOpBase['clipRect'] };
  to: Effect & { visible: boolean; clipRect: DrawOpBase['clipRect'] };
  /** Optional full-canvas fill drawn AFTER both clips. */
  fill: { color: string; opacity: number } | null;
}

/**
 * Transition effect at linear progress p (0..1 across the window; the cut is at p = 0.5).
 * `from` is drawn first, `to` on top.
 */
export function transitionEffect(type: TransitionType, p: number, W: number, H: number): TransitionEffect {
  const e = easeInOutCubic(p);
  const show = { ...NO_EFFECT, visible: true, clipRect: null };
  const hide = { ...NO_EFFECT, visible: false, clipRect: null };
  switch (type) {
    case 'mix':
      return { from: show, to: { ...show, alphaMul: p }, fill: null };
    case 'fade-black':
    case 'fade-white': {
      const color = type === 'fade-black' ? '#000000' : '#ffffff';
      const opacity = p < 0.5 ? p * 2 : (1 - p) * 2;
      return { from: p < 0.5 ? show : hide, to: p < 0.5 ? hide : show, fill: { color, opacity } };
    }
    case 'slide-left':
      return { from: { ...show, dx: -W * e }, to: { ...show, dx: W * (1 - e) }, fill: null };
    case 'slide-right':
      return { from: { ...show, dx: W * e }, to: { ...show, dx: -W * (1 - e) }, fill: null };
    case 'slide-up':
      return { from: { ...show, dy: -H * e }, to: { ...show, dy: H * (1 - e) }, fill: null };
    case 'slide-down':
      return { from: { ...show, dy: H * e }, to: { ...show, dy: -H * (1 - e) }, fill: null };
    case 'wipe-left':
      return { from: show, to: { ...show, clipRect: { x: 1 - e, y: 0, w: e, h: 1 } }, fill: null };
    case 'wipe-right':
      return { from: show, to: { ...show, clipRect: { x: 0, y: 0, w: e, h: 1 } }, fill: null };
    case 'zoom':
      return { from: { ...show, scaleMul: 1 + 0.5 * e }, to: { ...show, alphaMul: e, scaleMul: 0.8 + 0.2 * e }, fill: null };
    case 'blur': {
      const b = Math.sin(Math.PI * p) * 30;
      return { from: { ...show, blur: b }, to: { ...show, blur: b, alphaMul: p }, fill: null };
    }
  }
}

// ---------------------------------------------------------------- helpers

/** Contain-fit size of a media asset in a W×H canvas (scale 1). Text returns the canvas. */
export function fitSize(asset: Pick<MediaAsset, 'width' | 'height'> | undefined, W: number, H: number): { width: number; height: number } {
  const w = asset?.width || W;
  const h = asset?.height || H;
  const k = Math.min(W / w, H / h);
  return { width: w * k, height: h * k };
}

/** Clip's own filter merged into its adjust (filter scaled by intensity). */
export function colorOps(clip: VisualClip): ColorOps {
  const own = clip.adjustEnabled === false ? defaultAdjust() : clip.adjust;
  const out: ColorOps = { ...own, grayscale: 0, sepia: 0 };
  const f = clip.filter ? filterDef(clip.filter.id) : undefined;
  if (f && clip.filter) {
    const k = clamp(clip.filter.intensity, 0, 1);
    for (const [key, v] of Object.entries(f.adjust) as [keyof Adjust, number][]) out[key] += v * k;
    out.grayscale = (f.grayscale ?? 0) * k;
    out.sepia = (f.sepia ?? 0) * k;
  }
  return out;
}

const compositeOf = (clip: VisualClip): GlobalCompositeOperation =>
  clip.blendEnabled === false ? 'source-over' : (BLEND_MODES.find((b) => b.id === clip.blend)?.composite ?? 'source-over');

/** Animation acting on the clip at t (In wins if both overlap). */
export function activeAnimation(clip: VisualClip, t: Us): { phase: 'in' | 'out'; type: AnimationType; progress: number } | null {
  const local = t - clip.start;
  const a = clip.animationIn;
  if (a && a.duration > 0 && local >= 0 && local < a.duration) return { phase: 'in', type: a.type, progress: local / a.duration };
  const b = clip.animationOut;
  if (b && b.duration > 0) {
    const from = clip.duration - b.duration;
    if (local >= from && local < clip.duration) return { phase: 'out', type: b.type, progress: (local - from) / b.duration };
  }
  return null;
}

/** Transition window [cut − d/2, cut + d/2). */
export function transitionWindow(track: Track, tr: Transition): { start: Us; end: Us; cut: Us } | null {
  const from = track.clips.find((c) => c.id === tr.fromClipId);
  if (!from) return null;
  const cut = clipEnd(from);
  const half = Math.floor(tr.duration / 2);
  return { start: cut - half, end: cut - half + tr.duration, cut };
}

function clampSource(clip: Clip, project: Project, t: Us): Us {
  if (!isTimedClip(clip)) return 0;
  const asset = project.assets[clip.assetId];
  const max = asset ? Math.max(0, asset.duration - 1) : Number.MAX_SAFE_INTEGER;
  return clamp(sourceTimeAt(clip, t), 0, max);
}

function buildVisualOp(
  project: Project,
  track: Track,
  layer: number,
  clip: VisualClip,
  t: Us,
  extra: (Effect & { clipRect: DrawOpBase['clipRect'] }) | null,
  transitionInfo: DrawOpBase['transition'],
): MediaDrawOp | TextDrawOp {
  const { width: W, height: H } = project.settings;
  const anim = clipContains(clip, t) ? activeAnimation(clip, t) : null;
  const a = anim ? animationEffect(anim.type, anim.phase, anim.progress, W, H) : NO_EFFECT;
  const x = extra ?? { ...NO_EFFECT, clipRect: null };
  const tf = clip.transform;
  const transform: ResolvedTransform = {
    x: tf.x + a.dx + x.dx,
    y: tf.y + a.dy + x.dy,
    scale: tf.scale * a.scaleMul * x.scaleMul,
    rotation: tf.rotation + a.rotation + x.rotation,
    opacity: clamp((clip.blendEnabled === false ? 1 : tf.opacity) * a.alphaMul * x.alphaMul, 0, 1),
    flipH: tf.flipH,
    flipV: tf.flipV,
  };
  const base = {
    clipId: clip.id,
    trackId: track.id,
    layer,
    transform,
    composite: compositeOf(clip),
    color: colorOps(clip),
    blur: a.blur + x.blur,
    clipRect: x.clipRect,
    animation: anim,
    transition: transitionInfo,
  };
  if (clip.type === 'text') {
    return { ...base, kind: 'text', style: clip.text, lines: clip.text.content.split('\n') };
  }
  const asset = project.assets[clip.assetId];
  const fit = fitSize(asset, W, H);
  return {
    ...base,
    kind: 'media',
    mediaType: clip.type,
    assetId: clip.assetId,
    sourceTime: clampSource(clip, project, t),
    speed: clip.type === 'video' ? speedAtTime(clip, t) : 1,
    varying: clip.type === 'video' && !!clip.speedCurve,
    fitWidth: fit.width,
    fitHeight: fit.height,
    crop: clip.crop,
  };
}

// ---------------------------------------------------------------- main entry

/**
 * Everything to draw and hear at timeline time t.
 * - Visual tracks in project.tracks order (index 0 = bottom). Hidden tracks are skipped.
 *   Disabled clips are skipped. Missing assets still produce ops (the renderer draws nothing).
 * - Inside a transition window both clips are drawn (from, then to) with the transition effect;
 *   outside their own range a clip's source time is clamped (edge frame is held).
 * - Audio: video clips with hasAudio !== false and audio clips, minus muted tracks/clips.
 */
export function getFrameState(project: Project, t: Us): FrameState {
  const { width: W, height: H, background } = project.settings;
  const ops: DrawOp[] = [];
  const audio: AudioOp[] = [];

  project.tracks.forEach((track, layer) => {
    // ---- pictures
    if (track.kind !== 'audio' && !track.hidden) {
      const active = track.transitions
        .map((tr) => ({ tr, w: transitionWindow(track, tr) }))
        .find((x) => x.w && t >= x.w.start && t < x.w.end);
      if (active && active.w) {
        const from = track.clips.find((c) => c.id === active.tr.fromClipId);
        const to = track.clips.find((c) => c.id === active.tr.toClipId);
        const p = (t - active.w.start) / active.tr.duration;
        const fx = transitionEffect(active.tr.type, p, W, H);
        const info = (role: 'from' | 'to') => ({ id: active.tr.id, type: active.tr.type, role, progress: p });
        if (from && from.type !== 'audio' && !from.disabled && fx.from.visible) ops.push(buildVisualOp(project, track, layer, from, t, fx.from, info('from')));
        if (to && to.type !== 'audio' && !to.disabled && fx.to.visible) ops.push(buildVisualOp(project, track, layer, to, t, fx.to, info('to')));
        if (fx.fill && fx.fill.opacity > 0) ops.push({ kind: 'fill', trackId: track.id, layer, color: fx.fill.color, opacity: fx.fill.opacity });
      } else {
        const clip = track.clips.find((c) => clipContains(c, t));
        if (clip && clip.type !== 'audio' && !clip.disabled) ops.push(buildVisualOp(project, track, layer, clip, t, null, null));
      }
    }

    // ---- sound
    if (track.muted) return;
    for (const clip of track.clips) {
      if (!clipContains(clip, t) || clip.disabled) continue;
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      if (clip.audio.muted) continue;
      const asset = project.assets[clip.assetId];
      if (clip.type === 'video' && asset?.hasAudio === false) continue;
      const gain = dbToGain(clip.audio.volumeDb) * fadeEnvelope(clip, t);
      audio.push({
        clipId: clip.id,
        assetId: clip.assetId,
        trackId: track.id,
        sourceTime: clampSource(clip, project, t),
        speed: speedAtTime(clip, t),
        varying: !!clip.speedCurve,
        preservePitch: clip.preservePitch,
        gain,
        fx: {
          normalize: !!clip.audio.normalize,
          reduceNoise: !!clip.audio.reduceNoise,
          fillChannel: clip.audio.fillChannel ?? null,
          voiceFilter: clip.audio.voiceFilter ?? null,
        },
        spanIn: clip.inPoint,
        spanLength: sourceSpan(clip),
      });
    }
  });

  return { t, width: W, height: H, background, ops, audio };
}
