/**
 * Compound clip edit operations (CapCut "Create compound clip" ⌥G / "Undo compound" ⌥⇧G).
 * Like ops.ts: each function MUTATES a Project draft and is run inside the store's `edit()`
 * (one undo step, then normalize()). Pure helpers live in src/model/compound.ts.
 */
import { current, isDraft } from 'immer';
import { createTrack, defaultAdjust, defaultCrop, defaultGrade, defaultTransform, newId } from '../model/defaults';
import { canPlaceSequence, nextCompoundName, sequenceDuration, sequencesOf, sequenceTracks, tracksEnd, instancesOf } from '../model/compound';
import { audioLinked, findClip, isRangeFree, mainTrack } from '../model/project';
import { clipEnd } from '../model/time';
import type { Clip, CompoundClip, Id, Project, Track, TrackKind, Us } from '../model/types';
import { insertOnMain, minClipUs, removeEmptyTracks, retain, trimEnd, trimStart, type EditCtx } from './ops';

const plain = <T,>(x: T): T => structuredClone(isDraft(x) ? current(x) : x);

/** A compound clip showing `sequenceId` from `inPoint` for `duration` (neutral look, like a new media clip). */
export function createCompoundClip(sequenceId: Id, name: string, trackId: Id, start: Us, duration: Us, inPoint: Us = 0): CompoundClip {
  return {
    id: newId('clp'),
    type: 'compound',
    trackId,
    name,
    start,
    duration,
    disabled: false,
    sequenceId,
    inPoint,
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
  };
}

/** The selection plus the clips audio-linked to it (extract-audio pairs stay together). */
function withLinked(p: Project, ids: readonly Id[]): Id[] {
  const out = new Set(ids);
  for (const id of ids) {
    const c = findClip(p, id)?.clip;
    if ((c?.type === 'video' || c?.type === 'audio') && c.audioLink) for (const x of audioLinked(p, c.audioLink)) out.add(x.id);
  }
  return [...out];
}

/**
 * Why the clips cannot become one compound clip, or null when they can. Rules (v1):
 * at least one clip, all on unlocked tracks; main-track clips must be adjacent, and with them on
 * the main track the compound takes their slot, so no other main-track clip may sit inside the
 * selection's time span.
 */
export function compoundBlocker(p: Project, clipIds: readonly Id[]): string | null {
  const ids = withLinked(p, clipIds);
  const found = ids.map((id) => findClip(p, id));
  if (!found.length || found.some((f) => !f)) return 'Select clips first';
  if (found.some((f) => f!.track.locked)) return 'A selected clip is on a locked track';
  const start = Math.min(...found.map((f) => f!.clip.start));
  const end = Math.max(...found.map((f) => clipEnd(f!.clip)));
  const main = mainTrack(p);
  const set = new Set(ids);
  const onMain = main.clips.map((c, i) => (set.has(c.id) ? i : -1)).filter((i) => i >= 0);
  if (onMain.length) {
    if (onMain.some((x, k) => k > 0 && x !== onMain[k - 1]! + 1)) return 'Main-track clips must be next to each other';
    if (main.clips.some((c) => !set.has(c.id) && c.start < end && clipEnd(c) > start)) return 'Another main-track clip is inside the selection';
  }
  return null;
}

/**
 * ⌥G: moves the clips (and the audio linked to them) into a new sequence, relative timing kept,
 * and puts ONE compound clip at the earliest start: on the main track when main-track clips are
 * selected (in their slot, so the magnetic main track stays packed), else on the topmost selected
 * visual track when it is free there, else on a new overlay track right above it. Transitions
 * between two selected clips go along; the others are dropped. Returns the compound clip id.
 */
export function createCompound(p: Project, clipIds: readonly Id[], _ctx: EditCtx): Id | null {
  if (compoundBlocker(p, clipIds)) return null;
  const ids = new Set(withLinked(p, clipIds));
  const found = [...ids].map((id) => findClip(p, id)!);
  const E = Math.min(...found.map((f) => f.clip.start));
  const L = Math.max(...found.map((f) => clipEnd(f.clip)));
  const main = mainTrack(p);
  const hasMain = found.some((f) => f.track.id === main.id);

  // ---- the nested timeline: one track per source track (same id: the round trip restores them)
  const seqId = newId('seq');
  const name = nextCompoundName(p);
  const origin: Record<Id, number> = {};
  const nested: Track[] = [];
  p.tracks.forEach((t, index) => {
    const mine = t.clips.filter((c) => ids.has(c.id));
    if (t.kind !== 'main' && !mine.length) return;
    origin[t.id] = index;
    const clips = mine.map((c) => {
      const copy = plain(c) as Clip;
      copy.start = c.start - E;
      return copy;
    });
    const transitions = t.transitions.filter((tr) => ids.has(tr.fromClipId) && ids.has(tr.toClipId)).map(plain);
    nested.push({ id: t.id, kind: t.kind, name: t.name, locked: false, hidden: t.hidden, muted: t.muted, clips, transitions });
  });

  // where the compound goes (decided before the clips leave: z-order of the topmost selected track)
  let target: Track | null = null;
  if (hasMain) target = main;
  else {
    const visualIdx = found.filter((f) => f.track.kind !== 'audio').map((f) => p.tracks.indexOf(f.track));
    const top = visualIdx.length ? p.tracks[Math.max(...visualIdx)]! : null;
    const freeAfter = (t: Track) => t.clips.every((c) => ids.has(c.id) || clipEnd(c) <= E || c.start >= L);
    if (top && top.kind === 'overlay' && freeAfter(top)) target = top;
    else {
      const t = createTrack('overlay');
      const at = top ? p.tracks.indexOf(top) + 1 : p.tracks.length;
      p.tracks.splice(at, 0, t);
      target = p.tracks[at]!;
    }
  }

  // ---- the compound takes their place; then the clips leave the timeline
  const clip = createCompoundClip(seqId, name, target.id, E, L - E);
  for (const t of p.tracks) {
    retain(t.clips, (c) => !ids.has(c.id));
    retain(t.transitions, (tr) => !ids.has(tr.fromClipId) && !ids.has(tr.toClipId));
  }
  target.clips.push(clip);
  target.clips.sort((a, b) => a.start - b.start);
  removeEmptyTracks(p);

  if (!p.sequences) p.sequences = {};
  p.sequences[seqId] = { id: seqId, name, tracks: nested, duration: L - E, createdAt: Date.now(), origin };
  return clip.id;
}

/**
 * ⌥⇧G "Undo compound": the compound clip is replaced by the clips of its window of the sequence,
 * at the same times: main-track clips back on the main track (when the compound is there), the
 * other tracks back on the track they came from when it still exists and is free, else on a
 * recreated track at its old position. The last instance of a sequence takes the sequence with it
 * (its clips keep their ids); while other instances remain, the clips are copies with new ids.
 * Returns the ids of the restored clips.
 */
export function ungroupCompound(p: Project, clipId: Id, ctx: EditCtx): Id[] {
  const f = findClip(p, clipId);
  if (!f || f.track.locked || f.clip.type !== 'compound') return [];
  const comp = f.clip;
  const seq = sequencesOf(p)[comp.sequenceId];
  const tracks = sequenceTracks(p, comp.sequenceId);
  if (!seq || !tracks) return [];
  const I = comp.inPoint;
  const D = comp.duration;
  const shift = comp.start - I;
  const last = instancesOf(p, comp.sequenceId).length <= 1;
  const min = minClipUs(p);
  const hostIsMain = f.track.kind === 'main';
  const hostIndex = p.tracks.indexOf(f.track);
  f.track.clips.splice(f.index, 1);
  retain(f.track.transitions, (tr) => tr.fromClipId !== clipId && tr.toClipId !== clipId);

  const idMap = new Map<Id, Id>();
  const linkMap = new Map<Id, Id>();
  const out: Id[] = [];
  let inserted = 0;
  for (const nt of tracks) {
    // the clips of the window, trimmed to it, at timeline times
    const clips: Clip[] = [];
    for (const src of nt.clips) {
      if (clipEnd(src) <= I || src.start >= I + D) continue;
      let c = plain(src) as Clip;
      if (!last) {
        c.id = newId('clp');
        idMap.set(src.id, c.id);
        if ((c.type === 'video' || c.type === 'audio') && c.audioLink) {
          if (!linkMap.has(c.audioLink)) linkMap.set(c.audioLink, newId('lnk'));
          c.audioLink = linkMap.get(c.audioLink)!;
        }
      }
      if (c.start < I || clipEnd(c) > I + D) c = trimToWindow(p, c, I, I + D, min);
      c.start += shift;
      clips.push(c);
    }
    if (!clips.length) continue;
    const kind: TrackKind = nt.kind === 'main' && !hostIsMain ? 'overlay' : nt.kind;
    const s0 = Math.min(...clips.map((c) => c.start));
    const s1 = Math.max(...clips.map(clipEnd));
    let target: Track | undefined;
    if (kind === 'main') target = mainTrack(p);
    else {
      const same = p.tracks.find((t) => t.id === nt.id);
      if (same && same.kind === kind && !same.locked && isRangeFree(same, s0, s1)) target = same;
    }
    if (!target) {
      const t = createTrack(kind);
      if (!p.tracks.some((x) => x.id === nt.id)) t.id = nt.id;
      t.name = nt.name;
      t.hidden = nt.hidden;
      t.muted = nt.muted;
      const mainIdx = p.tracks.findIndex((x) => x.kind === 'main');
      const wanted = seq.origin?.[nt.id];
      let at: number;
      if (wanted !== undefined) at = wanted;
      else if (kind === 'audio') at = p.tracks.length;
      else at = hostIndex + 1 + inserted;
      if (kind !== 'audio') at = Math.max(mainIdx + 1, at);
      at = Math.min(Math.max(0, at), p.tracks.length);
      p.tracks.splice(at, 0, t);
      target = p.tracks[at]!;
      inserted++;
    }
    for (const c of clips) {
      c.trackId = target.id;
      target.clips.push(c);
      out.push(c.id);
    }
    target.clips.sort((a, b) => a.start - b.start);
    const ids = new Set(clips.map((c) => c.id));
    for (const tr of nt.transitions) {
      const from = idMap.get(tr.fromClipId) ?? tr.fromClipId;
      const to = idMap.get(tr.toClipId) ?? tr.toClipId;
      if (ids.has(from) && ids.has(to)) target.transitions.push({ ...plain(tr), id: last ? tr.id : newId('trn'), fromClipId: from, toClipId: to });
    }
  }
  if (last && p.sequences) delete p.sequences[comp.sequenceId];
  if (p.sequences && !Object.keys(p.sequences).length) delete p.sequences;
  removeEmptyTracks(p);
  void ctx;
  return out;
}

/** Trims a (plain) clip to the window [a, b) with the regular trim ops, on a scratch timeline. */
function trimToWindow(p: Project, c: Clip, a: Us, b: Us, _min: Us): Clip {
  const scratchTrack: Track = { ...createTrack(c.type === 'audio' ? 'audio' : c.type === 'text' ? 'text' : 'overlay'), clips: [c] };
  c.trackId = scratchTrack.id;
  const scratch: Project = { ...(isDraft(p) ? current(p) : p), tracks: [createTrack('main'), scratchTrack], focus: undefined };
  const ctx: EditCtx = { magnet: false };
  if (c.start < a) trimStart(scratch, c.id, a, ctx);
  if (clipEnd(c) > b) trimEnd(scratch, c.id, b, ctx);
  return c;
}

/**
 * Media › Subprojects: puts another instance of a sequence on the open timeline at `at` (main
 * track insert like a video clip; `kind: 'overlay'` → a free overlay track). Refused when that
 * would nest the sequence in itself. Returns the new clip id.
 */
export function addSequenceInstance(p: Project, sequenceId: Id, opts: { at: Us; kind?: 'main' | 'overlay'; trackId?: Id }, ctx: EditCtx): Id | null {
  const s = sequencesOf(p)[sequenceId];
  if (!s || !canPlaceSequence(p, sequenceId)) return null;
  const at = Math.max(0, Math.round(opts.at));
  const duration = Math.max(minClipUs(p), sequenceDuration(p, sequenceId) || tracksEnd(s.tracks));
  const explicit = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId && !t.locked && (t.kind === 'main' || t.kind === 'overlay')) : undefined;
  const clip = createCompoundClip(sequenceId, s.name, '', at, duration);
  const main = mainTrack(p);
  if ((explicit?.kind === 'main' || (!explicit && opts.kind !== 'overlay')) && !main.locked) {
    insertOnMain(p, clip, at, ctx);
    return clip.id;
  }
  let target = explicit && isRangeFree(explicit, at, at + duration) ? explicit : p.tracks.find((t) => t.kind === 'overlay' && !t.locked && isRangeFree(t, at, at + duration));
  if (!target) {
    const t = createTrack('overlay');
    p.tracks.push(t);
    target = p.tracks[p.tracks.length - 1]!;
  }
  clip.trackId = target.id;
  target.clips.push(clip);
  target.clips.sort((x, y) => x.start - y.start);
  return clip.id;
}

/** Renames a sequence and every instance still carrying its old name. */
export function renameSequence(p: Project, sequenceId: Id, name: string): boolean {
  const s = p.sequences?.[sequenceId];
  const n = name.trim();
  if (!s || !n || s.name === n) return false;
  const old = s.name;
  s.name = n;
  for (const t of p.tracks) for (const c of t.clips) if (c.type === 'compound' && c.sequenceId === sequenceId && c.name === old) c.name = n;
  return true;
}
