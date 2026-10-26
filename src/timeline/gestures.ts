/**
 * Pure decisions behind the timeline gestures (no DOM): where a dragged clip lands, which track
 * a library drop goes to, snapping of moves and trims. Unit-tested in gestures.test.ts.
 */
import { isAudioCompound } from '../model/compound';
import { trackAccepts } from '../model/project';
import { pxToUs, snapCandidates, snapRange, snapTime } from '../model/time';
import type { Clip, ClipType, Id, MediaKind, Project, Track, TrackKind, Us } from '../model/types';
import { SNAP_PX, magnetInsertCut } from './geometry';

/** A row under the pointer: a track, or the empty band above the top / below the bottom track. */
export type RowKey = { type: 'track'; trackId: Id } | { type: 'band'; band: 'top' | 'bottom' };

export type NewTrackKind = Exclude<TrackKind, 'main'>;

/** Where a moved clip goes: an existing track, or a new track of `newKind`. */
export type MoveTarget = { trackId: Id; newKind?: undefined } | { trackId?: undefined; newKind: NewTrackKind };

/** Kind of the new track created by dropping a clip of `type` into a band, or null (not allowed). */
export function bandTrackKind(type: ClipType, band: 'top' | 'bottom', audioCompound = false): NewTrackKind | null {
  if (audioCompound) return band === 'bottom' ? 'audio' : null;
  if (band === 'top') {
    if (type === 'video' || type === 'image') return 'overlay';
    if (type === 'text') return 'text';
    return null;
  }
  return type === 'audio' ? 'audio' : null;
}

/**
 * Target for moving `clip` (currently on `fromTrack`) onto `row`. Incompatible rows and bands keep
 * the clip on its own track (CapCut refuses the cross-kind drop and the clip moves in time only).
 */
export function resolveMoveTarget(project: Project, clip: Clip, fromTrack: Track, row: RowKey | null): MoveTarget {
  if (!row) return { trackId: fromTrack.id };
  if (row.type === 'band') {
    const kind = bandTrackKind(clip.type, row.band, isAudioCompound(project, clip));
    return kind ? { newKind: kind } : { trackId: fromTrack.id };
  }
  const t = project.tracks.find((x) => x.id === row.trackId);
  if (!t || t.locked || !trackAccepts(t.kind, clip, project)) return { trackId: fromTrack.id };
  return { trackId: t.id };
}

export interface SnapResult {
  value: Us;
  /** Time of the snap guide line, if snapped. */
  guide: Us | null;
}

/** Snap threshold in µs for the given zoom. */
export const snapThresholdUs = (zoom: number): number => pxToUs(SNAP_PX, zoom);

/** Snaps a moving clip range (both edges tried). */
export function snapMove(project: Project, playhead: Us, clipId: Id, start: Us, duration: Us, zoom: number, enabled: boolean): SnapResult {
  const s = Math.max(0, Math.round(start));
  if (!enabled) return { value: s, guide: null };
  const r = snapRange(s, duration, snapCandidates(project, playhead, [clipId]), snapThresholdUs(zoom));
  if (!r.snapped) return { value: s, guide: null };
  return { value: Math.max(0, r.start), guide: r.target ?? null };
}

/** Snaps a single time (trim edge, drop point, scrub). */
export function snapPoint(project: Project, playhead: Us, t: Us, zoom: number, enabled: boolean, exclude: readonly Id[] = []): SnapResult {
  const v = Math.max(0, Math.round(t));
  if (!enabled) return { value: v, guide: null };
  const r = snapTime(v, snapCandidates(project, playhead, exclude), snapThresholdUs(zoom));
  return r.snapped ? { value: r.time, guide: r.time } : { value: v, guide: null };
}

/** The magnet insertion cut shown while dragging onto the main track (null if not magnetic main). */
export function moveInsertCut(project: Project, target: MoveTarget, clip: Clip, start: Us, magnet: boolean): Us | null {
  if (!magnet || !target.trackId) return null;
  const t = project.tracks.find((x) => x.id === target.trackId);
  if (!t || t.kind !== 'main') return null;
  return magnetInsertCut(t.clips, start + clip.duration / 2 - 1, [clip.id]);
}

/** Library asset drop: which `addClip` options to use for a drop on `row`. */
export function assetDropOptions(
  project: Project,
  kind: MediaKind,
  row: RowKey | null,
  at: Us,
): { at: Us; trackId?: Id; kind?: 'main' | 'overlay' } {
  const fake = { type: kind } as Pick<Clip, 'type'>;
  if (row?.type === 'track') {
    const t = project.tracks.find((x) => x.id === row.trackId);
    if (t && !t.locked && trackAccepts(t.kind, fake)) return { at, trackId: t.id };
  }
  if (row?.type === 'band' && row.band === 'top' && kind !== 'audio') return { at, kind: 'overlay' };
  return { at };
}

/** Text drop: target text track id if the row is one. */
export function textDropTrack(project: Project, row: RowKey | null): Id | undefined {
  if (row?.type !== 'track') return undefined;
  const t = project.tracks.find((x) => x.id === row.trackId);
  return t && t.kind === 'text' && !t.locked ? t.id : undefined;
}
