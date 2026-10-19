import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, mainTrack, timelineRows } from '../model/project';
import { clipEnd, secToUs } from '../model/time';
import type { Clip, MediaAsset, Project, VideoClip } from '../model/types';
import { selectCanRedo, selectCanUndo, selectSelectedClip, useEditor } from './index';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const clip = (id: string) => findClip(proj(), id)!.clip;
const main = () => mainTrack(proj());

function video(name: string, sec: number, hasAudio = true): MediaAsset {
  return createAsset({ kind: 'video', name, mime: 'video/mp4', size: 1, duration: S(sec), width: 1920, height: 1080, hasAudio });
}
const image = (name = 'img.png') => createAsset({ kind: 'image', name, mime: 'image/png', size: 1, duration: 0, width: 1000, height: 1000 });
const audio = (name = 'a.mp3', sec = 10) => createAsset({ kind: 'audio', name, mime: 'audio/mpeg', size: 1, duration: S(sec), hasAudio: true });

/** Invariants that must hold after every action. */
function checkInvariants(p: Project, magnet = st().magnet) {
  expect(p.tracks.filter((t) => t.kind === 'main')).toHaveLength(1);
  for (const t of p.tracks) {
    let end = 0;
    for (const c of t.clips) {
      expect(c.trackId).toBe(t.id);
      expect(Number.isInteger(c.start) && Number.isInteger(c.duration)).toBe(true);
      expect(c.start).toBeGreaterThanOrEqual(end);
      if (t.kind === 'main' && magnet) expect(c.start).toBe(end);
      end = clipEnd(c);
      if (c.type === 'video' || c.type === 'audio') {
        const a = p.assets[c.assetId]!;
        expect(c.inPoint).toBeGreaterThanOrEqual(0);
        expect(c.inPoint + c.duration * c.speed).toBeLessThanOrEqual(a.duration + 2);
      }
    }
    for (const tr of t.transitions) {
      const i = t.clips.findIndex((c) => c.id === tr.fromClipId);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(t.clips[i + 1]?.id).toBe(tr.toClipId);
      expect(clipEnd(t.clips[i]!)).toBe(t.clips[i + 1]!.start);
    }
  }
}

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, zoom: 60 });
});

describe('project', () => {
  it('defaults to 9:16 1080x1920 30fps with one main track', () => {
    expect(proj().settings).toMatchObject({ aspect: '9:16', width: 1080, height: 1920, fps: 30 });
    expect(proj().tracks.map((t) => t.kind)).toEqual(['main']);
  });
  it('switches aspect ratio (undoable)', () => {
    st().setAspectRatio('16:9');
    expect(proj().settings).toMatchObject({ width: 1920, height: 1080 });
    st().undo();
    expect(proj().settings.aspect).toBe('9:16');
  });
  it('renames', () => {
    st().setProjectName('  Shabbat  ');
    expect(proj().name).toBe('Shabbat');
  });
});

describe('media + addClip', () => {
  it('addAssets is not an undo step and assets survive undo', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    expect(selectCanUndo(st())).toBe(false);
    const id = st().addClip(a.id)!;
    st().undo();
    expect(findClip(proj(), id)).toBeUndefined();
    expect(proj().assets[a.id]).toBeDefined();
  });

  it('video goes on the main track, packed, at the playhead cut', () => {
    const a = video('a.mp4', 4);
    const b = video('b.mp4', 2);
    st().addAssets([a, b]);
    const c1 = st().addClip(a.id)!;
    const c2 = st().addClip(b.id, { at: 0 })!; // before the 4s clip (midpoint rule)
    expect(main().clips.map((c) => c.id)).toEqual([c2, c1]);
    expect(clip(c1).start).toBe(S(2));
    expect(selectSelectedClip(st())?.id).toBe(c2);
    st().setPlayhead(S(5));
    const c3 = st().addClip(b.id)!;
    expect(main().clips.at(-1)!.id).toBe(c3);
    checkInvariants(proj());
  });

  it('image = 5 s, audio → audio track, overlay → overlay track', () => {
    const img = image();
    const au = audio();
    const v = video('v.mp4', 3);
    st().addAssets([img, au, v]);
    const i = st().addClip(img.id)!;
    expect(clip(i).duration).toBe(S(5));
    const a = st().addClip(au.id, { at: S(1) })!;
    expect(findClip(proj(), a)!.track.kind).toBe('audio');
    expect(clip(a).start).toBe(S(1));
    const o = st().addClip(v.id, { kind: 'overlay', at: S(2) })!;
    expect(findClip(proj(), o)!.track.kind).toBe('overlay');
    // second overlay at an overlapping time gets its own track
    const o2 = st().addClip(v.id, { kind: 'overlay', at: S(3) })!;
    expect(findClip(proj(), o2)!.track.id).not.toBe(findClip(proj(), o)!.track.id);
    // timeline rows: overlays on top, main, then audio
    expect(timelineRows(proj()).map((t) => t.kind)).toEqual(['overlay', 'overlay', 'main', 'audio']);
    checkInvariants(proj());
  });

  it('text clip lands on a text track at the playhead', () => {
    st().setPlayhead(S(1));
    const t = st().addTextClip({ content: 'Hello' });
    const f = findClip(proj(), t)!;
    expect(f.track.kind).toBe('text');
    expect(f.clip.start).toBe(S(1));
    expect(f.clip.duration).toBe(S(3));
    expect(f.clip.type === 'text' && f.clip.text.content).toBe('Hello');
  });

  it('removeAsset removes its clips', () => {
    const a = video('a.mp4', 4);
    st().addAssets([a]);
    st().addClip(a.id);
    st().removeAsset(a.id);
    expect(main().clips).toHaveLength(0);
    expect(proj().assets[a.id]).toBeUndefined();
  });
});

function threeOnMain() {
  const a = video('a.mp4', 10);
  st().addAssets([a]);
  st().setPlayhead(0);
  const ids = [st().addClip(a.id, { at: 0 })!, st().addClip(a.id, { at: S(10) })!, st().addClip(a.id, { at: S(20) })!];
  useEditor.setState({ past: [], future: [] });
  return { asset: a, ids };
}

describe('split / delete / ripple', () => {
  it('splits at the playhead with correct in-points', () => {
    const { ids } = threeOnMain();
    st().select([ids[0]!]);
    st().setPlayhead(S(4));
    const [right] = st().splitAtPlayhead();
    const l = clip(ids[0]!) as VideoClip;
    const r = clip(right!) as VideoClip;
    expect(l.duration).toBe(S(4));
    expect(r.start).toBe(S(4));
    expect(r.duration).toBe(S(6));
    expect(r.inPoint).toBe(S(4));
    expect(main().clips).toHaveLength(4);
    checkInvariants(proj());
  });

  it('split with nothing selected cuts every clip under the playhead', () => {
    const { asset, ids } = threeOnMain();
    const o = st().addClip(asset.id, { kind: 'overlay', at: S(2) })!;
    st().clearSelection();
    st().setPlayhead(S(5));
    const made = st().splitAtPlayhead();
    expect(made).toHaveLength(2);
    expect(clip(o).duration).toBe(S(3));
    expect(clip(ids[0]!).duration).toBe(S(5));
  });

  it('split at the edge does nothing', () => {
    const { ids } = threeOnMain();
    st().select([ids[1]!]);
    st().setPlayhead(S(10));
    expect(st().splitAtPlayhead()).toEqual([]);
  });

  it('delete ripples the main track; undo restores', () => {
    const { ids } = threeOnMain();
    st().select([ids[0]!]);
    st().deleteSelected();
    expect(main().clips.map((c) => c.start)).toEqual([0, S(10)]);
    expect(st().selection.clipIds).toEqual([]);
    st().undo();
    expect(main().clips).toHaveLength(3);
    st().redo();
    expect(main().clips).toHaveLength(2);
    checkInvariants(proj());
  });

  it('delete leaves a gap when the magnet is off', () => {
    useEditor.setState({ magnet: false });
    const { ids } = threeOnMain();
    st().deleteClips([ids[1]!]);
    expect(main().clips.map((c) => c.start)).toEqual([0, S(20)]);
  });

  it('delete on overlay track removes the empty track', () => {
    const { asset } = threeOnMain();
    const o = st().addClip(asset.id, { kind: 'overlay', at: 0 })!;
    expect(proj().tracks).toHaveLength(2);
    st().deleteClips([o]);
    expect(proj().tracks).toHaveLength(1);
  });

  it('delete-left (Q) on the main track trims the start and moves the playhead to the cut', () => {
    const { ids } = threeOnMain();
    st().clearSelection();
    st().setPlayhead(S(13));
    st().deleteLeft();
    const c = clip(ids[1]!) as VideoClip;
    expect(c.start).toBe(S(10));
    expect(c.duration).toBe(S(7));
    expect(c.inPoint).toBe(S(3));
    expect(st().playhead).toBe(S(10));
    expect(clip(ids[2]!).start).toBe(S(17));
    checkInvariants(proj());
  });

  it('delete-right (W) trims the end', () => {
    const { ids } = threeOnMain();
    st().clearSelection();
    st().setPlayhead(S(13));
    st().deleteRight();
    expect(clip(ids[1]!).duration).toBe(S(3));
    expect(clip(ids[2]!).start).toBe(S(13));
  });

  it('delete-left on a selected overlay clip leaves the gap', () => {
    const { asset } = threeOnMain();
    const o = st().addClip(asset.id, { kind: 'overlay', at: S(2) })!;
    st().select([o]);
    st().setPlayhead(S(5));
    st().deleteLeft();
    expect(clip(o).start).toBe(S(5));
    expect(clip(o).duration).toBe(S(7));
  });
});

describe('trim', () => {
  it('cannot extend a video beyond its source', () => {
    const { ids } = threeOnMain();
    st().trimEnd(ids[0]!, S(50));
    expect(clip(ids[0]!).duration).toBe(S(10));
    st().trimStart(ids[0]!, S(-5));
    expect((clip(ids[0]!) as VideoClip).inPoint).toBe(0);
  });

  it('trimStart moves the in-point by speed', () => {
    const { ids } = threeOnMain();
    st().setSpeed(ids[1]!, 2); // 10s source → 5s on timeline, at 10..15
    expect(clip(ids[1]!).duration).toBe(S(5));
    st().trimStart(ids[1]!, S(11));
    const c = clip(ids[1]!) as VideoClip;
    expect(c.inPoint).toBe(S(2));
    expect(c.duration).toBe(S(4));
    expect(c.start).toBe(S(10)); // magnet keeps it packed
    checkInvariants(proj());
  });

  it('images trim freely; non-main tracks clamp to neighbours', () => {
    const img = image();
    st().addAssets([img]);
    const a = st().addClip(img.id, { kind: 'overlay', at: 0 })!;
    const trackId = findClip(proj(), a)!.track.id;
    const b = st().addClip(img.id, { trackId, at: S(6) })!;
    expect(findClip(proj(), b)!.track.id).toBe(trackId);
    st().trimEnd(a, S(20));
    expect(clipEnd(clip(a))).toBe(S(6));
    st().trimStart(b, S(1));
    expect(clip(b).start).toBe(S(6)); // a now ends at 6
    expect(clip(b).duration).toBe(S(5));
    checkInvariants(proj());
  });

  it('minimum length is one frame', () => {
    const { ids } = threeOnMain();
    st().trimEnd(ids[0]!, 0);
    expect(clip(ids[0]!).duration).toBe(Math.ceil(1e6 / 30));
  });
});

describe('move', () => {
  it('reorders on the main track', () => {
    const { ids } = threeOnMain();
    st().moveClip(ids[0]!, { start: S(25) });
    expect(main().clips.map((c) => c.id)).toEqual([ids[1], ids[2], ids[0]]);
    checkInvariants(proj());
  });

  it('moves between main and overlay; refuses incompatible tracks', () => {
    const { ids } = threeOnMain();
    const au = audio();
    st().addAssets([au]);
    const a = st().addClip(au.id, { at: 0 })!;
    const audioTrack = findClip(proj(), a)!.track.id;
    expect(st().moveClip(ids[0]!, { start: 0, trackId: audioTrack })).toBe(false);
    const ov = st().addTrack('overlay');
    expect(st().moveClip(ids[0]!, { start: S(3), trackId: ov })).toBe(true);
    expect(findClip(proj(), ids[0]!)!.track.kind).toBe('overlay');
    expect(clip(ids[0]!).start).toBe(S(3));
    expect(main().clips[0]!.start).toBe(0);
    checkInvariants(proj());
  });

  it('dropping onto an occupied spot creates a new track', () => {
    const img = image();
    st().addAssets([img]);
    const a = st().addClip(img.id, { kind: 'overlay', at: 0 })!;
    const b = st().addClip(img.id, { kind: 'overlay', at: S(10) })!;
    const t = findClip(proj(), a)!.track.id;
    expect(findClip(proj(), b)!.track.id).toBe(t);
    st().moveClip(b, { start: S(2) });
    expect(findClip(proj(), b)!.track.id).not.toBe(t);
    checkInvariants(proj());
  });

  it('a gesture transaction is one undo step; cancel restores', () => {
    const { ids } = threeOnMain();
    st().beginTx();
    st().moveClip(ids[0]!, { start: S(12) });
    st().moveClip(ids[0]!, { start: S(25) });
    st().commitTx();
    expect(st().past).toHaveLength(1);
    st().undo();
    expect(main().clips[0]!.id).toBe(ids[0]);
    st().beginTx();
    st().trimEnd(ids[0]!, S(2));
    st().cancelTx();
    expect(clip(ids[0]!).duration).toBe(S(10));
    expect(selectCanRedo(st())).toBe(true);
  });

  it('locked tracks refuse edits and selection', () => {
    const { ids } = threeOnMain();
    st().setTrack(main().id, { locked: true });
    expect(st().moveClip(ids[0]!, { start: S(25) })).toBe(false);
    st().deleteClips([ids[0]!]);
    expect(main().clips).toHaveLength(3);
    st().select([ids[0]!]);
    expect(st().selection.clipIds).toEqual([]);
  });
});

describe('speed / duration', () => {
  it('speed changes duration, keeps source span, ripples', () => {
    const { ids } = threeOnMain();
    st().setSpeed(ids[0]!, 0.5);
    expect(clip(ids[0]!).duration).toBe(S(20));
    expect(clip(ids[1]!).start).toBe(S(20));
    st().setSpeed(ids[0]!, 1000);
    expect((clip(ids[0]!) as VideoClip).speed).toBe(100);
    expect(clip(ids[0]!).duration).toBe(S(0.1));
  });
  it('setDuration back-computes speed for video, sets length for images', () => {
    const { ids } = threeOnMain();
    st().setDuration(ids[0]!, S(5));
    expect((clip(ids[0]!) as VideoClip).speed).toBe(2);
    const img = image();
    st().addAssets([img]);
    const i = st().addClip(img.id, { kind: 'overlay', at: 0 })!;
    st().setDuration(i, S(8));
    expect(clip(i).duration).toBe(S(8));
  });
  it('speed on an overlay pushes later clips on the same track', () => {
    const v = video('v.mp4', 4);
    st().addAssets([v]);
    const a = st().addClip(v.id, { kind: 'overlay', at: 0 })!;
    const trackId = findClip(proj(), a)!.track.id;
    const b = st().addClip(v.id, { trackId, at: S(4) })!;
    st().setSpeed(a, 0.5);
    expect(clip(b).start).toBe(S(8));
    checkInvariants(proj());
  });
});

describe('props', () => {
  it('updateClip merges nested objects and ignores fields the clip lacks', () => {
    const { ids } = threeOnMain();
    st().updateClip(ids[0]!, { transform: { x: 10, scale: 9 }, adjust: { contrast: 20 }, text: { content: 'x' }, audio: { volumeDb: -6 } });
    const c = clip(ids[0]!) as VideoClip;
    expect(c.transform).toMatchObject({ x: 10, y: 0, scale: 4, rotation: 0 });
    expect(c.adjust.contrast).toBe(20);
    expect(c.audio.volumeDb).toBe(-6);
    expect('text' in c).toBe(false);
  });
  it('updateClips is one undo step', () => {
    const { ids } = threeOnMain();
    st().updateClips(ids, { filter: { id: 'mono', intensity: 0.5 } });
    expect(ids.every((id) => (clip(id) as VideoClip).filter?.id === 'mono')).toBe(true);
    expect(st().past).toHaveLength(1);
  });
  it('text patch merges nested style and renames', () => {
    const t = st().addTextClip({ at: 0 });
    st().updateClip(t, { text: { content: 'Hi\nthere', stroke: { enabled: true } } });
    const c = clip(t);
    expect(c.type === 'text' && c.text.stroke).toMatchObject({ enabled: true, width: 6 });
    expect(c.name).toBe('Hi');
  });
  it('animations clamp to the clip; mirror and rotate', () => {
    const { ids } = threeOnMain();
    st().setAnimation(ids[0]!, 'in', 'fade', S(30));
    st().setAnimation(ids[0]!, 'out', 'zoom-in', S(1));
    const c = clip(ids[0]!) as VideoClip;
    // In + Out never exceed the clip: the slot edited last wins, the other one shrinks
    expect(c.animationIn).toEqual({ type: 'fade', duration: S(9) });
    expect(c.animationOut).toEqual({ type: 'zoom-in', duration: S(1) });
    st().select([ids[0]!]);
    st().mirrorSelected();
    st().rotateSelected();
    st().rotateSelected();
    st().rotateSelected();
    const d = clip(ids[0]!) as VideoClip;
    expect(d.transform.flipH).toBe(true);
    expect(d.transform.rotation).toBe(-90);
  });
  it('split keeps In on the left and Out on the right', () => {
    const { ids } = threeOnMain();
    st().setAnimation(ids[0]!, 'in', 'fade');
    st().setAnimation(ids[0]!, 'out', 'fade');
    st().updateClip(ids[0]!, { audio: { fadeIn: S(1), fadeOut: S(1) } });
    const r = st().splitClip(ids[0]!, S(5))!;
    const l = clip(ids[0]!) as VideoClip;
    const rr = clip(r) as VideoClip;
    expect(l.animationOut).toBeNull();
    expect(rr.animationIn).toBeNull();
    expect(rr.animationOut?.type).toBe('fade');
    expect(l.audio.fadeOut).toBe(0);
    expect(rr.audio.fadeIn).toBe(0);
  });
});

describe('duplicate', () => {
  it('duplicates after itself on the main track and selects the copy', () => {
    const { ids } = threeOnMain();
    st().select([ids[0]!]);
    const [copy] = st().duplicateSelected();
    expect(main().clips.map((c) => c.id)).toEqual([ids[0], copy, ids[1], ids[2]]);
    expect(st().selection.clipIds).toEqual([copy]);
    checkInvariants(proj());
  });
  it('duplicates on an overlay into free space or a new track', () => {
    const img = image();
    st().addAssets([img]);
    const a = st().addClip(img.id, { kind: 'overlay', at: 0 })!;
    const [b] = st().duplicateClips([a]);
    expect(clip(b!).start).toBe(S(5));
    expect(findClip(proj(), b!)!.track.id).toBe(findClip(proj(), a)!.track.id);
  });
});

describe('selection', () => {
  it('replace / add / toggle / all / clear', () => {
    const { ids } = threeOnMain();
    st().select([ids[0]!]);
    st().select([ids[1]!], 'add');
    expect(st().selection.clipIds).toEqual([ids[0], ids[1]]);
    st().select([ids[0]!], 'toggle');
    expect(st().selection.clipIds).toEqual([ids[1]]);
    st().selectAll();
    expect(st().selection.clipIds).toHaveLength(3);
    expect(selectSelectedClip(st())).toBeNull();
    st().clearSelection();
    expect(st().selection.clipIds).toEqual([]);
  });
  it('selection is not undoable; undo prunes vanished ids', () => {
    const { asset } = threeOnMain();
    const n = st().addClip(asset.id, { at: S(100) })!;
    st().select([n]);
    st().undo();
    expect(st().selection.clipIds).toEqual([]);
  });
});

describe('transitions', () => {
  it('adds between adjacent clips, clamps duration, replaces on the same cut', () => {
    const { ids } = threeOnMain();
    const t = st().addTransition(ids[0]!, 'mix')!;
    expect(main().transitions).toHaveLength(1);
    expect(main().transitions[0]).toMatchObject({ fromClipId: ids[0], toClipId: ids[1], duration: S(0.5) });
    expect(st().selection.transitionId).toBe(t);
    st().updateTransition(t, { duration: S(30) });
    expect(main().transitions[0]!.duration).toBe(S(5));
    expect(st().addTransition(ids[0]!, 'zoom')).toBe(t);
    expect(main().transitions[0]!.type).toBe('zoom');
    expect(st().addTransition(ids[2]!, 'mix')).toBeNull(); // last clip has no neighbour
  });
  it('is pruned when clips stop being adjacent; follows a split', () => {
    const { ids } = threeOnMain();
    st().addTransition(ids[0]!, 'mix');
    const r = st().splitClip(ids[0]!, S(5))!;
    expect(main().transitions[0]!.fromClipId).toBe(r);
    st().deleteClips([ids[1]!]);
    // r is now adjacent to ids[2]; the old transition pointed at ids[1] → pruned
    expect(main().transitions).toHaveLength(0);
    checkInvariants(proj());
  });
  it('apply to all and remove', () => {
    const { ids } = threeOnMain();
    const t = st().addTransition(ids[0]!, 'wipe-left', S(1))!;
    st().applyTransitionToAll(t);
    expect(main().transitions).toHaveLength(2);
    expect(main().transitions.every((x) => x.type === 'wipe-left' && x.duration === S(1))).toBe(true);
    st().selectTransition(t);
    st().deleteSelected();
    expect(main().transitions).toHaveLength(1);
  });
  it('magnet off: moving a clip away breaks the transition', () => {
    useEditor.setState({ magnet: false });
    const { ids } = threeOnMain();
    st().addTransition(ids[0]!, 'mix');
    st().moveClip(ids[1]!, { start: S(40) });
    expect(main().transitions).toHaveLength(0);
  });
});

describe('tracks + markers', () => {
  it('lock / hide / mute and remove', () => {
    const id = st().addTrack('text');
    st().setTrack(id, { hidden: true, muted: true });
    expect(proj().tracks.find((t) => t.id === id)).toMatchObject({ hidden: true, muted: true });
    st().removeTrack(id);
    expect(proj().tracks.find((t) => t.id === id)).toBeUndefined();
    st().removeTrack(main().id);
    expect(proj().tracks).toHaveLength(1);
  });
  it('markers snap to frames and do not duplicate', () => {
    st().setPlayhead(S(1) + 5000);
    const m = st().addMarker();
    expect(proj().markers[0]!.time).toBe(S(1));
    expect(st().addMarker(S(1))).toBe(m);
    st().removeMarker(m);
    expect(proj().markers).toHaveLength(0);
  });
});

describe('playback + view state', () => {
  it('playhead / frames / edits are not undoable', () => {
    threeOnMain();
    st().setPlayhead(S(1));
    st().stepFrames(3);
    expect(st().playhead).toBe(S(1) + 100000);
    st().goToNextEdit();
    expect(st().playhead).toBe(S(10));
    st().goToPrevEdit();
    expect(st().playhead).toBe(0);
    st().stepFrames(-5);
    expect(st().playhead).toBe(0);
    expect(selectCanUndo(st())).toBe(false);
  });
  it('play restarts from 0 at the end; empty project does not play', () => {
    st().play();
    expect(st().playing).toBe(false);
    threeOnMain();
    st().setPlayhead(S(30));
    st().togglePlay();
    expect(st()).toMatchObject({ playing: true, playhead: 0 });
    st().togglePlay();
    expect(st().playing).toBe(false);
  });
  it('zoom clamps; magnet on re-packs', () => {
    st().setZoom(10000);
    expect(st().zoom).toBe(600);
    st().zoomOut();
    expect(st().zoom).toBe(480);
    useEditor.setState({ magnet: false });
    const { ids } = threeOnMain();
    st().deleteClips([ids[0]!]);
    expect(main().clips[0]!.start).toBe(S(10));
    st().setMagnet(true);
    expect(main().clips[0]!.start).toBe(0);
  });
});

describe('random op sequences keep invariants', () => {
  it('fuzz', () => {
    const v = video('v.mp4', 6);
    const img = image();
    const au = audio('a.mp3', 8);
    st().addAssets([v, img, au]);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rnd() * xs.length)];
    for (let i = 0; i < 400; i++) {
      const clips: Clip[] = proj().tracks.flatMap((t) => t.clips);
      const c = pick(clips);
      const t = Math.round(rnd() * S(30));
      const r = rnd();
      if (r < 0.2 || !c) st().addClip(pick([v.id, img.id, au.id])!, { at: t, kind: rnd() < 0.5 ? 'main' : 'overlay' });
      else if (r < 0.3) st().splitClip(c.id, t);
      else if (r < 0.4) st().moveClip(c.id, { start: t, trackId: pick(proj().tracks)!.id });
      else if (r < 0.5) st().trimStart(c.id, t);
      else if (r < 0.6) st().trimEnd(c.id, t);
      else if (r < 0.65) st().setSpeed(c.id, 0.2 + rnd() * 5);
      else if (r < 0.7) st().deleteClips([c.id]);
      else if (r < 0.75) st().addTransition(c.id, 'mix', S(rnd() * 3));
      else if (r < 0.8) st().duplicateClips([c.id]);
      else if (r < 0.85) st().undo();
      else if (r < 0.9) st().redo();
      else if (r < 0.95) st().setMagnet(rnd() < 0.7);
      else {
        st().setPlayhead(t);
        st().select([c.id]);
        if (rnd() < 0.5) st().deleteLeft();
        else st().deleteRight();
      }
      checkInvariants(proj());
    }
  });
});
