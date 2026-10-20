import { beforeEach, describe, expect, it } from 'vitest';
import { addSubproject, closeCompoundTo, compoundMenuItem, createCompoundClip, openCompound, undoCompoundClips } from '../actions/compound';
import { getFrameState, mediaOpsDeep, type AudioOp, type MediaDrawOp } from '../engine/frameState';
import { planMix } from '../export/offlineMix';
import { breadcrumb, focusedSequenceId, instancesOf, MAX_COMPOUND_DEPTH, rootProject, sequencesOf } from '../model/compound';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack, migrateProject } from '../model/project';
import { clipEnd, secToUs } from '../model/time';
import type { CompoundClip, MediaAsset, Project } from '../model/types';
import { slots } from '../timeline/contextMenu/registry';
import { useEditor } from './index';
import { createCompoundClip as makeCompound } from './compoundOps';
import { projectViolations } from './invariants';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const video = (name: string, sec: number): MediaAsset =>
  createAsset({ kind: 'video', name, mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio: true });
const audio = (sec: number) => createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(sec), hasAudio: true });
const clean = (p: Project = proj()) => expect(projectViolations(p, { magnet: st().magnet, selection: st().selection.clipIds })).toEqual([]);
/** The document without its edit timestamp (create + ungroup keep every id, so nothing else differs). */
const doc = (p: Project) => JSON.parse(JSON.stringify({ ...p, updatedAt: 0 }));

/** main A(0-3) B(3-7) C(7-9) · overlay X(4-6) over B · audio M(3.5-6) · text T(5-6). */
function setup() {
  const v = video('v.mp4', 20);
  const a = audio(20);
  st().addAssets([v, a]);
  const A = st().addClip(v.id, { at: 0 })!;
  st().trimEnd(A, S(3));
  const B = st().addClip(v.id, { at: S(3) })!;
  st().trimStart(B, S(3) + S(1)); // inPoint 1 s; magnet repacks to start 3
  st().trimEnd(B, S(7));
  const C = st().addClip(v.id, { at: S(7) })!;
  st().trimEnd(C, S(9));
  const X = st().addClip(v.id, { kind: 'overlay', at: S(4) })!;
  st().trimEnd(X, S(6));
  st().updateClip(X, { transform: { scale: 0.5, x: 100 }, blend: 'screen' });
  const M = st().addClip(a.id, { at: S(3.5) })!;
  st().trimEnd(M, S(6));
  st().updateClip(M, { audio: { volumeDb: -6, fadeIn: S(0.5) } });
  const T = st().addTextClip({ at: S(5) });
  st().trimEnd(T, S(6));
  return { A, B, C, X, M, T };
}

const strip = (o: MediaDrawOp) => ({ ...o, clipId: o.clipId.split('/').pop(), layer: 0, trackId: '' });
const stripA = (o: AudioOp) => ({ ...o, clipId: o.clipId.split('/').pop(), trackId: '' });

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, linkage: true });
});

describe('create compound clip (⌥G)', () => {
  it('replaces the clips with one compound clip in the main-track slot, one undo step', () => {
    const { A, B, C, X, M } = setup();
    const before = proj();
    const steps = st().past.length;
    const id = createCompoundClip([B, X, M])!;
    expect(id).toBeTruthy();
    expect(st().past.length).toBe(steps + 1);
    const c = findClip(proj(), id)!.clip as CompoundClip;
    expect(c).toMatchObject({ type: 'compound', start: S(3), duration: S(4), inPoint: 0 });
    expect(mainTrack(proj()).clips.map((x) => x.id)).toEqual([A, id, C]);
    // the overlay and audio tracks emptied → removed; the text track stays
    expect(proj().tracks.map((t) => t.kind)).toEqual(['main', 'text']);
    const seq = sequencesOf(proj())[c.sequenceId]!;
    expect(seq.name).toBe('Compound 1');
    expect(seq.duration).toBe(S(4));
    const nestedX = seq.tracks.flatMap((t) => t.clips).find((x) => x.id === X)!;
    expect(nestedX.start).toBe(S(1));
    expect(st().selection.clipIds).toEqual([id]);
    clean();
    st().undo();
    expect(proj()).toBe(before);
    st().redo();
    expect(findClip(proj(), id)?.clip.type).toBe('compound');
  });

  it('create + undo compound restores the project JSON exactly (same ids, tracks back in place)', () => {
    const { B, X, M, T } = setup();
    const before = doc(proj());
    const id = createCompoundClip([B, X, M, T])!;
    clean();
    const restored = undoCompoundClips([id]);
    expect(new Set(restored)).toEqual(new Set([B, X, M, T]));
    expect(doc(proj())).toEqual(before);
    clean();
  });

  it('overlay-only selection: the compound stays on that overlay track; round trip is exact', () => {
    const { X, T } = setup();
    const before = doc(proj());
    const id = createCompoundClip([X, T])!;
    const f = findClip(proj(), id)!;
    expect(f.track.kind).toBe('overlay');
    expect(f.clip.start).toBe(S(4));
    expect(f.clip.duration).toBe(S(2));
    clean();
    undoCompoundClips([id]);
    expect(doc(proj())).toEqual(before);
  });

  it('refuses a selection that would break the magnetic main track', () => {
    const { A, C, B } = setup();
    expect(createCompoundClip([A, C])).toBeNull(); // not adjacent: B sits between them
    expect(compoundMenuItem.disabled!({ clipIds: [A, C], primaryId: A, trackId: '', time: 0 })).toBe(true);
    expect(compoundMenuItem.disabled!({ clipIds: [A, B], primaryId: A, trackId: '', time: 0 })).toBe(false);
  });

  it('registers the menu slot; label and action follow the selection', () => {
    const { A, B } = setup();
    expect(slots.compound).toBe(compoundMenuItem);
    st().select([A, B]);
    expect(compoundMenuItem.label).toBe('Create compound clip (subproject)');
    expect(compoundMenuItem.shortcut).toBe('compound');
    compoundMenuItem.run!({ clipIds: [A, B], primaryId: A, trackId: '', time: 0 });
    const id = st().selection.clipIds[0]!;
    expect(findClip(proj(), id)?.clip.type).toBe('compound');
    expect(compoundMenuItem.label).toBe('Undo compound clip');
    expect(compoundMenuItem.shortcut).toBe('undoCompound');
    compoundMenuItem.run!({ clipIds: [id], primaryId: id, trackId: '', time: 0 });
    expect(findClip(proj(), A)).toBeTruthy();
  });
});

describe('render: nested frame state', () => {
  it('draws and sounds exactly like the clips did on the timeline', () => {
    const { B, X, M, T } = setup();
    const times = [0, S(3), S(3.6), S(4.5), S(5.2), S(6.9), S(7.5)];
    const before = times.map((t) => getFrameState(proj(), t));
    const id = createCompoundClip([B, X, M, T])!;
    times.forEach((t, i) => {
      const fs = getFrameState(proj(), t);
      expect(mediaOpsDeep(fs.ops).map(strip)).toEqual(mediaOpsDeep(before[i]!.ops).map(strip));
      expect(fs.audio.map(stripA).sort((a, b) => a.assetId.localeCompare(b.assetId))).toEqual(before[i]!.audio.map(stripA).sort((a, b) => a.assetId.localeCompare(b.assetId)));
    });
    // at 4.5 s the compound op wraps B and X, with the compound's own (neutral) transform
    const op = getFrameState(proj(), S(4.5)).ops.find((o) => o.kind === 'media' && o.nested) as MediaDrawOp;
    expect(op.clipId).toBe(id);
    expect(op.nested!.t).toBe(S(1.5));
    expect(op.nested!.ops.map((o) => (o.kind === 'fill' ? 'fill' : o.clipId))).toEqual([`${id}/${B}`, `${id}/${X}`]);
    expect(op).toMatchObject({ fitWidth: 1080, fitHeight: 1920, transform: { scale: 1, opacity: 1 } });
  });

  it('the compound transform / opacity / in-point wrap the nested result', () => {
    const { B, X } = setup();
    const id = createCompoundClip([B, X])!;
    st().updateClip(id, { transform: { opacity: 0.5, x: 40 } });
    st().trimStart(id, S(4)); // in-point 1 s
    const c = findClip(proj(), id)!.clip as CompoundClip;
    expect(c).toMatchObject({ start: S(3), inPoint: S(1), duration: S(3) });
    const op = getFrameState(proj(), S(3.5)).ops.find((o) => o.kind === 'media' && o.nested) as MediaDrawOp;
    expect(op.transform).toMatchObject({ opacity: 0.5, x: 40 });
    expect(op.nested!.t).toBe(S(1.5)); // in-point + 0.5 s
    clean();
  });

  it('export mix plans the nested audio like the timeline audio', () => {
    const { B, M } = setup();
    const before = planMix(proj()).map((c) => ({ ...c, clipId: '' }));
    createCompoundClip([B, M]);
    const after = planMix(proj()).map((c) => ({ ...c, clipId: '' }));
    expect(after.sort((a, b) => a.startSec - b.startSec)).toEqual(before.sort((a, b) => a.startSec - b.startSec));
  });

  it('cycle guard and depth limit: a sequence that contains itself draws nothing and does not hang', () => {
    const { B } = setup();
    const id = createCompoundClip([B])!;
    const seqId = (findClip(proj(), id)!.clip as CompoundClip).sequenceId;
    // corrupt the document by hand: put an instance of the sequence inside itself
    const p = structuredClone(proj());
    const seq = p.sequences![seqId]!;
    const self = makeCompound(seqId, 'loop', seq.tracks[0]!.id, S(4), S(1));
    seq.tracks[0]!.clips.push(self);
    expect(projectViolations(p, { magnet: false }).some((v) => v.includes('contains itself'))).toBe(true);
    const fs = getFrameState(p, S(3) + S(0.5));
    expect(mediaOpsDeep(fs.ops)).toHaveLength(1); // B, once
    const deep = getFrameState(p, S(3) + S(4) - 1);
    expect(deep.ops).toBeTruthy();
    expect(MAX_COMPOUND_DEPTH).toBeGreaterThan(1);
  });
});

describe('nested editing', () => {
  it('opens with a breadcrumb, edits inside change every instance, closes back', () => {
    const { B, X } = setup();
    const id = createCompoundClip([B, X])!;
    const seqId = (findClip(proj(), id)!.clip as CompoundClip).sequenceId;
    const second = addSubproject(seqId, { at: S(100) })!; // end of the main track
    expect(instancesOf(proj(), seqId)).toHaveLength(2);
    clean();

    st().setPlayhead(S(4));
    expect(openCompound(id)).toBe(true);
    expect(focusedSequenceId(proj())).toBe(seqId);
    expect(breadcrumb(proj()).map((b) => b.name)).toEqual(['Main', 'Compound 1']);
    expect(st().playhead).toBe(S(1));
    expect(mainTrack(proj()).clips.map((c) => c.id)).toEqual([B]);
    clean();
    // the media panel cannot nest the open sequence in itself
    expect(addSubproject(seqId)).toBeNull();
    // edit inside: B gets shorter (4 s → 2 s); X still ends at 3 s
    st().trimEnd(B, S(2));
    clean();
    // an undo inside the compound stays inside
    st().undo();
    expect(focusedSequenceId(proj())).toBe(seqId);
    st().redo();

    closeCompoundTo(0);
    expect(focusedSequenceId(proj())).toBeNull();
    expect(st().selection.clipIds).toEqual([id]);
    const seq = sequencesOf(proj())[seqId]!;
    expect(seq.duration).toBe(S(3)); // content end = X's end
    for (const c of instancesOf(proj(), seqId)) expect(c.duration).toBe(S(3));
    clean();
    // both instances show the edited sequence
    const sec = findClip(proj(), second)!.clip;
    const at = (t: number) => mediaOpsDeep(getFrameState(proj(), t).ops).map((o) => o.clipId.split('/').pop());
    expect(at(S(3) + S(2.5))).toEqual([X]); // B now ends at 2 s inside
    expect(at(sec.start + S(2.5))).toEqual([X]);
    expect(at(sec.start + S(0.5))).toEqual([B]);
  });

  it('a document saved while a compound is open loads (and exports) on the main timeline', () => {
    const { B } = setup();
    const id = createCompoundClip([B])!;
    openCompound(id);
    const saved = proj();
    expect(saved.focus).toHaveLength(1);
    const root = rootProject(saved);
    expect(root.focus).toBeUndefined();
    expect(findClip(root, id)).toBeTruthy();
    expect(migrateProject(saved).focus).toBeUndefined();
    clean(root);
    closeCompoundTo(0);
  });

  it('ungroup of a trimmed instance restores only its window; other instances keep the sequence', () => {
    const { B, X } = setup();
    const id = createCompoundClip([B, X])!;
    const seqId = (findClip(proj(), id)!.clip as CompoundClip).sequenceId;
    const other = addSubproject(seqId, { kind: 'overlay', at: S(20) })!;
    st().trimStart(id, S(4.5)); // window [1.5 s, 4 s) of the sequence
    const out = undoCompoundClips([id]);
    expect(out).toHaveLength(2);
    expect(out).not.toContain(B); // copies: the sequence still has another instance
    const clips = out.map((x) => findClip(proj(), x)!.clip);
    const b = clips.find((c) => c.type === 'video' && findClip(proj(), c.id)!.track.kind === 'main')!;
    expect(b.start).toBe(S(3)); // magnet: packed into the old slot
    expect(clipEnd(b) - b.start).toBe(S(2.5));
    expect(b.type === 'video' && b.inPoint).toBe(S(1) + S(1.5));
    expect(findClip(proj(), other)).toBeTruthy();
    expect(sequencesOf(proj())[seqId]).toBeTruthy();
    clean();
  });
});
