/**
 * CapCut desktop draft (draft_info.json) → Our Editor project. Pure: no DOM, no store, no I/O.
 *
 *   convertCapcutDraft(draft, resolvePath) → { project, assets, report }
 *
 * - `resolvePath(raw)` turns a path as written in the draft (absolute, or with CapCut's
 *   `##_draftpath_placeholder_<uuid>_##` prefix for files inside the draft folder) into an absolute
 *   path on disk, or null when the file cannot be found.
 * - `assets` lists every media file the project needs (one entry per file, deduplicated by path),
 *   keyed by the asset id the project's clips already use. The caller loads the files, probes them
 *   and swaps in the real MediaAsset (src/import/capcut/runImport.ts).
 * - `report` says, item by item, what came over exactly, what was approximated and what was
 *   dropped. Nothing is dropped silently.
 *
 * Mapping notes (CapCut → ours):
 * - Times are µs on both sides. A segment's `target_timerange` is the clip's start / duration,
 *   `source_timerange.start` its in-point. Standard speed is stored as source/target so the source
 *   span read is exactly CapCut's.
 * - `clip.transform` is normalised to half the canvas with +y up; ours is project px with +y down.
 * - Curve speed: CapCut's points are taken over the clip's SOURCE progress (that reading
 *   reproduces the draft's own `speed` field = source/target); they are re-expressed over output
 *   time and scaled so the mean speed gives CapCut's exact source span. Our curve interpolates
 *   smoothly between points, so the shape in between is approximate (reported).
 * - A CapCut compound clip (a `drafts` material embedding a whole nested draft) becomes one of our
 *   compound clips + a Sequence built from that nested draft.
 */
import { ANIMATION_CATALOG, type AnimPhase } from '../../engine/animations';
import { BLEND_MODES, LIMITS, TRANSITIONS } from '../../model/catalog';
import { tracksEnd } from '../../model/compound';
import {
  createAsset,
  createProject,
  createTrack,
  defaultAdjust,
  defaultAudio,
  defaultCanvasBackground,
  defaultChroma,
  defaultCrop,
  defaultGrade,
  defaultMask,
  defaultTextStyle,
  defaultTransform,
  newId,
} from '../../model/defaults';
import { gainToDb } from '../../model/project';
import { curveMean, CURVE_PRESETS, type CurvePresetId, type SpeedCurve, type SpeedCurvePoint } from '../../model/speedCurve';
import type {
  Adjust,
  AspectRatio,
  AudioClip,
  AudioProps,
  BlendMode,
  CanvasBackground,
  Clip,
  ClipAnimation,
  ClipMask,
  CompoundClip,
  FilterId,
  Fps,
  Id,
  ImageClip,
  MaskShape,
  MediaAsset,
  MediaKind,
  Project,
  Sequence,
  TextClip,
  Track,
  TrackKind,
  Transform,
  Transition,
  TransitionType,
  Us,
  VideoClip,
  VisualFields,
} from '../../model/types';
import type {
  CcAnimation,
  CcCanvas,
  CcDraft,
  CcEffect,
  CcMask,
  CcMaterials,
  CcSegment,
  CcSpeed,
  CcText,

  CcVideoMaterial,
} from './types';

// ---------------------------------------------------------------- public types

export type ReportLevel = 'exact' | 'approx' | 'dropped' | 'note';

export interface ReportItem {
  level: ReportLevel;
  /** Where in the CapCut draft, e.g. "Main #7 @ 8.30 s" or "Project". */
  where: string;
  what: string;
}

export interface CapcutImportReport {
  draftName: string;
  counts: {
    tracks: number;
    videoClips: number;
    imageClips: number;
    compoundClips: number;
    audioClips: number;
    textClips: number;
    /** Clips inside compound clips (not on the main timeline). */
    nestedClips: number;
    markers: number;
    transitions: number;
    files: number;
    missingFiles: number;
  };
  items: ReportItem[];
}

export interface CapcutAssetRef {
  /** Asset id used by the project's clips. */
  id: Id;
  /** Absolute path on disk ('' when it could not be resolved). */
  path: string;
  /** The path as written in the draft. */
  rawPath: string;
  kind: MediaKind;
  /** Display / file name for the asset (blank CapCut names get a readable one). */
  name: string;
  missing: boolean;
}

export interface ConvertResult {
  project: Project;
  assets: CapcutAssetRef[];
  report: CapcutImportReport;
}

export interface ConvertOptions {
  /** Project name (default: the draft's name, else "CapCut import"). */
  name?: string;
}

// ---------------------------------------------------------------- helpers

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'm4v'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic'];

const extOf = (p: string): string => {
  const base = p.split('/').pop() ?? '';
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
};

export function kindOfPath(p: string, fallback: MediaKind): MediaKind {
  const ext = extOf(p);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return fallback;
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
};
export const mimeOfPath = (p: string): string => MIME[extOf(p)] ?? 'application/octet-stream';

const GENERIC_DIRS = new Set(['after-ai', '_work', 'pending', 'rejected', 'edit', 'refs', 'resources', 'downloads']);

/**
 * File name shown for a media file. A blank stem ("  .mp4") gets the nearest meaningful folder
 * name: ".../sh0-walk/after-ai/  .mp4" → "sh0-walk-untitled.mp4".
 */
export function displayNameOf(p: string): string {
  const parts = p.split('/');
  const base = parts.pop() ?? '';
  const ext = extOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  if (stem.trim()) return base;
  const dir = [...parts].reverse().find((d) => d.trim() && !GENERIC_DIRS.has(d.toLowerCase())) ?? 'media';
  return `${dir}-untitled${ext ? `.${ext}` : ''}`;
}

const sec = (us: number) => `${(us / 1e6).toFixed(2)} s`;
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A CSS hex colour from CapCut's "#RRGGBB" / "#AARRGGBB" / [r,g,b] (0..1). */
function hexColor(c: unknown, fallback: string): string {
  if (typeof c === 'string') {
    const m = c.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!m) return fallback;
    const h = m[1]!;
    return `#${(h.length === 8 ? h.slice(2) : h).toLowerCase()}`;
  }
  if (Array.isArray(c) && c.length >= 3 && c.every((x) => typeof x === 'number')) {
    return `#${c
      .slice(0, 3)
      .map((x) => Math.round(clamp(x as number, 0, 1) * 255).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return fallback;
}

/** Map of every material id → [collection name, material] for one draft. */
function indexMaterials(m: CcMaterials | undefined): Map<string, { kind: string; mat: Record<string, unknown> }> {
  const out = new Map<string, { kind: string; mat: Record<string, unknown> }>();
  if (!m) return out;
  for (const [kind, list] of Object.entries(m)) {
    if (!Array.isArray(list)) continue;
    for (const x of list) if (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') out.set((x as { id: string }).id, { kind, mat: x as Record<string, unknown> });
  }
  return out;
}

// ---------------------------------------------------------------- speed curve

/**
 * CapCut curve points (x = source progress 0..1, y = speed) → our curve over output time,
 * scaled so the mean speed is exactly `targetMean` (= source span / timeline duration).
 */
export function convertCurve(ccPoints: readonly { x: number; y: number }[], targetMean: number, name?: string): { curve: SpeedCurve; maxError: number } {
  const pts = ccPoints
    .filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y))
    .map((q) => ({ x: clamp(q.x, 0, 1), y: clamp(q.y, 0.1, 10) }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) pts.splice(0, pts.length, { x: 0, y: targetMean }, { x: 1, y: targetMean });
  pts[0]!.x = 0;
  pts[pts.length - 1]!.x = 1;
  // output time spent on each source piece: ∫ du / v(u), v linear in u
  const cum = [0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const h = b.x - a.x;
    const piece = h <= 0 ? 0 : Math.abs(b.y - a.y) < 1e-9 ? h / a.y : (h * (Math.log(b.y) - Math.log(a.y))) / (b.y - a.y);
    cum.push(cum[i]! + piece);
  }
  const total = cum[cum.length - 1]! || 1;
  let points: SpeedCurvePoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    let x = cum[i]! / total;
    const prev = points[points.length - 1];
    if (prev && x <= prev.x) x = prev.x + 1e-6;
    points.push({ x: Math.min(1, x), v: pts[i]!.y });
  }
  points[0]!.x = 0;
  points[points.length - 1]!.x = 1;
  // keep x strictly increasing after the clamp to 1
  points = points.filter((q, i) => i === 0 || i === points.length - 1 || q.x < 1);
  const preset: CurvePresetId = CURVE_PRESETS.find((p) => norm(p.label) === norm(name))?.id ?? 'custom';
  let curve: SpeedCurve = { preset, points };
  // scale the speeds so the mean matches exactly (a few passes in case some hit the 0.1 / 10 limits)
  for (let pass = 0; pass < 6; pass++) {
    const m = curveMean(curve);
    const k = targetMean / m;
    if (Math.abs(k - 1) < 1e-9) break;
    curve = { preset, points: curve.points.map((q) => ({ x: q.x, v: clamp(q.v * k, 0.1, 10) })) };
  }
  return { curve, maxError: Math.abs(curveMean(curve) - targetMean) / targetMean };
}

// ---------------------------------------------------------------- name matching

const ANIM_KEYWORDS: [RegExp, Record<AnimPhase, string>][] = [
  [/fade|dissolve|opacity/, { in: 'fade', out: 'fade', combo: 'zoom-in-out', loop: 'blink' }],
  [/zoom|scale|pull|push|grow|shrink/, { in: 'zoom-in', out: 'zoom-out', combo: 'zoom-in-out', loop: 'pulse' }],
  [/left/, { in: 'slide-left', out: 'slide-left', combo: 'slide-lr', loop: 'shake' }],
  [/right/, { in: 'slide-right', out: 'slide-right', combo: 'slide-lr', loop: 'shake' }],
  [/up|rise/, { in: 'slide-up', out: 'slide-up', combo: 'bounce-up', loop: 'hop' }],
  [/down|drop|fall/, { in: 'drop-down', out: 'drop-down', combo: 'bounce-up', loop: 'hop' }],
  [/rotat|spin|turn/, { in: 'rotate', out: 'rotate', combo: 'spin-360', loop: 'spin' }],
  [/shake|vibrat|wobble|jitter/, { in: 'shake', out: 'shake', combo: 'shake-shake', loop: 'shake' }],
  [/swing|pendul|sway/, { in: 'swing', out: 'swing', combo: 'swing-lr', loop: 'swing' }],
  [/bounce|jump|hop/, { in: 'bounce', out: 'bounce', combo: 'bounce-up', loop: 'hop' }],
  [/blur/, { in: 'blur', out: 'blur', combo: 'blur-pulse', loop: 'blink' }],
  [/flash|light|glow|bright/, { in: 'flash', out: 'flash', combo: 'flash-pulse', loop: 'glow-pulse' }],
  [/glitch|rgb|distort/, { in: 'rgb-split', out: 'rgb-split', combo: 'glitch-pulse', loop: 'glitch' }],
  [/flip|3d|cube|door/, { in: 'flip', out: 'flip', combo: 'flip-around', loop: 'flip' }],
  [/wipe|mask|reveal|split/, { in: 'wipe-right', out: 'wipe-right', combo: 'zoom-in-out', loop: 'blink' }],
  [/jelly|squeeze|stretch/, { in: 'stretch', out: 'stretch', combo: 'jelly-wobble', loop: 'jelly' }],
];

/** CapCut animation name → our catalogue id for that phase. exact = the labels match. */
export function matchAnimation(phase: AnimPhase, name: string): { id: string; exact: boolean } {
  const n = norm(name);
  const defs = ANIMATION_CATALOG.filter((d) => d.phase === phase);
  const byLabel = defs.find((d) => norm(d.label) === n) ?? defs.find((d) => norm(d.id) === n);
  if (byLabel) return { id: byLabel.id, exact: true };
  const lower = name.toLowerCase();
  for (const [re, ids] of ANIM_KEYWORDS) if (re.test(lower) && defs.some((d) => d.id === ids[phase])) return { id: ids[phase], exact: false };
  return { id: phase === 'combo' ? 'zoom-in-out' : phase === 'loop' ? 'pulse' : 'fade', exact: false };
}

export function matchTransition(name: string): { type: TransitionType; exact: boolean } {
  const n = norm(name);
  const hit = TRANSITIONS.find((t) => norm(t.label) === n || norm(t.id) === n);
  if (hit) return { type: hit.id, exact: true };
  const l = name.toLowerCase();
  const kw: [RegExp, TransitionType][] = [
    [/black/, 'fade-black'],
    [/white|flash/, 'fade-white'],
    [/wipe.*left|left.*wipe/, 'wipe-left'],
    [/wipe/, 'wipe-right'],
    [/slide.*left|left/, 'slide-left'],
    [/slide.*right|right/, 'slide-right'],
    [/up/, 'slide-up'],
    [/down/, 'slide-down'],
    [/zoom|pull|push/, 'zoom'],
    [/blur/, 'blur'],
    [/mix|dissolve|fade|cross/, 'mix'],
  ];
  for (const [re, t] of kw) if (re.test(l)) return { type: t, exact: false };
  return { type: 'mix', exact: false };
}

function matchFilter(name: string): FilterId | null {
  const l = name.toLowerCase();
  const kw: [RegExp, FilterId][] = [
    [/noir/, 'noir'],
    [/b&w|bw|mono|black|grey|gray/, 'mono'],
    [/sepia/, 'sepia'],
    [/vintage|old/, 'vintage'],
    [/retro/, 'retro'],
    [/warm|sun|gold/, 'warm'],
    [/cool|cold|blue/, 'cool'],
    [/vivid|vibrant|bright/, 'vivid'],
    [/matte|fade/, 'fade'],
    [/cine|film|movie/, 'cinematic'],
  ];
  for (const [re, id] of kw) if (re.test(l)) return id;
  return null;
}

function matchBlend(name: string): BlendMode | null {
  const n = norm(name);
  return BLEND_MODES.find((b) => norm(b.label) === n || norm(b.id) === n)?.id ?? null;
}

const MASK_MAP: Record<string, MaskShape> = {
  line: 'linear',
  linear: 'linear',
  mirror: 'mirror',
  circle: 'circle',
  ellipse: 'circle',
  rectangle: 'rectangle',
  heart: 'heart',
  love: 'heart',
  star: 'star',
  geometric_shape: 'heart',
};

/** CapCut adjust effect type → our Adjust key and scale (CapCut value → our slider units). */
const ADJUST_MAP: Record<string, [keyof Adjust, number]> = {
  brightness: ['brightness', 50],
  contrast: ['contrast', 50],
  saturation: ['saturation', 50],
  temperature: ['temperature', 50],
  tone: ['tint', 50],
  tint: ['tint', 50],
  highlight: ['highlights', 50],
  shadow: ['shadows', 50],
  light_sensation: ['exposure', 50],
  exposure: ['exposure', 50],
  sharpen: ['sharpen', 100],
  fade: ['fade', 100],
  vignetting: ['vignette', 100],
  particle: ['grain', 100],
  clarity: ['clarity', 100],
  whites: ['whites', 50],
  blacks: ['blacks', 50],
};

// ---------------------------------------------------------------- converter

interface Ctx {
  W: number;
  H: number;
  fps: number;
  frameUs: number;
  resolvePath: (raw: string) => string | null;
  assets: Map<string, CapcutAssetRef>;
  projectAssets: Record<Id, MediaAsset>;
  sequences: Record<Id, Sequence>;
  items: ReportItem[];
  counts: CapcutImportReport['counts'];
  markers: { time: Us; color: string; label?: string }[];
  depth: number;
}

const visualDefaults = (): VisualFields => ({
  transform: defaultTransform(),
  crop: defaultCrop(),
  blend: 'normal',
  blendEnabled: true,
  animationIn: null,
  animationOut: null,
  animationCombo: null,
  animationLoop: null,
  filter: null,
  adjust: defaultAdjust(),
  adjustEnabled: true,
  grade: defaultGrade(),
});

function assetFor(ctx: Ctx, rawPath: string, fallbackKind: MediaKind, info: { duration?: number; width?: number; height?: number; hasAudio?: boolean }): CapcutAssetRef {
  const abs = rawPath ? ctx.resolvePath(rawPath) : null;
  const key = abs ?? `raw:${rawPath}`;
  const known = ctx.assets.get(key);
  const kind = kindOfPath(abs ?? rawPath, fallbackKind);
  if (known) {
    const a = ctx.projectAssets[known.id]!;
    if (kind !== 'image') a.duration = Math.max(a.duration, Math.round(num(info.duration)));
    if (info.hasAudio) a.hasAudio = true;
    return known;
  }
  const name = displayNameOf(abs ?? rawPath);
  const ref: CapcutAssetRef = { id: newId('ast'), path: abs ?? '', rawPath, kind, name, missing: !abs };
  ctx.assets.set(key, ref);
  const asset = createAsset({
    id: ref.id,
    kind,
    name,
    mime: mimeOfPath(abs ?? rawPath),
    size: 0,
    duration: kind === 'image' ? 0 : Math.round(num(info.duration)),
    width: info.width,
    height: info.height,
    hasAudio: kind === 'image' ? false : kind === 'audio' ? true : (info.hasAudio ?? true),
  });
  if (!abs) asset.missing = true;
  ctx.projectAssets[ref.id] = asset;
  const base = (abs ?? rawPath).split('/').pop() ?? '';
  if (name !== base) ctx.items.push({ level: 'note', where: 'Media', what: `"${base}" has a blank file name (${abs ?? rawPath}); it is listed as "${name}". The file itself is untouched.` });
  if (!abs) ctx.items.push({ level: 'dropped', where: 'Media', what: `File not found: ${rawPath || '(empty path)'} — its clips are kept as "Media lost".` });
  return ref;
}

/** Value of a CapCut keyframe property at the segment start (the first keyframe holds before it). */
function keyframeAtStart(seg: CcSegment, prop: string): number | null {
  const kf = (seg.common_keyframes ?? []).find((k) => k.property_type === prop);
  const list = [...(kf?.keyframe_list ?? [])].sort((a, b) => num(a.time_offset) - num(b.time_offset));
  const first = list[0];
  if (!first || !first.values || typeof first.values[0] !== 'number') return null;
  return first.values[0];
}

function convertTransform(ctx: Ctx, seg: CcSegment, where: string): Transform {
  const t = defaultTransform();
  const c = seg.clip ?? {};
  let sx = num(c.scale?.x, 1);
  let sy = num(c.scale?.y, 1);
  let tx = num(c.transform?.x);
  let ty = num(c.transform?.y);
  let rot = num(c.rotation);
  let alpha = num(c.alpha, 1);
  // keyframes: we have none, so the value at the segment start is used
  const kfs = (seg.common_keyframes ?? []).filter((k) => (k.keyframe_list ?? []).length > 0);
  if (kfs.length) {
    const v = (p: string) => keyframeAtStart(seg, p);
    tx = v('KFTypePositionX') ?? tx;
    ty = v('KFTypePositionY') ?? ty;
    sx = v('KFTypeScaleX') ?? v('KFTypeUniformScale') ?? sx;
    sy = v('KFTypeScaleY') ?? v('KFTypeUniformScale') ?? sy;
    rot = v('KFTypeRotation') ?? rot;
    alpha = v('KFTypeAlpha') ?? alpha;
    ctx.items.push({
      level: 'approx',
      where,
      what: `Keyframes (${kfs.map((k) => `${k.property_type} ×${k.keyframe_list!.length}`).join(', ')}) — no keyframes here; the value at the clip start is used.`,
    });
  }
  const uniform = seg.uniform_scale?.on !== false;
  const capS = (v: number) => clamp(v, LIMITS.scaleMin, LIMITS.scaleMax);
  if (uniform) {
    t.uniformScale = true;
    t.scale = capS(sx);
    t.scaleX = t.scale;
    t.scaleY = t.scale;
  } else {
    t.uniformScale = false;
    t.scale = capS((sx + sy) / 2);
    t.scaleX = capS(sx);
    t.scaleY = capS(sy);
  }
  if (Math.max(sx, sy) > LIMITS.scaleMax || Math.min(sx, sy) < LIMITS.scaleMin) ctx.items.push({ level: 'approx', where, what: `Scale ${round(sx * 100)} % × ${round(sy * 100)} % is outside 1–400 % and was clamped.` });
  t.x = round((tx * ctx.W) / 2, 2);
  t.y = round((-ty * ctx.H) / 2, 2);
  t.rotation = round(rot, 4);
  t.opacity = clamp(alpha, 0, 1);
  t.flipH = !!c.flip?.horizontal;
  t.flipV = !!c.flip?.vertical;
  return t;
}

interface SegMats {
  byKind: Map<string, Record<string, unknown>[]>;
}

function refsOf(seg: CcSegment, idx: ReturnType<typeof indexMaterials>): SegMats {
  const byKind = new Map<string, Record<string, unknown>[]>();
  for (const r of seg.extra_material_refs ?? []) {
    const hit = idx.get(r);
    if (!hit) continue;
    const list = byKind.get(hit.kind) ?? [];
    list.push(hit.mat);
    byKind.set(hit.kind, list);
  }
  return { byKind };
}
const first = <T>(m: SegMats, kind: string): T | undefined => m.byKind.get(kind)?.[0] as T | undefined;

/** Speed, in-point and curve of a timed clip; returns the fields to set. */
function convertSpeed(
  ctx: Ctx,
  seg: CcSegment,
  refs: SegMats,
  mediaDuration: number,
  where: string,
): { inPoint: Us; speed: number; speedCurve: SpeedCurve | null; preservePitch: boolean; reversed: boolean } {
  const D = Math.round(num(seg.target_timerange?.duration));
  const S = Math.round(num(seg.source_timerange?.duration, D));
  let inPoint = Math.max(0, Math.round(num(seg.source_timerange?.start)));
  const sp = first<CcSpeed>(refs, 'speeds');
  const nominal = num(sp?.speed, num(seg.speed, 1));
  let speed = 1;
  let speedCurve: SpeedCurve | null = null;
  const pts = sp?.mode === 1 ? sp.curve_speed?.speed_points : undefined;
  const flat = !pts || pts.every((q) => Math.abs(q.y - 1) < 1e-6);
  if (pts && !flat) {
    const { curve, maxError } = convertCurve(pts, S / D, sp?.curve_speed?.name);
    speedCurve = curve;
    ctx.items.push({
      level: 'approx',
      where,
      what: `Curve speed "${sp?.curve_speed?.name ?? 'Custom'}" (${pts.length} points, ${round(Math.min(...pts.map((q) => q.y)), 2)}×–${round(Math.max(...pts.map((q) => q.y)), 2)}×): source span ${sec(S)} → ${sec(D)} kept exactly${maxError > 1e-4 ? ` (±${round(maxError * 100, 2)} %)` : ''}; the shape between points follows our smooth curve.`,
    });
  } else {
    const ratio = S / D;
    speed = nominal === 1 && Math.abs(S - D) <= ctx.frameUs / 2 ? 1 : ratio;
    if (speed < LIMITS.speedMin || speed > LIMITS.speedMax) {
      ctx.items.push({ level: 'approx', where, what: `Speed ${round(speed, 3)}× is outside 0.1–100× and was clamped.` });
      speed = clamp(speed, LIMITS.speedMin, LIMITS.speedMax);
    }
    if (pts && flat && sp?.mode === 1) ctx.items.push({ level: 'note', where, what: 'Curve speed with every point at 1× → Standard 1×.' });
    if (speed !== 1) ctx.items.push({ level: 'exact', where, what: `Speed ${round(nominal, 4)}× (source ${sec(S)} → ${sec(D)}).` });
  }
  const span = speedCurve ? Math.round(D * curveMean(speedCurve)) : Math.round(D * speed);
  if (mediaDuration > 0 && inPoint + span > mediaDuration) {
    const over = inPoint + span - mediaDuration;
    inPoint = Math.max(0, mediaDuration - span);
    if (over > ctx.frameUs) ctx.items.push({ level: 'approx', where, what: `Read ${sec(over)} past the end of the media; in-point moved back to ${sec(inPoint)}.` });
  }
  const reversed = !!seg.reverse;
  if (reversed) ctx.items.push({ level: 'approx', where, what: 'Reverse: played backwards from the original file (CapCut renders a reversed copy); the in-point is taken as measured from the end.' });
  return { inPoint, speed, speedCurve, preservePitch: !seg.is_tone_modify, reversed };
}

function convertAudio(ctx: Ctx, seg: CcSegment, refs: SegMats, where: string, kind: 'video' | 'audio'): AudioProps {
  const a = defaultAudio();
  let vol = num(seg.volume, 1);
  const kfVol = keyframeAtStart(seg, 'KFTypeVolume');
  if (kfVol !== null) vol = kfVol;
  a.volumeDb = round(clamp(gainToDb(vol), LIMITS.volumeDbMin, LIMITS.volumeDbMax), 2);
  if (vol > 0 && gainToDb(vol) > LIMITS.volumeDbMax) ctx.items.push({ level: 'approx', where, what: `Volume ×${round(vol, 2)} is above +20 dB and was clamped.` });
  else if (Math.abs(vol - 1) > 1e-6) ctx.items.push({ level: 'exact', where, what: `Volume ×${round(vol, 3)} → ${a.volumeDb > 0 ? '+' : ''}${a.volumeDb} dB.` });
  const fade = first<{ fade_in_duration?: number; fade_out_duration?: number }>(refs, 'audio_fades');
  if (fade) {
    a.fadeIn = Math.max(0, Math.round(num(fade.fade_in_duration)));
    a.fadeOut = Math.max(0, Math.round(num(fade.fade_out_duration)));
    const D = Math.round(num(seg.target_timerange?.duration));
    if (a.fadeIn + a.fadeOut > D) {
      const k = D / (a.fadeIn + a.fadeOut);
      a.fadeIn = Math.floor(a.fadeIn * k);
      a.fadeOut = Math.floor(a.fadeOut * k);
      ctx.items.push({ level: 'approx', where, what: 'Audio fades longer than the clip were shortened to fit.' });
    }
    if (a.fadeIn || a.fadeOut) ctx.items.push({ level: 'exact', where, what: `Audio fade in ${sec(a.fadeIn)}, out ${sec(a.fadeOut)}.` });
  }
  const ch = first<{ audio_channel_mapping?: number }>(refs, 'sound_channel_mappings');
  const map = num(ch?.audio_channel_mapping);
  if (map === 1 || map === 2) {
    a.fillChannel = map === 1 ? 'left' : 'right';
    ctx.items.push({ level: 'approx', where, what: `Sound channel mapping ${map} → Fill channel "${a.fillChannel}" (CapCut's code read as ${map === 1 ? 'left' : 'right'} → both).` });
  } else if (map) ctx.items.push({ level: 'dropped', where, what: `Sound channel mapping ${map} has no equivalent.` });
  const vs = first<{ choice?: number; final_algorithm?: string }>(refs, 'vocal_separations');
  const choice = num(vs?.choice);
  if (choice === 1 || choice === 2) {
    a.voiceIsolation = { mode: choice === 1 ? 'isolate' : 'remove', strength: 100 };
    ctx.items.push({
      level: 'approx',
      where,
      what: `${choice === 1 ? 'Isolate voice' : 'Remove vocals'} (CapCut AI "${vs?.final_algorithm || 'vocal_separate'}") → our DSP voice isolation "${a.voiceIsolation.mode}" at 100 %, not AI: the result will sound different.`,
    });
  }
  const loud = first<{ enable?: boolean; target_loudness?: number }>(refs, 'loudnesses');
  if (loud?.enable) {
    a.normalize = true;
    ctx.items.push({ level: 'approx', where, what: `Normalize loudness (CapCut target ${num(loud.target_loudness)} LUFS) → ours, which targets −23 LUFS.` });
  }
  if (kind === 'video' && kfVol !== null) ctx.items.push({ level: 'approx', where, what: 'Volume keyframes: the value at the clip start is used.' });
  return a;
}

function convertAnimations(ctx: Ctx, refs: SegMats, D: Us, where: string, isText: boolean): Pick<VisualFields, 'animationIn' | 'animationOut' | 'animationCombo' | 'animationLoop'> {
  const out: Pick<VisualFields, 'animationIn' | 'animationOut' | 'animationCombo' | 'animationLoop'> = { animationIn: null, animationOut: null, animationCombo: null, animationLoop: null };
  for (const m of refs.byKind.get('material_animations') ?? []) {
    for (const an of ((m as { animations?: CcAnimation[] }).animations ?? [])) {
      const type = (an.type ?? '').toLowerCase();
      const phase: AnimPhase | null = type === 'in' ? 'in' : type === 'out' ? 'out' : type === 'group' || type === 'combo' ? (isText ? 'loop' : 'combo') : type === 'loop' ? 'loop' : null;
      if (!phase || (phase === 'loop' && !isText) || (phase === 'combo' && isText)) {
        ctx.items.push({ level: 'dropped', where, what: `Animation "${an.name ?? '?'}" (${an.type}) has no slot for this clip type.` });
        continue;
      }
      const { id, exact } = matchAnimation(phase, an.name ?? '');
      const dur = Math.max(1, Math.round(num(an.duration, phase === 'combo' ? D : 500_000)));
      const anim: ClipAnimation = { type: id, duration: phase === 'loop' ? clamp(dur, 100_000, 5_000_000) : Math.min(D, dur) };
      if (phase === 'in') out.animationIn = anim;
      else if (phase === 'out') out.animationOut = anim;
      else if (phase === 'combo') out.animationCombo = anim;
      else out.animationLoop = anim;
      ctx.items.push({ level: exact ? 'exact' : 'approx', where, what: `${phase === 'combo' ? 'Combo' : phase[0]!.toUpperCase() + phase.slice(1)} animation "${an.name}" ${sec(anim.duration)} → ${exact ? `"${id}"` : `closest match "${id}"`}.` });
    }
  }
  if (out.animationCombo) {
    out.animationIn = null;
    out.animationOut = null;
  }
  const ai = out.animationIn?.duration ?? 0;
  const ao = out.animationOut?.duration ?? 0;
  if (out.animationOut && ai + ao > D) out.animationOut.duration = Math.max(0, D - ai);
  return out;
}

function convertCanvas(ctx: Ctx, refs: SegMats, where: string): CanvasBackground {
  const bg = defaultCanvasBackground();
  const c = first<CcCanvas>(refs, 'canvases');
  if (!c) return bg;
  if (c.type === 'canvas_color') {
    if (c.color) {
      bg.type = 'color';
      bg.color = hexColor(c.color, '#000000');
    }
  } else if (c.type === 'canvas_blur') {
    bg.type = 'blur';
    const levels = [0.0625, 0.375, 0.75, 1];
    const b = num(c.blur, 0.375);
    bg.blur = levels.reduce((best, v, i) => (Math.abs(v - b) < Math.abs(levels[best - 1]! - b) ? i + 1 : best), 1);
    ctx.items.push({ level: 'approx', where, what: `Canvas blur ${b} → blur level ${bg.blur}/4.` });
  } else if (c.type === 'canvas_image' && c.image) {
    const ref = assetFor(ctx, c.image, 'image', {});
    bg.type = 'image';
    bg.assetId = ref.id;
  } else if (c.type) ctx.items.push({ level: 'dropped', where, what: `Canvas "${c.type}" is not supported.` });
  return bg;
}

function convertMask(ctx: Ctx, refs: SegMats, where: string): ClipMask {
  const m = defaultMask();
  const src = first<CcMask>(refs, 'masks') ?? first<CcMask>(refs, 'common_mask');
  if (!src) return m;
  const shape = MASK_MAP[(src.resource_type ?? '').toLowerCase()] ?? MASK_MAP[norm(src.name)];
  if (!shape) {
    ctx.items.push({ level: 'dropped', where, what: `Mask "${src.name ?? src.resource_type}" has no equivalent.` });
    return m;
  }
  const cf = src.config ?? {};
  m.shape = shape;
  m.x = round(num(cf.centerX) / 2, 4);
  m.y = round(-num(cf.centerY) / 2, 4);
  m.width = clamp(num(cf.width, 0.5), 0.01, 4);
  m.height = clamp(num(cf.height, 0.5), 0.01, 4);
  m.rotation = num(cf.rotation);
  m.feather = clamp(num(cf.feather) * 100, 0, 100);
  m.roundCorners = clamp(num(cf.roundCorner) * 100, 0, 100);
  m.invert = !!cf.invert;
  ctx.items.push({ level: 'approx', where, what: `Mask "${src.name ?? src.resource_type}" → ${shape}; position / size / feather converted from CapCut's units (approximate).` });
  return m;
}

/** Filters, adjust sliders, blend mode; effects / HSL / LUT / curves / wheels are listed as dropped. */
function convertLook(ctx: Ctx, refs: SegMats, where: string, v: VisualFields): void {
  const effects = [...(refs.byKind.get('effects') ?? []), ...(refs.byKind.get('filters') ?? [])] as unknown as CcEffect[];
  for (const e of effects) {
    const type = (e.type ?? '').toLowerCase();
    if (type === 'filter') {
      const id = matchFilter(e.name ?? '');
      if (id) {
        v.filter = { id, intensity: clamp(num(e.value, 1), 0, 1) };
        ctx.items.push({ level: 'approx', where, what: `Filter "${e.name}" ${Math.round(num(e.value, 1) * 100)} % → our closest look "${id}".` });
      } else ctx.items.push({ level: 'dropped', where, what: `Filter "${e.name}" has no comparable look here.` });
    } else if (ADJUST_MAP[type]) {
      const [key, k] = ADJUST_MAP[type]!;
      v.adjust[key] = round(clamp(num(e.value) * k, k === 50 ? -50 : 0, k === 50 ? 50 : 100), 2);
      ctx.items.push({ level: 'approx', where, what: `Adjust ${type} ${round(num(e.value), 3)} → ${key} ${v.adjust[key]}.` });
    } else if (type === 'mix_mode' || type === 'blend') {
      const b = matchBlend(e.name ?? '');
      if (b) {
        v.blend = b;
        ctx.items.push({ level: 'exact', where, what: `Blend "${e.name}" → ${b}.` });
      } else ctx.items.push({ level: 'dropped', where, what: `Blend mode "${e.name}" has no equivalent.` });
    } else if (type === 'lut') {
      ctx.items.push({ level: 'dropped', where, what: `LUT "${e.name ?? e.path}" — import the .cube file in Adjust › LUT by hand.` });
    } else if (type) ctx.items.push({ level: 'dropped', where, what: `Effect "${e.name ?? type}" (${type}) is not supported.` });
  }
  for (const k of ['video_effects', 'hsl', 'color_curves', 'primary_color_wheels', 'log_color_wheels', 'chromas', 'beauty', 'stickers']) {
    for (const e of refs.byKind.get(k) ?? []) ctx.items.push({ level: 'dropped', where, what: `${k.replace(/_/g, ' ')} "${String((e as { name?: unknown }).name ?? '')}" is not imported.` });
  }
}

function textStyleOf(ctx: Ctx, t: CcText, where: string): TextClip['text'] {
  let content = t.base_content ?? '';
  let size = num(t.font_size, 15);
  let color = hexColor(t.text_color, '#ffffff');
  let strokeColor: string | null = t.border_color ? hexColor(t.border_color, '#000000') : null;
  let strokeWidth = num(t.border_width, 0.08);
  let bold = num(t.bold_width) > 0;
  let italic = num(t.italic_degree) > 0;
  let underline = !!t.underline;
  if (typeof t.content === 'string' && t.content.trim().startsWith('{')) {
    try {
      const j = JSON.parse(t.content) as {
        text?: string;
        styles?: { size?: number; bold?: boolean; italic?: boolean; underline?: boolean; fill?: { content?: { solid?: { color?: number[] } } }; strokes?: { content?: { solid?: { color?: number[] } }; width?: number }[] }[];
      };
      content = j.text ?? content;
      const s = j.styles?.[0];
      if (s) {
        size = num(s.size, size);
        color = hexColor(s.fill?.content?.solid?.color, color);
        bold = s.bold ?? bold;
        italic = s.italic ?? italic;
        underline = s.underline ?? underline;
        const st = s.strokes?.[0];
        if (st) {
          strokeColor = hexColor(st.content?.solid?.color, '#000000');
          strokeWidth = num(st.width, strokeWidth);
        }
      }
    } catch {
      /* not rich text */
    }
  } else if (typeof t.content === 'string') content = t.content || content;
  const style = defaultTextStyle(content || ' ');
  style.fontSize = Math.round(size * 5 * (ctx.H / 1920));
  style.color = color;
  style.bold = bold;
  style.italic = italic;
  style.underline = underline;
  style.align = t.alignment === 0 ? 'left' : t.alignment === 2 ? 'right' : 'center';
  if (typeof t.letter_spacing === 'number') style.letterSpacing = round(t.letter_spacing * style.fontSize, 2);
  if (typeof t.line_spacing === 'number') style.lineHeight = round(1.2 + t.line_spacing, 2);
  if (strokeColor) style.stroke = { enabled: true, color: strokeColor, width: Math.max(1, Math.round(strokeWidth * style.fontSize * 0.5)) };
  if (t.background_color && num(t.background_alpha, 1) > 0) style.background = { enabled: true, color: hexColor(t.background_color, '#000000'), opacity: clamp(num(t.background_alpha, 1), 0, 1) };
  if (t.font_path || t.font_title) ctx.items.push({ level: 'approx', where, what: `Font "${t.font_title || (t.font_path ?? '').split('/').pop()}" → system font; size ${size} → ${style.fontSize} px (approximate).` });
  else ctx.items.push({ level: 'approx', where, what: `Text size ${size} → ${style.fontSize} px (approximate).` });
  return style;
}

/** Converts one CapCut track list (the root draft or a nested compound draft) to ours. */
function convertTracks(ctx: Ctx, draft: CcDraft, scope: string): Track[] {
  const idx = indexMaterials(draft.materials);
  const ccTracks = draft.tracks ?? [];
  const visual: Track[] = [];
  const audio: Track[] = [];
  let main: Track | null = null;
  const n: Record<string, number> = {};
  const nested = ctx.depth > 0;
  const count = (k: keyof CapcutImportReport['counts']) => {
    if (nested) ctx.counts.nestedClips += 1;
    else ctx.counts[k] += 1;
  };

  for (const cc of ccTracks) {
    const type = cc.type;
    let kind: TrackKind | null = null;
    if (type === 'video') kind = main ? 'overlay' : 'main';
    else if (type === 'audio') kind = 'audio';
    else if (type === 'text') kind = 'text';
    n[type] = (n[type] ?? 0) + 1;
    const label = `${scope}${kind === 'main' ? 'Main' : kind === 'overlay' ? `Overlay ${n[type]! - 1}` : `${type[0]!.toUpperCase()}${type.slice(1)} ${n[type]}`}`;
    if (!kind) {
      if (cc.segments.length) ctx.items.push({ level: 'dropped', where: label, what: `A "${type}" track with ${cc.segments.length} segment(s) — ${type} tracks are not supported yet.` });
      continue;
    }
    const track = createTrack(kind);
    const attr = num(cc.attribute);
    track.muted = (attr & 1) !== 0;
    track.hidden = (attr & 2) !== 0;
    track.locked = (attr & 4) !== 0;
    if (cc.name) track.name = cc.name;
    if (attr) ctx.items.push({ level: 'exact', where: label, what: `Track ${[track.muted && 'muted', track.hidden && 'hidden', track.locked && 'locked'].filter(Boolean).join(', ')}.` });
    const transitions: { from: Clip; seg: CcSegment; mat: Record<string, unknown> }[] = [];
    cc.segments.forEach((seg, si) => {
      const start = Math.round(num(seg.target_timerange?.start));
      const D = Math.round(num(seg.target_timerange?.duration));
      const where = `${label} #${si} @ ${sec(start)}`;
      if (D <= 0) {
        ctx.items.push({ level: 'dropped', where, what: 'Zero-length segment.' });
        return;
      }
      const refs = refsOf(seg, idx);
      const hit = idx.get(seg.material_id);
      const disabled = seg.visible === false;
      let clip: Clip | null = null;
      if (kind === 'main' || kind === 'overlay') {
        const mat = hit?.mat as CcVideoMaterial | undefined;
        const draftMat = refs.byKind.get('drafts')?.[0] as { draft?: CcDraft; name?: string; type?: string } | undefined;
        if (!mat) {
          ctx.items.push({ level: 'dropped', where, what: `Material ${seg.material_id} is missing from the draft.` });
          return;
        }
        const visualBase = { ...visualDefaults(), transform: convertTransform(ctx, seg, where) };
        Object.assign(visualBase, convertAnimations(ctx, refs, D, where, false));
        convertLook(ctx, refs, where, visualBase);
        
        if (draftMat?.draft && !mat.path) {
          clip = convertCompound(ctx, seg, mat, draftMat, track.id, visualBase, where);
          if (!clip) return;
          count('compoundClips');
        } else {
          const ref = assetFor(ctx, mat.path ?? '', mat.type === 'photo' ? 'image' : 'video', { duration: mat.duration, width: mat.width, height: mat.height, hasAudio: mat.has_audio });
          const media = { mask: convertMask(ctx, refs, where), chroma: defaultChroma(), canvas: kind === 'main' ? convertCanvas(ctx, refs, where) : defaultCanvasBackground() };
          const crop = mat.crop
            ? {
                left: clamp(num(mat.crop.upper_left_x), 0, 1),
                top: clamp(num(mat.crop.upper_left_y), 0, 1),
                right: clamp(1 - num(mat.crop.lower_right_x, 1), 0, 1),
                bottom: clamp(1 - num(mat.crop.lower_right_y, 1), 0, 1),
              }
            : defaultCrop();
          if (crop.left || crop.top || crop.right || crop.bottom) ctx.items.push({ level: 'exact', where, what: `Crop L ${round(crop.left * 100, 1)} % T ${round(crop.top * 100, 1)} % R ${round(crop.right * 100, 1)} % B ${round(crop.bottom * 100, 1)} %.` });
          visualBase.crop = crop;
          if (ref.kind === 'image') {
            const img: ImageClip = { id: newId('clp'), type: 'image', trackId: track.id, name: mat.material_name || ref.name, start, duration: D, disabled, assetId: ref.id, ...visualBase, ...media };
            clip = img;
            count('imageClips');
          } else {
            const timing = convertSpeed(ctx, seg, refs, ctx.projectAssets[ref.id]!.duration, where);
            const audioProps = convertAudio(ctx, seg, refs, where, 'video');
            if (mat.has_sound_separated) {
              audioProps.muted = true;
              ctx.items.push({ level: 'exact', where, what: 'The clip\'s own sound was separated in CapCut → the video\'s audio is muted; the separated sound is on its audio track.' });
            }
            const v: VideoClip = { id: newId('clp'), type: 'video', trackId: track.id, name: mat.material_name || ref.name, start, duration: D, disabled, assetId: ref.id, ...timing, audio: audioProps, ...visualBase, ...media };
            clip = v;
            count('videoClips');
          }
        }
      } else if (kind === 'audio') {
        const mat = hit?.mat as { path?: string; name?: string; duration?: number; type?: string } | undefined;
        if (!mat || !mat.path) {
          ctx.items.push({ level: 'dropped', where, what: `Audio material ${mat?.name ?? seg.material_id} has no file path (${mat?.type ?? 'unknown type'}).` });
          return;
        }
        const ref = assetFor(ctx, mat.path, 'audio', { duration: mat.duration, hasAudio: true });
        const timing = convertSpeed(ctx, seg, refs, ctx.projectAssets[ref.id]!.duration, where);
        const a: AudioClip = { id: newId('clp'), type: 'audio', trackId: track.id, name: mat.name || ref.name, start, duration: D, disabled, assetId: ref.id, ...timing, audio: convertAudio(ctx, seg, refs, where, 'audio') };
        clip = a;
        count('audioClips');
        const beats = refs.byKind.get('beats') as { user_beats?: unknown[]; enable_ai_beats?: boolean }[] | undefined;
        if (beats?.length) {
          const user = beats.reduce((s, b) => s + (b.user_beats?.length ?? 0), 0);
          const ai = beats.some((b) => b.enable_ai_beats);
          ctx.items.push({ level: user || ai ? 'dropped' : 'note', where, what: `Beats: ${user} user beat(s), AI beats ${ai ? 'on' : 'off'}${user || ai ? ' — not imported (no beat markers here)' : ' — nothing to import'}.` });
        }
      } else {
        const t = hit?.mat as CcText | undefined;
        if (!t) {
          ctx.items.push({ level: 'dropped', where, what: `Text material ${seg.material_id} is missing.` });
          return;
        }
        const visualBase = { ...visualDefaults(), transform: convertTransform(ctx, seg, where) };
        Object.assign(visualBase, convertAnimations(ctx, refs, D, where, true));
        const style = textStyleOf(ctx, t, where);
        const tc: TextClip = { id: newId('clp'), type: 'text', trackId: track.id, name: style.content.slice(0, 40), start, duration: D, disabled, text: style, ...visualBase };
        clip = tc;
        count('textClips');
      }
      if (!clip) return;
      if (disabled) ctx.items.push({ level: 'approx', where, what: 'Hidden in CapCut ("Hide clip") → disabled here: neither drawn nor heard.' });
      // segment-level time marks become project markers (root timeline only)
      if (!nested) {
        for (const tm of refs.byKind.get('time_marks') ?? []) {
          for (const it of ((tm as { mark_items?: { time_range?: { start?: number }; color?: string; title?: string }[] }).mark_items ?? [])) {
            const local = num(it.time_range?.start) - num(seg.source_timerange?.start);
            const sp = clip.type === 'video' || clip.type === 'audio' ? clip.speed : 1;
            const at = Math.round(start + local / sp);
            if (at >= start && at <= start + D) ctx.markers.push({ time: at, color: hexColor(it.color, '#22d3ee'), label: it.title });
          }
        }
      }
      const tr = refs.byKind.get('transitions')?.[0];
      if (tr) transitions.push({ from: clip, seg, mat: tr });
      track.clips.push(clip);
    });
    track.clips.sort((a, b) => a.start - b.start);
    // no overlaps inside a track (CapCut never has them, but be safe)
    let end = 0;
    for (const c of track.clips) {
      if (c.start < end) {
        ctx.items.push({ level: 'approx', where: label, what: `Clip at ${sec(c.start)} overlapped the previous one and was moved to ${sec(end)}.` });
        c.start = end;
      }
      end = c.start + c.duration;
    }
    for (const t of transitions) {
      const i = track.clips.indexOf(t.from);
      const a = track.clips[i];
      const b = track.clips[i + 1];
      const name = String((t.mat as { name?: unknown }).name ?? 'Transition');
      const where = `${label} cut @ ${sec(a ? a.start + a.duration : 0)}`;
      if (!a || !b || a.start + a.duration !== b.start || kind === 'audio') {
        ctx.items.push({ level: 'dropped', where, what: `Transition "${name}" is not on a cut between two adjacent clips.` });
        continue;
      }
      const { type, exact } = matchTransition(name);
      const want = Math.round(num((t.mat as { duration?: unknown }).duration, 500_000));
      const max = Math.floor(Math.min(a.duration, b.duration) / 2);
      const duration = Math.max(1, Math.min(want, max));
      const trn: Transition = { id: newId('trn'), type, fromClipId: a.id, toClipId: b.id, duration };
      track.transitions.push(trn);
      if (!nested) ctx.counts.transitions += 1;
      ctx.items.push({
        level: exact && duration === want ? 'exact' : 'approx',
        where,
        what: `Transition "${name}" ${sec(want)} → ${exact ? type : `closest "${type}"`}${duration !== want ? `, shortened to ${sec(duration)} (half the shorter clip)` : ''}; centred on the cut.`,
      });
    }
    if (kind === 'main') main = track;
    if (!track.clips.length && kind !== 'main') continue;
    if (kind === 'audio') audio.push(track);
    else if (kind !== 'main') visual.push(track);
  }
  return [main ?? createTrack('main'), ...visual, ...audio];
}

function convertCompound(
  ctx: Ctx,
  seg: CcSegment,
  mat: CcVideoMaterial,
  draftMat: { draft?: CcDraft; name?: string },
  trackId: Id,
  visual: VisualFields,
  where: string,
): CompoundClip | null {
  if (ctx.depth >= 8) {
    ctx.items.push({ level: 'dropped', where, what: 'Compound clip nested more than 8 levels deep.' });
    return null;
  }
  const name = mat.material_name || draftMat.name || 'Compound clip';
  ctx.depth += 1;
  const tracks = convertTracks(ctx, draftMat.draft!, `${name} › `);
  ctx.depth -= 1;
  const seqId = newId('seq');
  const duration = tracksEnd(tracks);
  const seq: Sequence = { id: seqId, name, tracks, duration, createdAt: Date.now() };
  ctx.sequences[seqId] = seq;
  const D = Math.round(num(seg.target_timerange?.duration));
  const S = Math.round(num(seg.source_timerange?.duration, D));
  let inPoint = Math.max(0, Math.round(num(seg.source_timerange?.start)));
  let dur = D;
  if (Math.abs(S - D) > ctx.frameUs / 2) ctx.items.push({ level: 'approx', where, what: `Compound clip at ${round(S / D, 3)}× speed — compound clips play at 1× here (the first ${sec(D)} of it are shown).` });
  if (inPoint + dur > duration) {
    inPoint = Math.max(0, duration - dur);
    dur = Math.min(dur, duration - inPoint);
  }
  const clipsInside = tracks.reduce((s, t) => s + t.clips.length, 0);
  ctx.items.push({
    level: 'exact',
    where,
    what: `Compound clip "${name}" → compound clip + subproject (${clipsInside} clip${clipsInside === 1 ? '' : 's'} on ${tracks.filter((t) => t.clips.length).length} track(s), ${sec(duration)}), from the draft embedded in draft_info.json.`,
  });
  return {
    id: newId('clp'),
    type: 'compound',
    trackId,
    name,
    start: Math.round(num(seg.target_timerange?.start)),
    duration: dur,
    disabled: seg.visible === false,
    sequenceId: seqId,
    inPoint,
    ...visual,
  };
}

function aspectOf(w: number, h: number): { aspect: AspectRatio; exact: boolean } {
  const opts: [AspectRatio, number][] = [
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['3:4', 3 / 4],
  ];
  const r = w / h;
  let best = opts[0]!;
  for (const o of opts) if (Math.abs(o[1] - r) < Math.abs(best[1] - r)) best = o;
  return { aspect: best[0], exact: Math.abs(best[1] - r) < 1e-3 };
}

export function convertCapcutDraft(draft: CcDraft, resolvePath: (raw: string) => string | null, opts: ConvertOptions = {}): ConvertResult {
  const W0 = num(draft.canvas_config?.width, 1080);
  const H0 = num(draft.canvas_config?.height, 1920);
  const { aspect, exact } = aspectOf(W0, H0);
  const fpsIn = num(draft.fps, 30);
  const fps: Fps = ([24, 25, 30, 60] as Fps[]).reduce((b, f) => (Math.abs(f - fpsIn) < Math.abs(b - fpsIn) ? f : b), 30 as Fps);
  const draftName = opts.name ?? (draft.name || 'CapCut import');
  const project = createProject({ name: draftName, aspect });
  project.settings.fps = fps;
  const ctx: Ctx = {
    W: project.settings.width,
    H: project.settings.height,
    fps,
    frameUs: 1e6 / fps,
    resolvePath,
    assets: new Map(),
    projectAssets: {},
    sequences: {},
    items: [],
    counts: { tracks: 0, videoClips: 0, imageClips: 0, compoundClips: 0, audioClips: 0, textClips: 0, nestedClips: 0, markers: 0, transitions: 0, files: 0, missingFiles: 0 },
    markers: [],
    depth: 0,
  };
  const head: ReportItem[] = [];
  head.push({ level: exact ? 'exact' : 'approx', where: 'Project', what: `Canvas ${W0}×${H0} → ${aspect} (${project.settings.width}×${project.settings.height})${exact ? '' : ' — nearest ratio'}.` });
  head.push({ level: fpsIn === fps ? 'exact' : 'approx', where: 'Project', what: `${fpsIn} fps${fpsIn === fps ? '' : ` → ${fps} fps`}.` });

  const tracks = convertTracks(ctx, draft, '');
  project.tracks = tracks;
  project.assets = ctx.projectAssets;
  if (Object.keys(ctx.sequences).length) project.sequences = ctx.sequences;

  // project markers (CapCut "time_marks")
  for (const it of draft.time_marks?.mark_items ?? []) ctx.markers.push({ time: Math.round(num(it.time_range?.start)), color: hexColor(it.color, '#22d3ee'), label: it.title });
  const seen = new Set<number>();
  project.markers = ctx.markers
    .sort((a, b) => a.time - b.time)
    .filter((m) => (seen.has(m.time) ? false : (seen.add(m.time), true)))
    .map((m) => ({ id: newId('mrk'), time: m.time, color: m.color, ...(m.label ? { label: m.label } : {}) }));
  for (const m of project.markers) head.push({ level: 'exact', where: 'Markers', what: `"${m.label ?? 'Marker'}" at ${sec(m.time)} (${m.color}).` });

  // global (legacy) keyframe lists
  for (const [k, list] of Object.entries(draft.keyframes ?? {})) {
    if (Array.isArray(list) && list.length) ctx.items.push({ level: 'dropped', where: 'Project', what: `${list.length} legacy ${k} keyframe(s) — no keyframes here.` });
  }
  const totalUs = num(draft.duration);
  const ours = Math.max(0, ...tracks.map((t) => Math.max(0, ...t.clips.map((c) => c.start + c.duration))));
  head.push({ level: Math.abs(ours - totalUs) <= ctx.frameUs ? 'exact' : 'approx', where: 'Project', what: `Duration ${sec(totalUs)} in CapCut → ${sec(ours)} here.` });

  ctx.counts.tracks = tracks.filter((t) => t.clips.length || t.kind === 'main').length;
  ctx.counts.markers = project.markers.length;
  ctx.counts.files = ctx.assets.size;
  ctx.counts.missingFiles = [...ctx.assets.values()].filter((a) => a.missing).length;
  return {
    project,
    assets: [...ctx.assets.values()],
    report: { draftName, counts: ctx.counts, items: [...head, ...ctx.items] },
  };
}

// ---------------------------------------------------------------- report text

const LEVEL_LABEL: Record<ReportLevel, string> = { exact: 'Exact', approx: 'Approximated', dropped: 'Dropped', note: 'Note' };

/** "Imported 29 clips, 2 audio … 3 items approximated: …" */
export function reportSummary(r: CapcutImportReport): string {
  const c = r.counts;
  const visual = c.videoClips + c.imageClips + c.compoundClips + c.textClips;
  const parts = [
    `${visual} clip${visual === 1 ? '' : 's'} (${[c.videoClips && `${c.videoClips} video`, c.imageClips && `${c.imageClips} photo`, c.compoundClips && `${c.compoundClips} compound`, c.textClips && `${c.textClips} text`].filter(Boolean).join(', ')})`,
    `${c.audioClips} audio`,
  ];
  if (c.nestedClips) parts.push(`${c.nestedClips} inside compound clips`);
  if (c.markers) parts.push(`${c.markers} marker${c.markers === 1 ? '' : 's'}`);
  if (c.transitions) parts.push(`${c.transitions} transition${c.transitions === 1 ? '' : 's'}`);
  const approx = r.items.filter((i) => i.level === 'approx').length;
  const dropped = r.items.filter((i) => i.level === 'dropped').length;
  return `Imported ${parts.join(', ')} from ${c.files} file${c.files === 1 ? '' : 's'}${c.missingFiles ? ` (${c.missingFiles} missing)` : ''}. ${approx} item${approx === 1 ? '' : 's'} approximated, ${dropped} dropped.`;
}

/** The whole report as plain text lines (dialog "Copy", logs, tests). */
export function formatReport(r: CapcutImportReport): string[] {
  const out = [reportSummary(r)];
  for (const level of ['approx', 'dropped', 'exact', 'note'] as ReportLevel[]) {
    const items = r.items.filter((i) => i.level === level);
    if (!items.length) continue;
    out.push('', `${LEVEL_LABEL[level]} (${items.length}):`);
    for (const i of items) out.push(`  • ${i.where}: ${i.what}`);
  }
  return out;
}

/** Path resolver for drafts on disk: CapCut's placeholder prefix → the draft folder. */
export function placeholderResolver(draftFolder: string, exists: (p: string) => boolean = () => true): (raw: string) => string | null {
  return (raw: string) => {
    if (!raw) return null;
    const p = raw.replace(/^##_draftpath_placeholder_[0-9A-Fa-f-]+_##/, draftFolder.replace(/\/$/, ''));
    return exists(p) ? p : null;
  };
}
