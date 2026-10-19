/**
 * THE animation catalogue (CapCut Animation tab): every In, Out, Combo and text Loop animation,
 * each a pure function of linear progress → AnimFrame. No DOM, no React.
 *
 * The player, the exporter and the inspector's tile thumbnails all go through
 * `getFrameState` → `renderFrame`, which read the frames produced here, so a preview, a tile
 * thumbnail and the exported MP4 always show the same motion.
 *
 * Conventions
 * - In / Out are written once as a "shape" of k = remaining displacement (1 = fully displaced,
 *   0 = at rest). In:  k = 1 − ease(p)  → the clip settles at rest at p = 1.
 *              Out: k = 1 − ease(1 − p) → the exact time-reverse of In, starting at rest at
 *              p = 0. By default the Out version is MIRRORED (directions flipped) so the motion
 *              continues the way it was named: "Slide Left" enters from the right AND exits to the
 *              left. A def can give its own `outShape`.
 * - Combo: frame(p) is at rest at p = 0 and p = 1 (it moves away and comes back).
 * - Loop (text): frame(phase) is periodic, at rest at phase 0 and 1.
 * - Distances: dx / dy are fractions of the canvas width / height. blur, rgbSplit and slices are
 *   pixels on a canvas whose short side is 1080 (frameState rescales them).
 * - Masks are in fractions (0..1) of the clip's own box and move with the clip.
 */

export type AnimPhase = 'in' | 'out' | 'combo' | 'loop';
export type AnimCategory = 'trending' | 'basic' | 'light' | 'glitch' | 'mask' | '3d' | 'vibration';
export type AnimTarget = 'any' | 'text';

/** Category chips, CapCut order (★ favourites is a separate chip in the UI). */
export const ANIM_CATEGORIES: { id: AnimCategory; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'basic', label: 'Basic' },
  { id: 'light', label: 'Light' },
  { id: 'glitch', label: 'Glitch' },
  { id: 'mask', label: 'Mask' },
  { id: '3d', label: '3D' },
  { id: 'vibration', label: 'Vibration' },
];

export type MaskShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  /** r in units of the box diagonal (0.5 covers the whole box from its centre). */
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'poly'; pts: [number, number][] };

export interface AnimFrame {
  /** Offset, fraction of canvas W / H. */
  dx: number;
  dy: number;
  /** Uniform scale multiplier (folded into the clip transform). */
  scale: number;
  /** Extra non-uniform scale and skew (degrees) around (pivotX, pivotY), box fractions −0.5..0.5. */
  sx: number;
  sy: number;
  skewX: number;
  skewY: number;
  pivotX: number;
  pivotY: number;
  /** Degrees, clockwise, added to the clip rotation. */
  rotation: number;
  /** Opacity multiplier. */
  alpha: number;
  /** Gaussian blur, px @1080. */
  blur: number;
  /** CSS brightness multiplier (1 = neutral). */
  brightness: number;
  /** Hue rotation, degrees. */
  hue: number;
  /** White glow strength 0..1. */
  glow: number;
  /** Red/blue channel offset, px @1080. */
  rgbSplit: number;
  /** Max horizontal offset of glitch slices, px @1080. */
  slices: number;
  /** Deterministic seed for the slice pattern. */
  seed: number;
  /** Visible region (union of shapes), null = everything. */
  mask: MaskShape[] | null;
  /** Text only: fraction of characters drawn (typewriter). */
  reveal: number;
}

export const IDENTITY_FRAME: Readonly<AnimFrame> = Object.freeze({
  dx: 0,
  dy: 0,
  scale: 1,
  sx: 1,
  sy: 1,
  skewX: 0,
  skewY: 0,
  pivotX: 0,
  pivotY: 0,
  rotation: 0,
  alpha: 1,
  blur: 0,
  brightness: 1,
  hue: 0,
  glow: 0,
  rgbSplit: 0,
  slices: 0,
  seed: 0,
  mask: null,
  reveal: 1,
});

export interface AnimDef {
  id: string;
  label: string;
  phase: AnimPhase;
  categories: AnimCategory[];
  /** 'text' = only offered for text clips. */
  target: AnimTarget;
  /** Glitch-style animations jump on purpose (still bounded by an envelope that reaches rest). */
  jumpy?: boolean;
  /** Linear progress 0..1 (Loop: phase within one cycle) → frame. */
  frame(p: number): AnimFrame;
}

// ---------------------------------------------------------------- easing

export type EaseName = 'linear' | 'quad' | 'cubic' | 'quart' | 'expo' | 'sine' | 'back' | 'elastic' | 'bounce';

const c01 = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/** "Out" easings (fast start, slow end). E(0) = 0, E(1) = 1. back/elastic overshoot. */
export const EASE: Record<EaseName, (p: number) => number> = {
  linear: (p) => c01(p),
  quad: (p) => 1 - (1 - c01(p)) ** 2,
  cubic: (p) => 1 - (1 - c01(p)) ** 3,
  quart: (p) => 1 - (1 - c01(p)) ** 4,
  expo: (p) => {
    const x = c01(p);
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  },
  sine: (p) => Math.sin((c01(p) * Math.PI) / 2),
  back: (p) => {
    const x = c01(p);
    const s = 1.70158;
    return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
  },
  elastic: (p) => {
    const x = c01(p);
    if (x === 0 || x === 1) return x;
    return Math.pow(2, -10 * x) * Math.sin(((x * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
  },
  bounce: (p) => {
    let x = c01(p);
    const n = 7.5625;
    const d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  },
};

export const easeInOut = (p: number) => {
  const x = c01(p);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Deterministic noise in [−1, 1] (same on every machine, so preview = export). */
export function noise(seed: number, i: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// ---------------------------------------------------------------- helpers

type Shape = (k: number) => Partial<AnimFrame>;

const frameOf = (part: Partial<AnimFrame>): AnimFrame => ({ ...IDENTITY_FRAME, ...part });

const mirrorMask = (m: MaskShape): MaskShape => {
  switch (m.kind) {
    case 'rect':
      return { kind: 'rect', x: 1 - m.x - m.w, y: 1 - m.y - m.h, w: m.w, h: m.h };
    case 'circle':
      return { kind: 'circle', cx: 1 - m.cx, cy: 1 - m.cy, r: m.r };
    case 'poly':
      return { kind: 'poly', pts: m.pts.map(([x, y]) => [1 - x, 1 - y] as [number, number]) };
  }
};

/** Flips every direction of a frame (used to derive Out from In). */
export function mirrorFrame(f: Partial<AnimFrame>): Partial<AnimFrame> {
  const out: Partial<AnimFrame> = { ...f };
  if (f.dx !== undefined) out.dx = -f.dx;
  if (f.dy !== undefined) out.dy = -f.dy;
  if (f.rotation !== undefined) out.rotation = -f.rotation;
  if (f.skewX !== undefined) out.skewX = -f.skewX;
  if (f.skewY !== undefined) out.skewY = -f.skewY;
  if (f.pivotX !== undefined) out.pivotX = -f.pivotX;
  if (f.pivotY !== undefined) out.pivotY = -f.pivotY;
  if (f.mask) out.mask = f.mask.map(mirrorMask);
  return out;
}

const rect = (x: number, y: number, w: number, h: number): MaskShape => ({ kind: 'rect', x, y, w: Math.max(0, w), h: Math.max(0, h) });
/** Mask only while displaced, so at rest there is no mask at all. */
const masked = (k: number, shapes: () => MaskShape[]): Partial<AnimFrame> => (k > 1e-9 ? { mask: shapes() } : {});
const S = (x: number) => Math.sin(x);
const PI = Math.PI;

// ---------------------------------------------------------------- In / Out

interface PairDef {
  id: string;
  labelIn: string;
  labelOut: string;
  categories: AnimCategory[];
  target?: AnimTarget;
  ease: EaseName;
  jumpy?: boolean;
  shape: Shape;
  /** Out shape (k → frame). Default: mirrorFrame(shape(k)). */
  outShape?: Shape;
  /** Offer only one side. */
  only?: 'in' | 'out';
}

const PAIRS: PairDef[] = [
  // ---- basic
  { id: 'fade', labelIn: 'Fade In', labelOut: 'Fade Out', categories: ['trending', 'basic'], ease: 'linear', shape: (k) => ({ alpha: 1 - k }) },
  {
    id: 'zoom-in',
    labelIn: 'Zoom In',
    labelOut: 'Zoom In',
    categories: ['basic'],
    ease: 'cubic',
    shape: (k) => ({ scale: 1 - 0.5 * k, alpha: 1 - k }),
    outShape: (k) => ({ scale: 1 + 0.5 * k, alpha: 1 - k }),
  },
  {
    id: 'zoom-out',
    labelIn: 'Zoom Out',
    labelOut: 'Zoom Out',
    categories: ['trending', 'basic'],
    ease: 'cubic',
    shape: (k) => ({ scale: 1 + 0.5 * k, alpha: 1 - k }),
    outShape: (k) => ({ scale: 1 - 0.5 * k, alpha: 1 - k }),
  },
  { id: 'zoom-1', labelIn: 'Zoom 1', labelOut: 'Zoom 1', categories: ['trending', 'basic'], ease: 'quart', shape: (k) => ({ scale: 1 + 1.2 * k, blur: 30 * k }) },
  { id: 'pop', labelIn: 'Pop Up', labelOut: 'Pop Down', categories: ['trending', 'basic'], ease: 'back', shape: (k) => ({ scale: 1 - k, alpha: 1 - Math.max(0, Math.min(1, k)) * 0.2 }) },
  { id: 'slide-left', labelIn: 'Slide Left', labelOut: 'Slide Left', categories: ['basic'], ease: 'cubic', shape: (k) => ({ dx: k }) },
  { id: 'slide-right', labelIn: 'Slide Right', labelOut: 'Slide Right', categories: ['trending', 'basic'], ease: 'cubic', shape: (k) => ({ dx: -k }) },
  { id: 'slide-up', labelIn: 'Slide Up', labelOut: 'Slide Up', categories: ['basic'], ease: 'cubic', shape: (k) => ({ dy: k }) },
  { id: 'slide-down', labelIn: 'Slide Down', labelOut: 'Slide Down', categories: ['trending', 'basic'], ease: 'cubic', shape: (k) => ({ dy: -k }) },
  { id: 'rotate', labelIn: 'Rotate', labelOut: 'Rotate', categories: ['basic'], ease: 'cubic', shape: (k) => ({ rotation: -180 * k, scale: 1 - 0.5 * k, alpha: 1 - k }) },
  {
    id: 'rotate-entry',
    labelIn: 'Rotating Entry',
    labelOut: 'Rotating Exit',
    categories: ['trending', 'basic'],
    ease: 'cubic',
    shape: (k) => ({ rotation: -360 * k, scale: 1 - 0.8 * k, alpha: 1 - k }),
  },
  { id: 'flip', labelIn: 'Flip', labelOut: 'Flip', categories: ['trending', 'basic', '3d'], ease: 'cubic', shape: (k) => ({ sx: Math.cos((Math.min(1, k) * PI) / 2) }) },
  {
    id: 'swing',
    labelIn: 'Swing',
    labelOut: 'Swing',
    categories: ['trending', 'vibration'],
    ease: 'linear',
    shape: (k) => ({ rotation: 30 * k * Math.cos(4 * PI * (1 - k)), alpha: 1 - k * k }),
  },
  {
    id: 'swing-bottom',
    labelIn: 'Swing from Bottom',
    labelOut: 'Swing to Bottom',
    categories: ['vibration'],
    ease: 'linear',
    shape: (k) => ({ dy: 0.25 * k * k, rotation: -25 * k * Math.cos(3 * PI * (1 - k)), alpha: 1 - k }),
  },
  { id: 'shake', labelIn: 'Shake 1', labelOut: 'Shake 1', categories: ['trending', 'vibration'], ease: 'linear', shape: (k) => ({ dx: 0.06 * k * S(10 * PI * k) }) },
  { id: 'shake-slide', labelIn: 'Shake Slide', labelOut: 'Shake Slide', categories: ['trending', 'vibration'], ease: 'quad', shape: (k) => ({ dx: 0.5 * k + 0.04 * k * S(12 * PI * k), alpha: 1 - k }) },
  { id: 'rock-vertical', labelIn: 'Rock Vertically', labelOut: 'Rock Vertically', categories: ['trending', 'vibration'], ease: 'linear', shape: (k) => ({ dy: 0.08 * k * S(10 * PI * k) }) },
  {
    id: 'turbulence',
    labelIn: 'Turbulence',
    labelOut: 'Turbulence',
    categories: ['vibration'],
    ease: 'linear',
    shape: (k) => ({ dx: 0.04 * k * S(17 * k), dy: 0.04 * k * S(13 * k + 1) - 0.04 * k * S(1), rotation: 6 * k * S(11 * k), blur: 20 * k }),
  },
  {
    id: 'jelly',
    labelIn: 'Jelly I',
    labelOut: 'Jelly I',
    categories: ['trending', 'vibration'],
    ease: 'linear',
    shape: (k) => ({ sx: 1 + 0.35 * k * S(6 * PI * k), sy: 1 - 0.35 * k * S(6 * PI * k) }),
  },
  {
    id: 'jelly-2',
    labelIn: 'Jelly II',
    labelOut: 'Jelly II',
    categories: ['vibration'],
    ease: 'linear',
    shape: (k) => ({ sx: 1 + 0.4 * k * Math.cos(5 * PI * k), sy: 1 - 0.4 * k * Math.cos(5 * PI * k), scale: 1 - 0.2 * k }),
  },
  { id: 'bounce', labelIn: 'Super Bounce', labelOut: 'Super Bounce', categories: ['trending', 'basic'], ease: 'back', shape: (k) => ({ dy: 0.4 * k, scale: 1 - 0.3 * k, alpha: 1 - Math.max(0, k) }) },
  { id: 'drop-down', labelIn: 'Drop Down', labelOut: 'Drop Down', categories: ['trending', 'basic'], ease: 'bounce', shape: (k) => ({ dy: -0.7 * k }), outShape: (k) => ({ dy: 0.7 * k }) },
  {
    id: 'fly-in',
    labelIn: 'Fly In',
    labelOut: 'Fly Out',
    categories: ['trending', 'basic'],
    ease: 'expo',
    shape: (k) => ({ dx: -0.6 * k, dy: 0.5 * k, rotation: -30 * k, scale: 1 - 0.5 * k, alpha: 1 - k }),
  },
  { id: 'stretch', labelIn: 'Stretched In', labelOut: 'Stretched Out', categories: ['trending', 'basic'], ease: 'cubic', shape: (k) => ({ sx: 1 + 2 * k, sy: 1 - 0.5 * k, alpha: 1 - k }) },
  { id: 'stretch-slide', labelIn: 'Stretch Slide', labelOut: 'Stretch Slide', categories: ['basic'], ease: 'cubic', shape: (k) => ({ dy: 0.3 * k, sy: 1 + 1.5 * k, alpha: 1 - k }) },
  { id: 'blur', labelIn: 'Blur In', labelOut: 'Blur Out', categories: ['trending', 'basic'], ease: 'cubic', shape: (k) => ({ blur: 60 * k, alpha: 1 - 0.5 * k }) },
  {
    id: 'h-blur',
    labelIn: 'Horizontal Blur',
    labelOut: 'Horizontal Blur',
    categories: ['trending', 'basic'],
    ease: 'cubic',
    shape: (k) => ({ blur: 40 * k, sx: 1 + 0.6 * k, dx: 0.15 * k, alpha: 1 - 0.6 * k }),
  },
  // ---- light
  { id: 'flash', labelIn: 'Flash', labelOut: 'Flash', categories: ['light'], ease: 'quad', shape: (k) => ({ brightness: 1 + 3 * k, alpha: 1 - 0.3 * k }) },
  { id: 'glow', labelIn: 'Glow', labelOut: 'Glow', categories: ['trending', 'light'], ease: 'cubic', shape: (k) => ({ glow: k, brightness: 1 + 1.2 * k, blur: 10 * k, alpha: 1 - 0.5 * k }) },
  { id: 'dark', labelIn: 'Fade from Black', labelOut: 'Fade to Black', categories: ['light', 'basic'], ease: 'linear', shape: (k) => ({ brightness: 1 - k }) },
  { id: 'pulse', labelIn: 'Pulse', labelOut: 'Pulse', categories: ['light'], ease: 'linear', shape: (k) => ({ brightness: 1 + 2 * k * Math.abs(S(3 * PI * k)), scale: 1 + 0.15 * k }) },
  // ---- glitch (jumpy on purpose; envelope k → 0 at rest)
  {
    id: 'rgb-split',
    labelIn: 'RGB Split',
    labelOut: 'RGB Split',
    categories: ['trending', 'glitch'],
    ease: 'quad',
    jumpy: true,
    shape: (k) => ({ rgbSplit: 40 * k, dx: 0.02 * k * noise(Math.floor(k * 12), 1) }),
  },
  {
    id: 'slice',
    labelIn: 'Slice Offset',
    labelOut: 'Slice Offset',
    categories: ['glitch'],
    ease: 'quad',
    jumpy: true,
    shape: (k) => ({ slices: 120 * k, seed: k > 0 ? Math.floor(k * 12) + 1 : 0 }),
  },
  {
    id: 'jitter',
    labelIn: 'Jitter',
    labelOut: 'Jitter',
    categories: ['glitch', 'vibration'],
    ease: 'linear',
    jumpy: true,
    shape: (k) => {
      const s = Math.floor(k * 20);
      return { dx: 0.05 * k * noise(s, 1), dy: 0.03 * k * noise(s, 2), alpha: 1 - 0.4 * k };
    },
  },
  {
    id: 'glitch-intro',
    labelIn: 'Glitch Intro',
    labelOut: 'Glitch Outro',
    categories: ['trending', 'glitch'],
    ease: 'linear',
    jumpy: true,
    shape: (k) => {
      const s = Math.floor(k * 15);
      return { rgbSplit: 30 * k, slices: 80 * k, seed: k > 0 ? s + 1 : 0, hue: 90 * k * noise(s, 3), alpha: 1 - 0.5 * k * (noise(s, 4) > 0 ? 1 : 0) };
    },
  },
  // ---- mask reveals
  { id: 'wipe-right', labelIn: 'Wipe Right', labelOut: 'Wipe Right', categories: ['mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(0, 0, 1 - k, 1)]) },
  { id: 'wipe-left', labelIn: 'Wipe Left', labelOut: 'Wipe Left', categories: ['mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(k, 0, 1 - k, 1)]) },
  { id: 'wipe-down', labelIn: 'Wipe Down', labelOut: 'Wipe Down', categories: ['mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(0, 0, 1, 1 - k)]) },
  { id: 'wipe-up', labelIn: 'Wipe Up', labelOut: 'Wipe Up', categories: ['mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(0, k, 1, 1 - k)]) },
  {
    id: 'circle',
    labelIn: 'Circle Reveal',
    labelOut: 'Circle Close',
    categories: ['trending', 'mask'],
    ease: 'cubic',
    shape: (k) => masked(k, () => [{ kind: 'circle', cx: 0.5, cy: 0.5, r: 0.5 * (1 - k) }]),
  },
  {
    id: 'iris',
    labelIn: 'Iris',
    labelOut: 'Iris',
    categories: ['mask'],
    ease: 'cubic',
    shape: (k) =>
      masked(k, () => {
        const s = 1 - k;
        return [{ kind: 'poly', pts: [[0.5, 0.5 - s], [0.5 + s, 0.5], [0.5, 0.5 + s], [0.5 - s, 0.5]] }];
      }),
  },
  { id: 'mid-split', labelIn: 'Mid-split Reveal', labelOut: 'Mid-split Close', categories: ['trending', 'mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(k / 2, 0, 1 - k, 1)]) },
  { id: 'mid-split-h', labelIn: 'Horizontal Split', labelOut: 'Horizontal Close', categories: ['mask'], ease: 'cubic', shape: (k) => masked(k, () => [rect(0, k / 2, 1, 1 - k)]) },
  {
    id: 'blinds',
    labelIn: 'Blinds',
    labelOut: 'Blinds',
    categories: ['mask'],
    ease: 'quad',
    shape: (k) => masked(k, () => Array.from({ length: 6 }, (_, i) => rect(i / 6, 0, (1 - k) / 6, 1))),
  },
  {
    id: 'diagonal',
    labelIn: 'Diagonal Wipe',
    labelOut: 'Diagonal Wipe',
    categories: ['mask'],
    ease: 'cubic',
    shape: (k) =>
      masked(k, () => {
        const s = 2 * (1 - k);
        return [{ kind: 'poly', pts: [[0, 0], [s, 0], [0, s]] }];
      }),
  },
  // ---- 3D (2D transforms + skew)
  { id: 'flip-3d', labelIn: '3D Flip', labelOut: '3D Flip', categories: ['3d'], ease: 'cubic', shape: (k) => ({ sx: Math.cos((Math.min(1, k) * PI) / 2), skewY: 15 * k, alpha: 1 - 0.3 * k }) },
  { id: 'flip-v', labelIn: 'Flip Vertical', labelOut: 'Flip Vertical', categories: ['3d'], ease: 'cubic', shape: (k) => ({ sy: Math.cos((Math.min(1, k) * PI) / 2), skewX: 15 * k, alpha: 1 - 0.3 * k }) },
  {
    id: 'cube',
    labelIn: 'Cube Turn',
    labelOut: 'Cube Turn',
    categories: ['3d'],
    ease: 'cubic',
    shape: (k) => ({ sx: 1 - 0.9 * k, pivotX: -0.5, skewY: -20 * k, dx: 0.3 * k, alpha: 1 - k }),
  },
  { id: 'door', labelIn: 'Door Open', labelOut: 'Door Close', categories: ['3d'], ease: 'cubic', shape: (k) => ({ sx: Math.cos((Math.min(1, k) * PI) / 2), pivotX: -0.5, skewY: -25 * k, alpha: 1 - 0.5 * k }) },
  { id: 'tilt', labelIn: 'Tilt Forward', labelOut: 'Tilt Back', categories: ['3d'], ease: 'cubic', shape: (k) => ({ sy: 1 - 0.6 * k, skewX: 25 * k, pivotY: 0.5, alpha: 1 - k }) },
  { id: 'spin-3d', labelIn: '3D Spin', labelOut: '3D Spin', categories: ['trending', '3d'], ease: 'cubic', shape: (k) => ({ sx: Math.cos(2 * PI * k), scale: 1 - 0.5 * k, alpha: 1 - k }) },
  // ---- text only
  { id: 'typewriter', labelIn: 'Typewriter', labelOut: 'Typewriter', categories: ['trending', 'basic'], target: 'text', ease: 'linear', shape: (k) => ({ reveal: 1 - k }) },
  { id: 'type-drop', labelIn: 'Write Down', labelOut: 'Erase Up', categories: ['basic'], target: 'text', ease: 'linear', shape: (k) => ({ reveal: 1 - k, dy: -0.03 * k }) },
];

function pairToDefs(d: PairDef): AnimDef[] {
  const E = EASE[d.ease];
  const target = d.target ?? 'any';
  const out: AnimDef[] = [];
  if (d.only !== 'out')
    out.push({ id: d.id, label: d.labelIn, phase: 'in', categories: d.categories, target, jumpy: d.jumpy, frame: (p) => frameOf(d.shape(1 - E(p))) });
  if (d.only !== 'in') {
    const shapeOut: Shape = d.outShape ?? ((k) => mirrorFrame(d.shape(k)));
    out.push({ id: d.id, label: d.labelOut, phase: 'out', categories: d.categories, target, jumpy: d.jumpy, frame: (p) => frameOf(shapeOut(1 - E(1 - p))) });
  }
  return out;
}

// ---------------------------------------------------------------- Combo (video / image)

interface CycleDef {
  id: string;
  label: string;
  categories: AnimCategory[];
  target?: AnimTarget;
  jumpy?: boolean;
  /** p → frame, at rest at p = 0 and p = 1. */
  f: (p: number) => Partial<AnimFrame>;
}

const env = (p: number) => S(PI * c01(p)); // 0 → 1 → 0

const COMBOS: CycleDef[] = [
  { id: 'zoom-in-out', label: 'Zoom In & Out', categories: ['trending', 'basic'], f: (p) => ({ scale: 1 + 0.3 * env(p) }) },
  { id: 'zoom-out-in', label: 'Zoom Out & In', categories: ['basic'], f: (p) => ({ scale: 1 - 0.3 * env(p) }) },
  { id: 'swing-lr', label: 'Swing Left & Right', categories: ['trending', 'vibration'], f: (p) => ({ rotation: 15 * S(4 * PI * c01(p)) }) },
  { id: 'rotate-back', label: 'Rotate & Back', categories: ['basic'], f: (p) => ({ rotation: 45 * env(p), scale: 1 - 0.2 * env(p) }) },
  { id: 'spin-360', label: 'Spin 360', categories: ['trending', 'basic'], f: (p) => ({ rotation: 360 * easeInOut(p) }) },
  { id: 'shake-shake', label: 'Shake Shake', categories: ['trending', 'vibration'], f: (p) => ({ dx: 0.04 * S(12 * PI * c01(p)) * env(p) }) },
  { id: 'bounce-up', label: 'Bounce Up', categories: ['vibration'], f: (p) => ({ dy: -0.12 * Math.abs(S(3 * PI * c01(p))) }) },
  { id: 'jelly-wobble', label: 'Jelly Wobble', categories: ['vibration'], f: (p) => ({ sx: 1 + 0.2 * S(6 * PI * c01(p)) * env(p), sy: 1 - 0.2 * S(6 * PI * c01(p)) * env(p) }) },
  { id: 'flip-around', label: 'Flip Around', categories: ['3d'], f: (p) => ({ sx: Math.cos(2 * PI * easeInOut(p)) }) },
  { id: 'pendulum', label: 'Pendulum', categories: ['vibration'], f: (p) => ({ rotation: 25 * S(2 * PI * c01(p)) * (1 - c01(p)) }) },
  { id: 'heartbeat', label: 'Heartbeat', categories: ['trending', 'light'], f: (p) => ({ scale: 1 + 0.12 * S(4 * PI * c01(p)) ** 2 }) },
  { id: 'float', label: 'Float', categories: ['basic'], f: (p) => ({ dy: -0.05 * S(2 * PI * c01(p)) }) },
  { id: 'tilt-3d', label: '3D Tilt', categories: ['3d'], f: (p) => ({ skewY: 15 * S(2 * PI * c01(p)), sx: 1 - 0.15 * env(p) }) },
  { id: 'slide-lr', label: 'Slide Left & Right', categories: ['basic'], f: (p) => ({ dx: 0.15 * S(2 * PI * c01(p)) }) },
  { id: 'squeeze', label: 'Squeeze', categories: ['vibration'], f: (p) => ({ sx: 1 - 0.3 * env(p), sy: 1 + 0.3 * env(p) }) },
  { id: 'flash-pulse', label: 'Flash Pulse', categories: ['light'], f: (p) => ({ brightness: 1 + 1.5 * env(p) }) },
  { id: 'blur-pulse', label: 'Blur Pulse', categories: ['basic'], f: (p) => ({ blur: 30 * env(p) }) },
  {
    id: 'glitch-pulse',
    label: 'Glitch Pulse',
    categories: ['glitch'],
    jumpy: true,
    f: (p) => {
      const s = Math.floor(c01(p) * 16);
      const e = env(p);
      return { rgbSplit: 25 * e * (noise(s, 5) > -0.3 ? 1 : 0), slices: 60 * e * (noise(s, 6) > 0.2 ? 1 : 0), seed: s + 1 };
    },
  },
];

// ---------------------------------------------------------------- Loop (text)

const LOOPS: CycleDef[] = [
  { id: 'pulse', label: 'Pulse', categories: ['trending', 'basic'], f: (q) => ({ scale: 1 + 0.12 * S(PI * c01(q)) ** 2 }) },
  { id: 'heartbeat', label: 'Heartbeat', categories: ['trending', 'light'], f: (q) => ({ scale: 1 + 0.15 * S(2 * PI * c01(q)) ** 6 }) },
  { id: 'swing', label: 'Swing', categories: ['vibration'], f: (q) => ({ rotation: 12 * S(2 * PI * c01(q)) }) },
  { id: 'shake', label: 'Shake', categories: ['vibration'], f: (q) => ({ dx: 0.02 * S(8 * PI * c01(q)) }) },
  { id: 'hop', label: 'Bounce', categories: ['trending', 'basic'], f: (q) => ({ dy: -0.06 * Math.abs(S(PI * c01(q))) }) },
  { id: 'float', label: 'Float', categories: ['basic'], f: (q) => ({ dy: -0.03 * S(2 * PI * c01(q)) }) },
  { id: 'wiggle', label: 'Wiggle', categories: ['vibration'], f: (q) => ({ rotation: 6 * S(4 * PI * c01(q)), dx: 0.01 * S(2 * PI * c01(q)) }) },
  { id: 'jelly', label: 'Jelly', categories: ['vibration'], f: (q) => ({ sx: 1 + 0.12 * S(2 * PI * c01(q)), sy: 1 - 0.12 * S(2 * PI * c01(q)) }) },
  { id: 'spin', label: 'Spin', categories: ['basic'], f: (q) => ({ rotation: 360 * c01(q) }) },
  { id: 'flip', label: 'Flip', categories: ['3d'], f: (q) => ({ sx: Math.cos(2 * PI * c01(q)) }) },
  { id: 'blink', label: 'Blink', categories: ['light'], f: (q) => ({ alpha: 0.5 + 0.5 * Math.cos(2 * PI * c01(q)) }) },
  {
    id: 'flicker',
    label: 'Flicker',
    categories: ['light'],
    jumpy: true,
    f: (q) => {
      const i = Math.floor(c01(q) * 8);
      return { alpha: i === 0 || i >= 8 ? 1 : noise(i, 7) > 0.2 ? 0.3 : 1 };
    },
  },
  { id: 'glow-pulse', label: 'Glow Pulse', categories: ['trending', 'light'], f: (q) => ({ glow: 0.8 * S(PI * c01(q)) ** 2, brightness: 1 + 0.4 * S(PI * c01(q)) ** 2 }) },
  { id: 'rainbow', label: 'Rainbow', categories: ['light'], f: (q) => ({ hue: 360 * c01(q) }) },
  {
    id: 'glitch',
    label: 'Glitch',
    categories: ['glitch'],
    jumpy: true,
    f: (q) => {
      const i = Math.floor(c01(q) * 10);
      const on = i > 0 && i < 10 && noise(i, 8) > 0.1 ? 1 : 0;
      return { rgbSplit: 18 * on, dx: 0.01 * on * noise(i, 9), seed: i };
    },
  },
];

const cycleToDef = (phase: 'combo' | 'loop', d: CycleDef): AnimDef => ({
  id: d.id,
  label: d.label,
  phase,
  categories: d.categories,
  target: phase === 'loop' ? 'text' : (d.target ?? 'any'),
  jumpy: d.jumpy,
  frame: (p) => frameOf(d.f(p)),
});

/** Every animation, in display order per phase. */
export const ANIMATION_CATALOG: readonly AnimDef[] = [
  ...PAIRS.flatMap(pairToDefs).sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'in' ? -1 : 1)),
  ...COMBOS.map((d) => cycleToDef('combo', d)),
  ...LOOPS.map((d) => cycleToDef('loop', d)),
];

const BY_KEY = new Map(ANIMATION_CATALOG.map((d) => [`${d.phase}:${d.id}`, d]));

export function findAnimation(phase: AnimPhase, id: string): AnimDef | undefined {
  return BY_KEY.get(`${phase}:${id}`);
}

/** Which phases a clip type offers (CapCut: video/image In · Out · Combo; text In · Out · Loop). */
export function phasesFor(clipType: 'video' | 'image' | 'text'): AnimPhase[] {
  return clipType === 'text' ? ['in', 'out', 'loop'] : ['in', 'out', 'combo'];
}

/** The animations offered for a phase and clip type. */
export function animationsFor(phase: AnimPhase, clipType: 'video' | 'image' | 'text'): AnimDef[] {
  return ANIMATION_CATALOG.filter((d) => d.phase === phase && (d.target === 'any' || clipType === 'text'));
}

/** Frame of an animation at linear progress p (unknown id → rest). Non-finite values are rejected. */
export function animationFrame(phase: AnimPhase, id: string, p: number): AnimFrame {
  const def = findAnimation(phase, id);
  if (!def) return { ...IDENTITY_FRAME };
  return def.frame(Number.isFinite(p) ? c01(p) : 0);
}

/** Combines simultaneous frames (In/Out + Loop): offsets add, multipliers multiply, masks intersect. */
export function composeFrames(frames: AnimFrame[]): { frame: AnimFrame; masks: MaskShape[][] } {
  const r: AnimFrame = { ...IDENTITY_FRAME };
  const masks: MaskShape[][] = [];
  for (const f of frames) {
    r.dx += f.dx;
    r.dy += f.dy;
    r.scale *= f.scale;
    r.sx *= f.sx;
    r.sy *= f.sy;
    r.skewX += f.skewX;
    r.skewY += f.skewY;
    if (f.pivotX || f.pivotY) {
      r.pivotX = f.pivotX;
      r.pivotY = f.pivotY;
    }
    r.rotation += f.rotation;
    r.alpha *= f.alpha;
    r.blur += f.blur;
    r.brightness *= f.brightness;
    r.hue += f.hue;
    r.glow = Math.max(r.glow, f.glow);
    r.rgbSplit += f.rgbSplit;
    r.slices += f.slices;
    r.seed += f.seed;
    r.reveal = Math.min(r.reveal, f.reveal);
    if (f.mask) masks.push(f.mask);
  }
  return { frame: r, masks };
}

/** Default durations (CapCut): In/Out 0.5 s; Combo = the whole clip; text Loop = 1 s per cycle. */
export const ANIM_LIMITS = {
  minUs: 100_000,
  defaultInOutUs: 500_000,
  defaultLoopUs: 1_000_000,
  loopMinUs: 100_000,
  loopMaxUs: 5_000_000,
} as const;
