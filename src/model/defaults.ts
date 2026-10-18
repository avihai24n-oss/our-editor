/**
 * Default values and factories. Every new object in the document is built here so defaults
 * live in one place.
 */
import { aspectSize } from './catalog';
import { secToUs } from './time';
import {
  SCHEMA_VERSION,
  type Adjust,
  type AspectRatio,
  type AudioClip,
  type AudioProps,
  type ClipAnimation,
  type AnimationType,
  type Crop,
  type Id,
  type ImageClip,
  type MediaAsset,
  type Project,
  type TextClip,
  type TextStyle,
  type Track,
  type TrackKind,
  type Transform,
  type Transition,
  type TransitionType,
  type Us,
  type VideoClip,
} from './types';

let counter = 0;
/** Short unique id. Uses crypto.randomUUID when available. */
export function newId(prefix = ''): Id {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : `${Date.now().toString(36)}${(counter++).toString(36)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

export const DEFAULT_IMAGE_DURATION: Us = secToUs(5);
export const DEFAULT_TEXT_DURATION: Us = secToUs(3);
export const DEFAULT_ANIMATION_DURATION: Us = secToUs(0.5);
export const DEFAULT_TRANSITION_DURATION: Us = secToUs(0.5);

export const defaultTransform = (): Transform => ({
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  flipH: false,
  flipV: false,
});

export const defaultCrop = (): Crop => ({ left: 0, top: 0, right: 0, bottom: 0 });

export const defaultAdjust = (): Adjust => ({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  fade: 0,
  vignette: 0,
  sharpen: 0,
});

export const defaultAudio = (): AudioProps => ({ volumeDb: 0, fadeIn: 0, fadeOut: 0, muted: false });

export const defaultTextStyle = (content = 'Default text'): TextStyle => ({
  content,
  fontFamily: 'system-ui',
  fontSize: 72,
  color: '#ffffff',
  bold: false,
  italic: false,
  underline: false,
  align: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  stroke: { enabled: false, color: '#000000', width: 6 },
  background: { enabled: false, color: '#000000', opacity: 0.6 },
  shadow: { enabled: false, color: '#000000', blur: 8, offsetX: 0, offsetY: 4 },
});

export const makeAnimation = (type: AnimationType, duration: Us = DEFAULT_ANIMATION_DURATION): ClipAnimation => ({ type, duration });

const visualDefaults = () => ({
  transform: defaultTransform(),
  crop: defaultCrop(),
  blend: 'normal' as const,
  animationIn: null,
  animationOut: null,
  filter: null,
  adjust: defaultAdjust(),
});

export function createProject(opts: { name?: string; aspect?: AspectRatio } = {}): Project {
  const aspect = opts.aspect ?? '9:16';
  const now = Date.now();
  return {
    id: newId('prj'),
    name: opts.name ?? 'Untitled project',
    version: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    settings: { aspect, ...aspectSize(aspect), fps: 30, background: '#000000' },
    assets: {},
    tracks: [createTrack('main')],
    markers: [],
  };
}

const TRACK_NAMES: Record<TrackKind, string> = { main: 'Main', overlay: 'Overlay', audio: 'Audio', text: 'Text' };

export function createTrack(kind: TrackKind): Track {
  return {
    id: newId('trk'),
    kind,
    name: TRACK_NAMES[kind],
    locked: false,
    hidden: false,
    muted: false,
    clips: [],
    transitions: [],
  };
}

export function createAsset(fields: Omit<MediaAsset, 'id' | 'blobKey'> & { id?: Id; blobKey?: Id }): MediaAsset {
  const id = fields.id ?? newId('ast');
  return { ...fields, id, blobKey: fields.blobKey ?? id };
}

/** Builds a media clip for an asset (video → VideoClip, image → ImageClip, audio → AudioClip). */
export function createClipFromAsset(asset: MediaAsset, trackId: Id, start: Us): VideoClip | ImageClip | AudioClip {
  const base = { id: newId('clp'), trackId, name: asset.name, start, disabled: false };
  if (asset.kind === 'image') {
    return { ...base, type: 'image', duration: DEFAULT_IMAGE_DURATION, assetId: asset.id, ...visualDefaults() };
  }
  const timed = { assetId: asset.id, inPoint: 0, speed: 1, preservePitch: true, duration: Math.max(1, asset.duration) };
  if (asset.kind === 'audio') return { ...base, ...timed, type: 'audio', audio: defaultAudio() };
  return { ...base, ...timed, type: 'video', audio: defaultAudio(), ...visualDefaults() };
}

export function createTextClip(trackId: Id, start: Us, content = 'Default text', duration: Us = DEFAULT_TEXT_DURATION): TextClip {
  return {
    id: newId('clp'),
    type: 'text',
    trackId,
    name: content,
    start,
    duration,
    disabled: false,
    text: defaultTextStyle(content),
    ...visualDefaults(),
  };
}

export function createTransition(fromClipId: Id, toClipId: Id, type: TransitionType, duration: Us = DEFAULT_TRANSITION_DURATION): Transition {
  return { id: newId('trn'), type, fromClipId, toClipId, duration };
}
