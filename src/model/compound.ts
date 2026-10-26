/**
 * Compound clips / subprojects (CapCut "Create compound clip", ⌥G) — pure read-only helpers.
 *
 * A `Sequence` (project.sequences) is a nested timeline with the same track rules as the project;
 * a `compound` clip shows a window [inPoint, inPoint + duration) of one. While a sequence is open
 * for editing (project.focus), its live tracks are `project.tracks` and the timeline it was opened
 * from waits in the focus entry; `sequenceTracks` hides that from callers.
 *
 * The mutating ops (create / ungroup / open / close) live in src/store/compoundOps.ts.
 */
import { clipEnd } from './time';
import type { Clip, CompoundClip, Id, Project, Sequence, Track, Us } from './types';

/** Deepest compound-in-compound nesting that is rendered (deeper levels draw nothing). */
export const MAX_COMPOUND_DEPTH = 8;

export const isCompoundClip = (c: Pick<Clip, 'type'>): c is CompoundClip => c.type === 'compound';

export const sequencesOf = (p: Project): Record<Id, Sequence> => p.sequences ?? {};

export const focusStack = (p: Project): readonly NonNullable<Project['focus']>[number][] => p.focus ?? [];

/** Id of the sequence open in the timeline, or null for the main timeline. */
export const focusedSequenceId = (p: Project): Id | null => {
  const f = p.focus;
  return f && f.length ? f[f.length - 1]!.sequenceId : null;
};

/**
 * The live tracks of a sequence: `project.tracks` when it is the open one, the tracks kept in the
 * focus entry above it when it is open further down the stack, else its own `tracks`.
 */
export function sequenceTracks(p: Project, sequenceId: Id): Track[] | undefined {
  const f = p.focus ?? [];
  for (let i = f.length - 1; i >= 0; i--) {
    if (f[i]!.sequenceId !== sequenceId) continue;
    return i === f.length - 1 ? p.tracks : f[i + 1]!.parentTracks;
  }
  return p.sequences?.[sequenceId]?.tracks;
}

/**
 * A compound clip whose sequence holds only sound (audio clips, or audio-only compounds): it is an
 * AUDIO clip — it lives on audio tracks, like CapCut's audio compound clips. An empty sequence is not.
 */
export function isAudioCompound(p: Project, clip: Pick<Clip, 'type'> & { sequenceId?: Id }, depth = 0): boolean {
  if (clip.type !== 'compound' || !clip.sequenceId || depth > 8) return false;
  const clips = (sequenceTracks(p, clip.sequenceId) ?? []).flatMap((t) => t.clips);
  return clips.length > 0 && clips.every((c) => c.type === 'audio' || (c.type === 'compound' && isAudioCompound(p, c, depth + 1)));
}

/** The main (root) timeline's tracks, wherever they are right now. */
export const rootTracks = (p: Project): Track[] => (p.focus && p.focus.length ? p.focus[0]!.parentTracks : p.tracks);

/** End of the last clip of a track list. */
export const tracksEnd = (tracks: readonly Track[]): Us => tracks.reduce((m, t) => Math.max(m, ...t.clips.map(clipEnd)), 0);

/** Every track list of the document: the open timeline, the ones waiting in the focus stack, every closed sequence. */
export function trackScopes(p: Project): { id: Id | null; tracks: Track[] }[] {
  const out: { id: Id | null; tracks: Track[] }[] = [{ id: focusedSequenceId(p), tracks: p.tracks }];
  const f = p.focus ?? [];
  for (let i = 0; i < f.length; i++) out.push({ id: i === 0 ? null : f[i - 1]!.sequenceId, tracks: f[i]!.parentTracks });
  const open = new Set(f.map((x) => x.sequenceId));
  for (const s of Object.values(sequencesOf(p))) if (!open.has(s.id)) out.push({ id: s.id, tracks: s.tracks });
  return out;
}

/** Every clip in the document, nested ones included. */
export const allClipsDeep = (p: Project): Clip[] => trackScopes(p).flatMap((s) => s.tracks.flatMap((t) => t.clips));

/** Sequence ids directly referenced by compound clips of a track list. */
export function referencedSequences(tracks: readonly Track[]): Set<Id> {
  const s = new Set<Id>();
  for (const t of tracks) for (const c of t.clips) if (c.type === 'compound') s.add(c.sequenceId);
  return s;
}

/** True when sequence `inner` is `outer` or is nested (at any depth) inside it. */
export function sequenceContains(p: Project, outer: Id, inner: Id, seen: Set<Id> = new Set()): boolean {
  if (outer === inner) return true;
  if (seen.has(outer)) return false;
  seen.add(outer);
  const tracks = sequenceTracks(p, outer);
  if (!tracks) return false;
  for (const id of referencedSequences(tracks)) if (sequenceContains(p, id, inner, seen)) return true;
  return false;
}

/**
 * Can an instance of `sequenceId` be placed in the open timeline? Not when that would nest a
 * sequence in itself: the open sequence and everything it is open from are off limits.
 */
export function canPlaceSequence(p: Project, sequenceId: Id): boolean {
  if (!sequencesOf(p)[sequenceId]) return false;
  for (const f of p.focus ?? []) if (sequenceContains(p, sequenceId, f.sequenceId)) return false;
  return true;
}

/** Compound clips (anywhere) that show `sequenceId`. */
export const instancesOf = (p: Project, sequenceId: Id): CompoundClip[] =>
  allClipsDeep(p).filter((c): c is CompoundClip => c.type === 'compound' && c.sequenceId === sequenceId);

/** Length of a sequence (its stored duration; the live content end while it is open). */
export function sequenceDuration(p: Project, sequenceId: Id): Us {
  const s = sequencesOf(p)[sequenceId];
  if (!s) return 0;
  if ((p.focus ?? []).some((f) => f.sequenceId === sequenceId)) return Math.max(s.duration, tracksEnd(sequenceTracks(p, sequenceId) ?? []));
  return s.duration;
}

/** Next free "Compound N" name. */
export function nextCompoundName(p: Project): string {
  const used = new Set(Object.values(sequencesOf(p)).map((s) => s.name));
  let n = 1;
  while (used.has(`Compound ${n}`)) n++;
  return `Compound ${n}`;
}

/** Breadcrumb of the open timeline: "Main", then each opened sequence's name. */
export function breadcrumb(p: Project): { sequenceId: Id | null; name: string }[] {
  const out: { sequenceId: Id | null; name: string }[] = [{ sequenceId: null, name: 'Main' }];
  for (const f of p.focus ?? []) out.push({ sequenceId: f.sequenceId, name: sequencesOf(p)[f.sequenceId]?.name ?? 'Compound' });
  return out;
}

// ---------------------------------------------------------------- open / close (pure)

/** Maps every clip of every track list of the document (returns the same objects when `fn` changes nothing). */
function mapAllClips(p: Project, fn: (c: Clip) => Clip): Project {
  const mapTracks = (tracks: Track[]): Track[] => {
    let changed = false;
    const out = tracks.map((t) => {
      let tc = false;
      const clips = t.clips.map((c) => {
        const n = fn(c);
        if (n !== c) tc = true;
        return n;
      });
      if (!tc) return t;
      changed = true;
      return { ...t, clips };
    });
    return changed ? out : tracks;
  };
  let out = p;
  const tracks = mapTracks(p.tracks);
  if (tracks !== p.tracks) out = { ...out, tracks };
  if (p.focus?.length) {
    const focus = p.focus.map((f) => {
      const parentTracks = mapTracks(f.parentTracks);
      return parentTracks === f.parentTracks ? f : { ...f, parentTracks };
    });
    if (focus.some((f, i) => f !== p.focus![i])) out = { ...out, focus };
  }
  if (p.sequences) {
    let changed = false;
    const sequences: Record<Id, Sequence> = {};
    for (const [id, s] of Object.entries(p.sequences)) {
      const t = mapTracks(s.tracks);
      sequences[id] = t === s.tracks ? s : { ...s, tracks: t };
      if (t !== s.tracks) changed = true;
    }
    if (changed) out = { ...out, sequences };
  }
  return out;
}

/**
 * Opens a sequence for editing (double-click on a compound clip): its tracks become
 * `project.tracks` and the current tracks wait in a new focus entry. Returns the same project
 * when the sequence does not exist or is already open (nesting a sequence in itself).
 */
export function openSequence(p: Project, sequenceId: Id): Project {
  const s = sequencesOf(p)[sequenceId];
  if (!s || (p.focus ?? []).some((f) => f.sequenceId === sequenceId)) return p;
  return {
    ...p,
    tracks: s.tracks,
    sequences: { ...sequencesOf(p), [sequenceId]: { ...s, tracks: [] } },
    focus: [...(p.focus ?? []), { sequenceId, parentTracks: p.tracks }],
  };
}

/**
 * Closes the innermost open sequence: its edited tracks go back into project.sequences, its
 * duration becomes the new content end, and every instance follows (an instance that showed the
 * sequence to its end keeps doing so; any instance is cut to the new end). The caller normalizes
 * (the magnet may need to ripple the main track). Same project when nothing is open.
 */
export function closeSequence(p: Project, minUs: Us = 1): Project {
  const f = p.focus;
  if (!f || !f.length) return p;
  const top = f[f.length - 1]!;
  const s = sequencesOf(p)[top.sequenceId];
  const live = p.tracks;
  const oldDur = s?.duration ?? 0;
  const newDur = tracksEnd(live);
  let out: Project = {
    ...p,
    tracks: top.parentTracks,
    focus: f.slice(0, -1),
    sequences: { ...sequencesOf(p), [top.sequenceId]: { ...(s ?? { id: top.sequenceId, name: 'Compound', createdAt: Date.now() }), tracks: live, duration: newDur } },
  };
  if (!out.focus!.length) delete out.focus;
  if (newDur !== oldDur) {
    out = mapAllClips(out, (c) => {
      if (c.type !== 'compound' || c.sequenceId !== top.sequenceId) return c;
      const toEnd = c.inPoint + c.duration >= oldDur;
      const inPoint = Math.max(0, Math.min(c.inPoint, newDur - minUs));
      const duration = Math.max(minUs, toEnd ? newDur - inPoint : Math.min(c.duration, newDur - inPoint));
      return inPoint === c.inPoint && duration === c.duration ? c : { ...c, inPoint, duration };
    });
  }
  return out;
}

/** The document with every open sequence closed: what is saved, exported and reloaded. */
export function rootProject(p: Project, minUs: Us = 1): Project {
  let out = p;
  while (out.focus && out.focus.length) out = closeSequence(out, minUs);
  return out;
}
