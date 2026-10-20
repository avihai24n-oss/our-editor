/**
 * THE render contract. A pure function of (project, t) that says exactly what to draw and what
 * to hear at timeline time t. The Player and the Exporter both render from it, so preview and
 * export always match. No DOM, no React. See ./README.md.
 */
import { BLEND_MODES, CANVAS_BLUR_PX, filterDef } from '../model/catalog';
import { defaultAdjust, defaultGrade } from '../model/defaults';
import { fadeEnvelope, dbToGain, isTimedClip } from '../model/project';
import { clamp, clipContains, clipEnd, sourceSpan, sourceTimeAt, speedAtTime } from '../model/time';
import { animationFrame, composeFrames, type AnimFrame, type MaskShape } from './animations';
import type {
  Adjust,
  AnimationSlot,
  AnimationType,
  AudioProps,
  BlendMode,
  ChromaKey,
  ColorGrade,
  Clip,
  ClipMask,
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
  /** Multiplies the fitted size. Negative not used — see flipH/flipV. Geometric mean of scaleX/scaleY. */
  scale: number;
  /** Per-axis scale (= scale on both when Uniform scale is on). Use these to draw. */
  scaleX: number;
  scaleY: number;
  rotation: number; // degrees
  opacity: number; // 0..1, includes animation + transition alpha
  flipH: boolean;
  flipV: boolean;
}

/** Colour operations after filter + adjust are merged. Adjust units (−50..50 / 0..100). */
export interface ColorOps extends Adjust {
  grayscale: number; // 0..1
  sepia: number; // 0..1
  /** Adjust tab LUT / HSL / Curves / Color wheel / Mask (each section has its own enabled flag). */
  grade?: ColorGrade;
}

interface DrawOpBase {
  clipId: Id;
  trackId: Id;
  /** Index of the track in project.tracks (z-order). */
  layer: number;
  transform: ResolvedTransform;
  /** canvas globalCompositeOperation */
  composite: GlobalCompositeOperation;
  /** The Blend mode this op came from ('linear-burn' has no canvas composite; the compositor builds it). */
  blendMode: BlendMode;
  color: ColorOps;
  /** Gaussian blur in project px (animations / blur transition). 0 = none. */
  blur: number;
  /** Visible rectangle in NORMALISED canvas coords (0..1). null = whole canvas. Used by wipes. */
  clipRect: { x: number; y: number; w: number; h: number } | null;
  /** Debug/info: the main animation acting (In > Out > Combo > Loop) and its linear progress 0..1. */
  animation: ActiveAnimation | null;
  /**
   * Animation effects beyond the plain transform (non-uniform scale / skew, masks, light,
   * glitch, text reveal). null / absent = none. Built by `resolveAnimation`.
   */
  fx?: AnimFx | null;
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
  /** Video › Mask (null = none). */
  mask: ClipMask | null;
  /** Video › Remove BG › Chroma key (null = off). */
  chroma: ChromaKey | null;
  /**
   * 'background' = Video › Basic › Canvas fill drawn behind a main-track clip (blurred copy of the
   * clip or a chosen image, cover-fitted). Not hit-testable. Absent = the clip itself.
   */
  role?: 'background';
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
  fx: Pick<AudioProps, 'normalize' | 'reduceNoise' | 'fillChannel' | 'voiceFilter' | 'voiceIsolation'>;
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

/** One animation acting on a clip at t. */
export interface ActiveAnimation {
  phase: AnimationSlot;
  type: AnimationType;
  /** Linear 0..1 through the window (Loop: phase within the current cycle). */
  progress: number;
}

/** Animation effects the renderer applies on top of the transform. Pixel values in project px. */
export interface AnimFx {
  /** Non-uniform scale and skew (degrees) around the pivot (fractions of the clip box, 0 = centre). */
  sx: number;
  sy: number;
  skewX: number;
  skewY: number;
  pivotX: number;
  pivotY: number;
  /** CSS brightness multiplier. */
  brightness: number;
  /** Hue rotation, degrees. */
  hue: number;
  /** White glow 0..1. */
  glow: number;
  /** Channel split offset, project px. */
  rgbSplit: number;
  /** Max slice offset, project px. */
  slices: number;
  seed: number;
  /** Visible region: each group is a union of shapes; groups intersect. Box fractions. */
  masks: MaskShape[][];
  /** Text: fraction of characters drawn. */
  reveal: number;
}

/**
 * In/Out effect of one catalogue animation as a plain transform delta (kept for callers of the
 * v1 API; the renderer uses `resolveAnimation`, which also carries skew / masks / glitch).
 */
export function animationEffect(type: AnimationType, phase: 'in' | 'out', progress: number, W: number, H: number): Effect {
  const f = animationFrame(phase, type, progress);
  return { dx: f.dx * W, dy: f.dy * H, scaleMul: f.scale, rotation: f.rotation, alphaMul: f.alpha, blur: f.blur * (Math.min(W, H) / 1080) };
}

/** Every animation acting on the clip at t (In, Out, Combo, Loop), In first. */
export function activeAnimations(clip: VisualClip, t: Us): ActiveAnimation[] {
  const local = t - clip.start;
  const out: ActiveAnimation[] = [];
  if (local < 0 || local >= clip.duration) return out;
  const a = clip.animationIn;
  if (a && a.duration > 0 && local < a.duration) out.push({ phase: 'in', type: a.type, progress: local / a.duration });
  const b = clip.animationOut;
  if (b && b.duration > 0) {
    const from = clip.duration - b.duration;
    if (local >= from) out.push({ phase: 'out', type: b.type, progress: (local - from) / b.duration });
  }
  const c = clip.animationCombo;
  if (c && c.duration > 0 && local < c.duration) out.push({ phase: 'combo', type: c.type, progress: local / c.duration });
  const l = clip.animationLoop;
  if (l && l.duration > 0) out.push({ phase: 'loop', type: l.type, progress: (local % l.duration) / l.duration });
  return out;
}

/** Animation acting on the clip at t (In wins if both overlap; then Out, Combo, Loop). */
export function activeAnimation(clip: VisualClip, t: Us): ActiveAnimation | null {
  return activeAnimations(clip, t)[0] ?? null;
}

/**
 * Everything the clip's animations do at t: a transform delta (folded into the op transform)
 * plus the extra effects (`fx`, null when there are none). Pure.
 */
export function resolveAnimation(clip: VisualClip, t: Us, W: number, H: number): { effect: Effect; fx: AnimFx | null; active: ActiveAnimation[] } {
  const active = activeAnimations(clip, t);
  if (!active.length) return { effect: NO_EFFECT, fx: null, active };
  return { ...framesToOp(active.map((a) => animationFrame(a.phase, a.type, a.progress)), W, H), active };
}

/** Composes catalogue frames into a transform delta + fx (shared with the tile thumbnails). */
export function framesToOp(frames: AnimFrame[], W: number, H: number): { effect: Effect; fx: AnimFx | null } {
  const { frame: f, masks } = composeFrames(frames);
  const u = Math.min(W, H) / 1080;
  const effect: Effect = { dx: f.dx * W, dy: f.dy * H, scaleMul: f.scale, rotation: f.rotation, alphaMul: f.alpha, blur: Math.max(0, f.blur) * u };
  const fx: AnimFx = {
    sx: f.sx,
    sy: f.sy,
    skewX: f.skewX,
    skewY: f.skewY,
    pivotX: f.pivotX,
    pivotY: f.pivotY,
    brightness: Math.max(0, f.brightness),
    hue: f.hue,
    glow: clamp(f.glow, 0, 1),
    rgbSplit: Math.max(0, f.rgbSplit) * u,
    slices: Math.max(0, f.slices) * u,
    seed: f.seed,
    masks,
    reveal: clamp(f.reveal, 0, 1),
  };
  return { effect, fx: isNeutralFx(fx) ? null : fx };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
export function isNeutralFx(fx: AnimFx): boolean {
  return (
    near(fx.sx, 1) &&
    near(fx.sy, 1) &&
    near(fx.skewX, 0) &&
    near(fx.skewY, 0) &&
    near(fx.brightness, 1) &&
    near(((fx.hue % 360) + 360) % 360, 0) &&
    fx.glow < 1e-6 &&
    fx.rgbSplit < 1e-3 &&
    fx.slices < 1e-3 &&
    fx.masks.length === 0 &&
    near(fx.reveal, 1)
  );
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
  const out: ColorOps = { ...defaultAdjust(), ...own, grayscale: 0, sepia: 0, grade: clip.grade ?? defaultGrade() };
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
  const resolved = clipContains(clip, t) ? resolveAnimation(clip, t, W, H) : null;
  const a = resolved?.effect ?? NO_EFFECT;
  const anim = resolved?.active[0] ?? null;
  const x = extra ?? { ...NO_EFFECT, clipRect: null };
  const tf = clip.transform;
  const ax = baseScaleXY(tf);
  const mul = a.scaleMul * x.scaleMul;
  const transform: ResolvedTransform = {
    x: tf.x + a.dx + x.dx,
    y: tf.y + a.dy + x.dy,
    scale: Math.sqrt(ax.x * ax.y) * mul,
    scaleX: ax.x * mul,
    scaleY: ax.y * mul,
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
    blendMode: clip.blendEnabled === false ? ('normal' as const) : clip.blend,
    color: colorOps(clip),
    blur: a.blur + x.blur,
    clipRect: x.clipRect,
    animation: anim,
    fx: resolved?.fx ?? null,
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
    mask: clip.mask && clip.mask.shape !== 'none' ? clip.mask : null,
    chroma: clip.chroma && clip.chroma.enabled ? clip.chroma : null,
  };
}

/** Axis scales of a transform before animations (Uniform scale on → scale on both axes). */
export function baseScaleXY(tf: VisualClip['transform']): { x: number; y: number } {
  if (tf.uniformScale === false) return { x: tf.scaleX ?? tf.scale, y: tf.scaleY ?? tf.scale };
  return { x: tf.scale, y: tf.scale };
}

/** Cover-fit size of a w×h picture in a W×H canvas (fills it, overflow cropped). */
export function coverSize(w: number | undefined, h: number | undefined, W: number, H: number): { width: number; height: number } {
  const sw = w || W;
  const sh = h || H;
  const k = Math.max(W / sw, H / sh);
  return { width: sw * k, height: sh * k };
}

/** Blur backgrounds are drawn this much larger so the blur's soft border stays off-canvas. */
export const CANVAS_BLUR_OVERSCAN = 1.15;

/**
 * Video › Basic › Canvas: the op drawn behind a main-track clip, or null. Transition alpha and wipe
 * rect follow the clip so a Mix fades the incoming background with its clip.
 */
export function canvasBackgroundOp(
  project: Project,
  track: Track,
  layer: number,
  clip: VisualClip,
  t: Us,
  extra: (Effect & { clipRect: DrawOpBase['clipRect'] }) | null,
): MediaDrawOp | FillDrawOp | null {
  if (track.kind !== 'main' || (clip.type !== 'video' && clip.type !== 'image') || !clip.canvas) return null;
  const bg = clip.canvas;
  const { width: W, height: H } = project.settings;
  const alpha = clamp(extra ? extra.alphaMul : 1, 0, 1);
  if (bg.type === 'color') return { kind: 'fill', trackId: track.id, layer, color: bg.color, opacity: alpha };
  if (bg.type !== 'blur' && bg.type !== 'image') return null;
  const assetId = bg.type === 'blur' ? clip.assetId : bg.assetId;
  const asset = assetId ? project.assets[assetId] : undefined;
  if (!assetId || !asset || asset.missing) return null;
  const cover = coverSize(asset.width, asset.height, W, H);
  const over = bg.type === 'blur' ? CANVAS_BLUR_OVERSCAN : 1;
  const level = Math.min(4, Math.max(1, Math.round(bg.blur))) - 1;
  return {
    kind: 'media',
    role: 'background',
    clipId: clip.id,
    trackId: track.id,
    layer,
    mediaType: bg.type === 'blur' ? clip.type : 'image',
    assetId,
    sourceTime: bg.type === 'blur' ? clampSource(clip, project, t) : 0,
    fitWidth: cover.width * over,
    fitHeight: cover.height * over,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: alpha, flipH: false, flipV: false },
    composite: 'source-over',
    blendMode: 'normal',
    color: { ...defaultAdjust(), grayscale: 0, sepia: 0 },
    blur: bg.type === 'blur' ? CANVAS_BLUR_PX[level]! : 0,
    clipRect: extra ? extra.clipRect : null,
    mask: null,
    chroma: null,
    animation: null,
    transition: null,
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
    const pushClip = (clip: VisualClip, extra: Parameters<typeof buildVisualOp>[5], info: DrawOpBase['transition']) => {
      const bg = canvasBackgroundOp(project, track, layer, clip, t, extra);
      if (bg) ops.push(bg);
      ops.push(buildVisualOp(project, track, layer, clip, t, extra, info));
    };
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
        if (from && from.type !== 'audio' && !from.disabled && fx.from.visible) pushClip(from, fx.from, info('from'));
        if (to && to.type !== 'audio' && !to.disabled && fx.to.visible) pushClip(to, fx.to, info('to'));
        if (fx.fill && fx.fill.opacity > 0) ops.push({ kind: 'fill', trackId: track.id, layer, color: fx.fill.color, opacity: fx.fill.opacity });
      } else {
        const clip = track.clips.find((c) => clipContains(c, t));
        if (clip && clip.type !== 'audio' && !clip.disabled) pushClip(clip, null, null);
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
          voiceIsolation: clip.audio.voiceIsolation ?? null,
        },
        spanIn: clip.inPoint,
        spanLength: sourceSpan(clip),
      });
    }
  });

  return { t, width: W, height: H, background, ops, audio };
}
