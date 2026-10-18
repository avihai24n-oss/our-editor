/**
 * Pure helpers for the Library (left panel): asset filtering/sorting, labels, drag payloads,
 * CSS previews for filters. No React, no DOM — unit-tested in libraryLogic.test.ts.
 */
import { filterDef } from '../model/catalog';
import { adjacentNext, findClip, mainTrack } from '../model/project';
import { clipEnd, formatShort } from '../model/time';
import type { Adjust, FilterId, Id, MediaAsset, MediaKind, Project, TransitionType } from '../model/types';

// ---------------------------------------------------------------- asset list

export type AssetSort = 'added' | 'name' | 'duration' | 'type';
export type AssetKindFilter = 'all' | MediaKind;

export const SORT_LABELS: Record<AssetSort, string> = {
  added: 'Date added',
  name: 'Name',
  duration: 'Duration',
  type: 'Type',
};

const KIND_ORDER: Record<MediaKind, number> = { video: 0, image: 1, audio: 2 };

/**
 * Filters by kind and search text (case-insensitive, matches anywhere in the name), then sorts.
 * `assets` is expected in insertion order (= date added). Stable for equal keys.
 */
export function visibleAssets(assets: readonly MediaAsset[], opts: { kind: AssetKindFilter; query: string; sort: AssetSort }): MediaAsset[] {
  const q = opts.query.trim().toLowerCase();
  const list = assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => (opts.kind === 'all' || a.kind === opts.kind) && (!q || a.name.toLowerCase().includes(q)));
  const cmp: Record<AssetSort, (x: { a: MediaAsset; i: number }, y: { a: MediaAsset; i: number }) => number> = {
    added: (x, y) => x.i - y.i,
    name: (x, y) => x.a.name.localeCompare(y.a.name, undefined, { numeric: true, sensitivity: 'base' }) || x.i - y.i,
    duration: (x, y) => y.a.duration - x.a.duration || x.i - y.i,
    type: (x, y) => KIND_ORDER[x.a.kind] - KIND_ORDER[y.a.kind] || x.i - y.i,
  };
  return list.sort(cmp[opts.sort]).map(({ a }) => a);
}

/** CapCut-style middle ellipsis keeping the extension: "shabbat-ca...-en-t1.mp3". */
export function middleEllipsis(name: string, max = 22): string {
  if (name.length <= max) return name;
  const keepEnd = Math.ceil((max - 3) / 2);
  const keepStart = max - 3 - keepEnd;
  return `${name.slice(0, keepStart)}...${name.slice(name.length - keepEnd)}`;
}

/** Duration badge: "00:10" for timed media, null for images. */
export const durationBadge = (a: Pick<MediaAsset, 'kind' | 'duration'>): string | null =>
  a.kind === 'image' ? null : formatShort(a.duration);

/** Deterministic pseudo-waveform bar heights (0.15..1) for audio tiles, seeded by the asset id. */
export function waveformBars(seed: string, count = 28): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ i;
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const r = ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    out.push(Math.round((0.15 + r * 0.85) * 100) / 100);
  }
  return out;
}

// ---------------------------------------------------------------- drag and drop

/** Contract with the timeline (SPEC §4): JSON payload under this type. */
export const DND_TYPE = 'application/x-our-editor';
/** Legacy/simple type: the bare asset id (kept for consumers that only read an id). */
export const DND_ASSET_TYPE = 'application/x-our-editor-asset';

export type DragPayload = { kind: 'asset'; assetId: string } | { kind: 'text'; preset?: string } | { kind: 'transition'; type: TransitionType };

/** Minimal DataTransfer surface so this stays testable without a DOM. */
export interface DataTransferLike {
  setData(type: string, data: string): void;
  effectAllowed: string;
}

export function setDragPayload(dt: DataTransferLike, payload: DragPayload): void {
  dt.setData(DND_TYPE, JSON.stringify(payload));
  if (payload.kind === 'asset') dt.setData(DND_ASSET_TYPE, payload.assetId);
  dt.setData('text/plain', payload.kind === 'asset' ? payload.assetId : payload.kind);
  dt.effectAllowed = 'copy';
}

export function parseDragPayload(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DragPayload> & Record<string, unknown>;
    if (v.kind === 'asset' && typeof v.assetId === 'string') return { kind: 'asset', assetId: v.assetId };
    if (v.kind === 'text') return typeof v.preset === 'string' ? { kind: 'text', preset: v.preset } : { kind: 'text' };
    if (v.kind === 'transition' && typeof v.type === 'string') return { kind: 'transition', type: v.type as TransitionType };
  } catch {
    /* not ours */
  }
  return null;
}

/** True when an OS file drag is in progress (shows the "Drop to import" overlay). */
export const isFileDrag = (types: readonly string[]): boolean => types.includes('Files');

// ---------------------------------------------------------------- previews

/**
 * Approximates an Adjust (+ grayscale/sepia) as a CSS `filter` string for tile previews only.
 * The real look is rendered by the engine; this just has to read correctly at thumbnail size.
 */
export function adjustToCssFilter(adj: Partial<Adjust>, extra: { grayscale?: number; sepia?: number } = {}): string {
  const parts: string[] = [];
  const b = 1 + ((adj.brightness ?? 0) + (adj.exposure ?? 0) * 1.2 + (adj.shadows ?? 0) * 0.3 + (adj.highlights ?? 0) * 0.2) / 100;
  const c = 1 + (adj.contrast ?? 0) / 100 - (adj.fade ?? 0) / 250;
  const s = 1 + (adj.saturation ?? 0) / 50;
  if (Math.abs(b - 1) > 0.001) parts.push(`brightness(${round2(Math.max(0, b))})`);
  if (Math.abs(c - 1) > 0.001) parts.push(`contrast(${round2(Math.max(0, c))})`);
  if (Math.abs(s - 1) > 0.001) parts.push(`saturate(${round2(Math.max(0, s))})`);
  const temp = adj.temperature ?? 0;
  if (temp > 0) parts.push(`sepia(${round2(temp / 150)})`);
  const hue = (temp < 0 ? temp * 0.6 : 0) + (adj.tint ?? 0) * 0.6;
  if (Math.abs(hue) > 0.01) parts.push(`hue-rotate(${round2(-hue)}deg)`);
  if (extra.grayscale) parts.push(`grayscale(${round2(extra.grayscale)})`);
  if (extra.sepia) parts.push(`sepia(${round2(extra.sepia)})`);
  return parts.length ? parts.join(' ') : 'none';
}

export function filterCss(id: FilterId): string {
  const f = filterDef(id);
  return f ? adjustToCssFilter(f.adjust, { grayscale: f.grayscale, sepia: f.sepia }) : 'none';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- apply targets


export type TransitionTarget = { mode: 'update'; transitionId: Id } | { mode: 'add'; fromClipId: Id } | null;

/**
 * Where a click on a Transitions tile lands (CapCut: the selected cut):
 * 1. a selected transition → change its type;
 * 2. one selected visual clip → the cut after it (or, if it is last, the cut before it);
 * 3. otherwise the main-track cut nearest the playhead.
 */
export function resolveTransitionTarget(p: Project, sel: { clipIds: readonly Id[]; transitionId: Id | null }, playhead: number): TransitionTarget {
  if (sel.transitionId) return { mode: 'update', transitionId: sel.transitionId };
  if (sel.clipIds.length === 1) {
    const f = findClip(p, sel.clipIds[0]!);
    if (f && f.clip.type !== 'audio' && !f.track.locked) {
      if (adjacentNext(f.track, f.clip.id)) return { mode: 'add', fromClipId: f.clip.id };
      const prev = f.track.clips[f.index - 1];
      if (prev && clipEnd(prev) === f.clip.start) return { mode: 'add', fromClipId: prev.id };
      return null;
    }
  }
  const main = mainTrack(p);
  if (main.locked) return null;
  let best: { id: Id; dist: number } | null = null;
  for (const c of main.clips) {
    if (!adjacentNext(main, c.id)) continue;
    const dist = Math.abs(clipEnd(c) - playhead);
    if (!best || dist < best.dist) best = { id: c.id, dist };
  }
  return best ? { mode: 'add', fromClipId: best.id } : null;
}

/** Selected clips that can take a look (filter / adjust): visual, on unlocked tracks. */
export function selectedVisualIds(p: Project, ids: readonly Id[]): Id[] {
  return ids.filter((id) => {
    const f = findClip(p, id);
    return !!f && f.clip.type !== 'audio' && !f.track.locked;
  });
}
