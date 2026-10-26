/**
 * Property / fuzz test of the editing model: random sequences of 200 edits through the real store
 * actions. After EVERY step:
 *   - the project invariants hold (src/store/invariants.ts: no overlaps, no gaps on the magnetic
 *     main track, durations ≥ 1 frame, nothing past the media end, no orphan transitions, no
 *     dangling audioLink, selection valid …);
 *   - when the step made an undo entry, undo restores the exact previous project (deep-equal JSON)
 *     and redo restores the exact result.
 * At the end, undo-all goes back to the starting project exactly, and redo-all comes back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TRANSITIONS } from '../model/catalog';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { Clip, MediaAsset, TransitionType } from '../model/types';
import { getFrameState } from '../engine/frameState';
import { planMix } from '../export/offlineMix';
import { useEditor } from './index';
import { projectViolations } from './invariants';

const S = secToUs;
const st = () => useEditor.getState();
const json = () => JSON.stringify(st().project);
/** The document without its `updatedAt` stamp (to tell a real change from an empty undo step). */
const doc = () => JSON.stringify({ ...st().project, updatedAt: 0 });

/** mulberry32: small seeded PRNG so a failure can be replayed by its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(next() * xs.length)] : undefined),
    chance: (p: number) => next() < p,
  };
}

function assets(): MediaAsset[] {
  return [
    createAsset({ kind: 'video', name: 'v5.mp4', mime: 'video/mp4', size: 1, duration: S(5), width: 1080, height: 1920, hasAudio: true }),
    createAsset({ kind: 'video', name: 'v3.333.mp4', mime: 'video/mp4', size: 1, duration: 3_333_333, width: 1920, height: 1080, hasAudio: true }),
    createAsset({ kind: 'video', name: 'silent.mp4', mime: 'video/mp4', size: 1, duration: S(3), width: 1080, height: 1920, hasAudio: false }),
    createAsset({ kind: 'image', name: 'img.png', mime: 'image/png', size: 1, duration: 0, width: 1000, height: 1000 }),
    createAsset({ kind: 'audio', name: 'tone.mp3', mime: 'audio/mpeg', size: 1, duration: 6_000_017, hasAudio: true }),
  ];
}

const allClips = (): Clip[] => st().project.tracks.flatMap((t) => t.clips);
const TYPES = TRANSITIONS.map((t) => t.id as TransitionType);

type Step = { name: string; run: () => void };

function steps(r: ReturnType<typeof rng>, assetIds: string[]): Step[] {
  const anyClip = () => r.pick(allClips());
  const time = () => r.int(0, S(25));
  const anyTrack = () => r.pick(st().project.tracks);
  const randomSel = () => {
    const cs = allClips();
    return cs.filter(() => r.chance(0.3)).map((c) => c.id);
  };
  return [
    { name: 'addClip', run: () => void st().addClip(r.pick(assetIds)!, { at: time(), kind: r.chance(0.3) ? 'overlay' : undefined }) },
    { name: 'addClip@track', run: () => void st().addClip(r.pick(assetIds)!, { at: time(), trackId: anyTrack()?.id }) },
    { name: 'addText', run: () => void st().addTextClip({ at: time() }) },
    {
      name: 'moveClip',
      run: () => {
        const c = anyClip();
        if (!c) return;
        const t = anyTrack();
        const nt = r.chance(0.2) ? (r.chance(0.5) ? 'above' : 'below') : undefined;
        st().moveClip(c.id, { start: Math.max(0, c.start + r.int(-S(6), S(6))), trackId: t?.id, newTrack: nt });
      },
    },
    { name: 'moveClips', run: () => void st().moveClips(randomSel(), r.int(-S(4), S(4)), r.int(-2, 2)) },
    {
      name: 'trimStart',
      run: () => {
        const c = anyClip();
        if (c) st().trimStart(c.id, c.start + r.int(-S(4), S(4)));
      },
    },
    {
      name: 'trimEnd',
      run: () => {
        const c = anyClip();
        if (c) st().trimEnd(c.id, c.start + c.duration + r.int(-S(4), S(4)));
      },
    },
    {
      name: 'gestureTrim',
      run: () => {
        // a live trim gesture: begin, several moves re-applied from the base, commit (one step)
        const c = anyClip();
        if (!c) return;
        const left = r.chance(0.5);
        st().beginTx();
        for (let i = 0; i < 4; i++) {
          st().cancelTx();
          st().beginTx();
          if (left) st().trimStart(c.id, c.start + r.int(-S(3), S(3)));
          else st().trimEnd(c.id, c.start + c.duration + r.int(-S(3), S(3)));
        }
        st().commitTx();
      },
    },
    {
      name: 'splitClip',
      run: () => {
        const c = anyClip();
        if (c) st().splitClip(c.id, c.start + r.int(0, c.duration));
      },
    },
    {
      name: 'splitAtPlayhead',
      run: () => {
        st().setPlayhead(time());
        st().select(randomSel());
        st().splitAtPlayhead();
      },
    },
    {
      name: 'splitAll',
      run: () => {
        st().setPlayhead(time());
        st().splitAllAtPlayhead();
      },
    },
    {
      name: 'deleteLeft',
      run: () => {
        st().setPlayhead(time());
        st().select(randomSel());
        st().deleteLeft();
      },
    },
    {
      name: 'deleteRight',
      run: () => {
        st().setPlayhead(time());
        st().select(randomSel());
        st().deleteRight();
      },
    },
    { name: 'deleteClips', run: () => st().deleteClips(randomSel()) },
    {
      name: 'deleteSelected',
      run: () => {
        st().select(randomSel());
        st().deleteSelected();
      },
    },
    { name: 'duplicate', run: () => void st().duplicateClips(randomSel()) },
    {
      name: 'cut+paste',
      run: () => {
        const ids = randomSel();
        const snap = ids.map((id) => structuredClone(findClip(st().project, id)!.clip));
        if (r.chance(0.5)) st().deleteClips(ids);
        st().insertClips(snap, time());
      },
    },
    {
      name: 'setSpeed',
      run: () => {
        const c = anyClip();
        if (c) st().setSpeed(c.id, r.pick([0.1, 0.25, 0.37, 0.5, 1, 1.5, 2, 3, 7.7, 100])!);
      },
    },
    {
      name: 'setDuration',
      run: () => {
        const c = anyClip();
        if (c) st().setDuration(c.id, r.int(1, S(12)));
      },
    },
    { name: 'extract/restore', run: () => void st().toggleExtractAudio(randomSel()) },
    {
      name: 'fades/anim',
      run: () => {
        const c = anyClip();
        if (!c) return;
        st().updateClip(c.id, { audio: { fadeIn: r.int(0, S(3)), fadeOut: r.int(0, S(3)) } });
        st().setAnimation(c.id, r.chance(0.5) ? 'in' : 'out', r.chance(0.7) ? 'fade' : null, r.int(0, S(4)));
      },
    },
    {
      name: 'addTransition',
      run: () => {
        const c = anyClip();
        if (c) st().addTransition(c.id, r.pick(TYPES)!, r.int(1, S(3)));
      },
    },
    {
      name: 'updateTransition',
      run: () => {
        const tr = r.pick(st().project.tracks.flatMap((t) => t.transitions));
        if (tr) st().updateTransition(tr.id, { duration: r.int(1, S(4)), type: r.pick(TYPES) });
      },
    },
    {
      name: 'removeTransition',
      run: () => {
        const tr = r.pick(st().project.tracks.flatMap((t) => t.transitions));
        if (tr) st().removeTransition(tr.id);
      },
    },
    {
      name: 'applyTransitionToAll',
      run: () => {
        const tr = r.pick(st().project.tracks.flatMap((t) => t.transitions));
        if (tr) st().applyTransitionToAll(tr.id);
      },
    },
    {
      name: 'lock/hide/mute',
      run: () => {
        const t = anyTrack();
        if (!t) return;
        const k = r.pick(['locked', 'hidden', 'muted'] as const)!;
        st().setTrack(t.id, { [k]: !t[k] });
      },
    },
    { name: 'marker', run: () => void st().addMarker(time()) },
    {
      name: 'removeMarker',
      run: () => {
        const m = r.pick(st().project.markers);
        if (m) st().removeMarker(m.id);
      },
    },
    { name: 'magnet', run: () => st().setMagnet(!st().magnet) },
    { name: 'linkage', run: () => st().setLinkage(!st().linkage) },
    { name: 'mirror/rotate', run: () => (st().select(randomSel()), r.chance(0.5) ? st().mirrorSelected() : st().rotateSelected(90)) },
    { name: 'volume', run: () => void st().nudgeVolume(randomSel(), r.chance(0.5) ? 1 : -1) },
  ];
}

/** How often each kind of step actually changed the document (coverage of the fuzz itself). */
const effective = new Map<string, number>();

function check(label: string) {
  const v = projectViolations(st().project, { magnet: st().magnet, selection: st().selection.clipIds });
  if (v.length) throw new Error(`${label}\n  ${v.join('\n  ')}`);
}

function runSeed(seed: number, n = 200) {
  const r = rng(seed);
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true });
  const as = assets();
  st().addAssets(as);
  const ids = as.map((a) => a.id);
  const start = json();
  const list = steps(r, ids);
  const log: string[] = [];
  for (let i = 0; i < n; i++) {
    const step = r.pick(list)!;
    log.push(step.name);
    const before = json();
    const beforeDoc = doc();
    const past = st().past.length;
    const magnetBefore = st().magnet;
    step.run();
    const label = `seed ${seed} step ${i} (${step.name}); last steps: ${log.slice(-6).join(', ')}`;
    check(label);
    const made = st().past.length - past;
    if (made > 0) effective.set(step.name, (effective.get(step.name) ?? 0) + 1);
    // an undo step must change something (a refused / no-op edit must not leave an empty step)
    if (made > 0) expect(doc(), `empty undo step from ${label}`).not.toBe(beforeDoc);
    if (made > 0) {
      // the step's own undo entries (cut + paste are two, like in the app)
      const after = json();
      const magnetAfter = st().magnet;
      for (let k = 0; k < made; k++) st().undo();
      expect(json(), `undo of ${label}`).toBe(before);
      useEditor.setState({ magnet: magnetBefore });
      check(`after undo of ${label}`);
      for (let k = 0; k < made; k++) st().redo();
      expect(json(), `redo of ${label}`).toBe(after);
      useEditor.setState({ magnet: magnetAfter });
      check(`after redo of ${label}`);
    }
  }
  // undo everything: back to the exact starting document
  const end = json();
  const steps0 = st().past.length;
  expect(steps0).toBeLessThanOrEqual(200);
  while (st().past.length) st().undo();
  expect(json(), `seed ${seed}: undo-all`).toBe(start);
  for (let i = 0; i < steps0; i++) st().redo();
  expect(json(), `seed ${seed}: redo-all`).toBe(end);
}

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, linkage: true, zoom: 60 });
});

describe('fuzz: 200 random edits keep every invariant, undo/redo are exact', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => runSeed(seed));
  }
  it('every kind of edit really changed the document many times (the fuzz is not vacuous)', () => {
    const names = steps(rng(0), []).map((x) => x.name);
    for (const n of names.filter((x) => x !== 'linkage')) expect(effective.get(n) ?? 0, n).toBeGreaterThanOrEqual(10);
    // the run also produced transitions, links and locked tracks to break
    expect(effective.get("addTransition") ?? 0).toBeGreaterThan(25);
    expect(effective.get('extract/restore') ?? 0).toBeGreaterThan(50);
  });
});

// ====================================================================================
// Deterministic audit of every editing operation: exact model values, undo/redo deep-equal,
// and a regression test for every bug the audit found (docs/AUDIT-timeline.md).
// ====================================================================================

const A = {
  v5: () => createAsset({ kind: 'video', name: 'v5.mp4', mime: 'video/mp4', size: 1, duration: S(5), width: 1080, height: 1920, hasAudio: true }),
  v4: () => createAsset({ kind: 'video', name: 'v4.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: true }),
  v3: () => createAsset({ kind: 'video', name: 'v3.mp4', mime: 'video/mp4', size: 1, duration: S(3), width: 1080, height: 1920, hasAudio: true }),
  img: () => createAsset({ kind: 'image', name: 'i.png', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100 }),
  odd: () => createAsset({ kind: 'audio', name: 'odd.mp3', mime: 'audio/mpeg', size: 1, duration: 6_000_017, hasAudio: true }),
};
const clipOf = (id: string) => findClip(st().project, id)!;
const healthy = () => expect(projectViolations(st().project, { magnet: st().magnet, selection: st().selection.clipIds })).toEqual([]);
/** Runs `fn` as an edit and proves undo/redo restore the exact before/after documents. */
function undoable(fn: () => void) {
  const before = json();
  fn();
  const after = json();
  expect(after).not.toBe(before);
  st().undo();
  expect(json()).toBe(before);
  st().redo();
  expect(json()).toBe(after);
  healthy();
}
function setup(...as: MediaAsset[]) {
  st().addAssets(as);
  return as.map((a) => a.id);
}
const main = () => st().project.tracks.find((t) => t.kind === 'main')!;

describe('audit: split / delete left / delete right', () => {
  it('split at 2 s gives exact pieces, carries the transition to the right piece, one undo step', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    st().addTransition(a, 'mix', S(1));
    st().setPlayhead(S(2));
    st().clearSelection();
    undoable(() => st().splitAtPlayhead());
    const [p1, p2, p3] = main().clips;
    expect([p1!.start, p1!.duration, (p1 as any).inPoint]).toEqual([0, S(2), 0]);
    expect([p2!.start, p2!.duration, (p2 as any).inPoint]).toEqual([S(2), S(3), S(2)]);
    expect(p3!.id).toBe(b);
    expect(main().transitions).toEqual([expect.objectContaining({ fromClipId: p2!.id, toClipId: b, duration: S(1) })]);
  });
  it('split at a fractional speed never reads past the media end, however often it is split (was: +0.5 µs per split)', () => {
    const [odd] = setup(A.odd());
    const id = st().addClip(odd!, { at: 0 })!;
    st().setSpeed(id, 1 / 3);
    for (let i = 1; i <= 30; i++) {
      const last = st().project.tracks.find((t) => t.kind === 'audio')!.clips.at(-1)!;
      st().splitClip(last.id, last.start + Math.floor(last.duration / 2) + 7);
      healthy();
    }
  });
  it('Q with the magnet on: the left part goes, the clip keeps its slot, playhead to the cut', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    const b = st().addClip(v4!, { at: S(5) })!;
    st().clearSelection();
    st().setPlayhead(S(6));
    undoable(() => st().deleteLeft());
    expect(clipOf(b).clip).toMatchObject({ start: S(5), duration: S(3), inPoint: S(1) });
    expect(st().playhead).toBe(S(5));
  });
  it('Q with the magnet off leaves a gap where the left part was', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    const b = st().addClip(v4!, { at: S(5) })!;
    st().setMagnet(false);
    st().clearSelection();
    st().setPlayhead(S(6));
    undoable(() => st().deleteLeft());
    expect(clipOf(b).clip).toMatchObject({ start: S(6), duration: S(3), inPoint: S(1) });
    expect(st().playhead).toBe(S(6));
  });
  it('W removes the right part exactly', () => {
    const [v5] = setup(A.v5());
    const a = st().addClip(v5!, { at: 0 })!;
    st().setPlayhead(S(1.5));
    undoable(() => st().deleteRight());
    expect(clipOf(a).clip).toMatchObject({ start: 0, duration: S(1.5), inPoint: 0 });
  });
  it('REGRESSION: Q on a locked main track changes nothing and leaves the playhead alone (was: playhead jumped)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    st().addClip(v4!, { at: S(5) });
    st().setTrack(main().id, { locked: true });
    st().setPlayhead(S(6));
    const before = json();
    st().deleteLeft();
    st().deleteRight();
    expect(json()).toBe(before);
    expect(st().playhead).toBe(S(6));
  });
});

describe('audit: trim respects media length and speed', () => {
  it('right edge stops at the media end, scaled by speed', () => {
    const [v5] = setup(A.v5());
    const id = st().addClip(v5!, { at: 0, kind: 'overlay' })!;
    st().setSpeed(id, 2);
    expect(clipOf(id).clip.duration).toBe(S(2.5));
    undoable(() => st().trimEnd(id, S(2)));
    st().trimEnd(id, S(99));
    expect(clipOf(id).clip.duration).toBe(S(2.5));
  });
  it('left edge stops at the media start (in-point 0), scaled by speed', () => {
    const [v5] = setup(A.v5());
    st().setMagnet(false); // magnet on would ripple the overlay (start stays put)
    const id = st().addClip(v5!, { at: S(10), kind: 'overlay' })!;
    st().setSpeed(id, 2); // 10 s .. 12.5 s
    undoable(() => st().trimStart(id, S(11)));
    expect(clipOf(id).clip).toMatchObject({ start: S(11), duration: S(1.5), inPoint: S(2) });
    st().trimStart(id, 0);
    expect(clipOf(id).clip).toMatchObject({ start: S(10), duration: S(2.5), inPoint: 0 });
  });
  it('magnet off: an edge stops at the neighbour off the main track', () => {
    const [v3] = setup(A.v3());
    st().setMagnet(false);
    const a = st().addClip(v3!, { at: 0, kind: 'overlay' })!;
    st().trimEnd(a, S(2));
    const b = st().addClip(v3!, { at: S(2.5), trackId: clipOf(a).track.id })!;
    st().trimEnd(a, S(99));
    expect(clipOf(a).clip.duration).toBe(S(2.5));
    st().trimStart(b, 0);
    expect(clipOf(b).clip.start).toBe(S(2.5));
  });
  it('trimming on the magnetic main track ripples the next clips, never leaves a gap', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    undoable(() => st().trimEnd(a, S(3)));
    expect(clipOf(b).clip.start).toBe(S(3));
    undoable(() => st().trimStart(a, S(1)));
    expect(clipOf(a).clip).toMatchObject({ start: 0, duration: S(2), inPoint: S(1) });
    expect(clipOf(b).clip.start).toBe(S(2));
  });
  it('an image or text has no media limit', () => {
    const [img] = setup(A.img());
    const id = st().addClip(img!, { at: 0 })!;
    st().trimEnd(id, S(60));
    expect(clipOf(id).clip.duration).toBe(S(60));
  });
  it('REGRESSION: speed 3 on a 6.000017 s file no longer reads 1 µs past its end', () => {
    const [odd] = setup(A.odd());
    const id = st().addClip(odd!, { at: 0 })!;
    st().setSpeed(id, 3);
    const c = clipOf(id).clip as any;
    expect(c.duration * c.speed).toBeLessThanOrEqual(6_000_017);
    healthy();
  });
  it('REGRESSION: speed 100 on a 3 s clip no longer reads 3.33 s (one frame × 100 > the media)', () => {
    const [v3] = setup(A.v3());
    const id = st().addClip(v3!, { at: 0 })!;
    st().setSpeed(id, 100);
    const c = clipOf(id).clip as any;
    expect(c.inPoint + c.duration * c.speed).toBeLessThanOrEqual(S(3));
    expect(c.duration).toBe(33_334);
    healthy();
  });
});

describe('audit: move, tracks, ripple', () => {
  it('magnet on: reordering by drop; deleting ripples; magnet off: delete leaves the gap', () => {
    const [v5, v4, v3] = setup(A.v5(), A.v4(), A.v3());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    const c = st().addClip(v3!, { at: S(9) })!;
    undoable(() => st().moveClip(c, { start: 0 }));
    expect(main().clips.map((x) => x.id)).toEqual([c, a, b]);
    expect(main().clips.map((x) => x.start)).toEqual([0, S(3), S(8)]);
    undoable(() => st().deleteClips([a]));
    expect(main().clips.map((x) => x.start)).toEqual([0, S(3)]);
    st().undo();
    st().setMagnet(false);
    undoable(() => st().deleteClips([a]));
    expect(main().clips.map((x) => [x.id, x.start])).toEqual([
      [c, 0],
      [b, S(8)],
    ]);
  });
  it('a clip moved to a new track above / below lands there; emptied tracks disappear', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    const o = st().addClip(v4!, { at: S(1), kind: 'overlay' })!;
    const ov = clipOf(o).track.id;
    undoable(() => st().moveClip(o, { start: S(2), trackId: main().id, newTrack: 'above' }));
    const f = clipOf(o);
    expect(f.track.kind).toBe('overlay');
    expect(f.track.id).not.toBe(ov);
    expect(f.clip.start).toBe(S(2));
    expect(st().project.tracks.map((t) => t.kind)).toEqual(['main', 'overlay']);
  });
  it('a video cannot be dropped on an audio or text track', () => {
    const [v5, odd] = setup(A.v5(), A.odd());
    const v = st().addClip(v5!, { at: 0 })!;
    const au = st().addClip(odd!, { at: 0 })!;
    expect(st().moveClip(v, { start: 0, trackId: clipOf(au).track.id })).toBe(false);
    expect(clipOf(v).track.kind).toBe('main');
  });
  it('dropping onto an occupied overlay spot creates a new track instead of overlapping', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const o1 = st().addClip(v5!, { at: 0, kind: 'overlay' })!;
    const o2 = st().addClip(v4!, { at: S(10), kind: 'overlay' })!;
    expect(clipOf(o2).track.id).toBe(clipOf(o1).track.id);
    undoable(() => st().moveClip(o2, { start: S(1) }));
    expect(clipOf(o2).track.id).not.toBe(clipOf(o1).track.id);
    healthy();
  });
  it('multi-select move keeps relative offsets and moves rows together', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0, kind: 'overlay' })!;
    const b = st().addClip(v4!, { at: S(6), kind: 'overlay' })!;
    undoable(() => st().moveClips([a, b], S(2)));
    expect([clipOf(a).clip.start, clipOf(b).clip.start]).toEqual([S(2), S(8)]);
  });
});

describe('audit: copy / cut / paste / duplicate', () => {
  it('duplicate lands right after the original (main: inserted, ripples)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    let copies: string[] = [];
    undoable(() => (copies = st().duplicateClips([a])));
    expect(main().clips.map((x) => x.id)).toEqual([a, copies[0], b]);
    expect(clipOf(b).clip.start).toBe(S(10));
  });
  it('cut + paste at the playhead: a new id, same span, back on its own track at the playhead', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    const keep = st().addClip(v4!, { at: S(10), kind: 'overlay' })!;
    const o = st().addClip(v4!, { at: S(1), trackId: clipOf(keep).track.id })!;
    st().trimStart(o, S(1.5));
    const snap = structuredClone(clipOf(o).clip);
    st().deleteClips([o]);
    let out: string[] = [];
    undoable(() => (out = st().insertClips([snap], S(3))));
    expect(out[0]).not.toBe(o);
    expect(clipOf(out[0]!).clip).toMatchObject({ start: S(3), duration: S(3.5), inPoint: S(0.5) });
    expect(clipOf(out[0]!).track.id).toBe(clipOf(keep).track.id);
  });
  it('paste of a video whose track is gone goes to the main track (magnet: at the nearest cut)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().addClip(v5!, { at: 0 });
    const o = st().addClip(v4!, { at: S(1), kind: 'overlay' })!;
    const snap = structuredClone(clipOf(o).clip);
    st().deleteClips([o]);
    const [p] = st().insertClips([snap], S(3));
    expect(clipOf(p!).track.kind).toBe('main');
    expect(clipOf(p!).clip.start).toBe(S(5));
  });
  it('REGRESSION: a duplicated / pasted extracted video is not linked to the original audio', () => {
    const [v5] = setup(A.v5());
    const v = st().addClip(v5!, { at: 0 })!;
    st().toggleExtractAudio([v]);
    const [dup] = st().duplicateClips([v]);
    expect((clipOf(dup!).clip as any).audioLink).toBeUndefined();
    expect((clipOf(dup!).clip as any).audio.muted).toBe(true);
    const audioClip = st().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    const pasted = st().insertClips([structuredClone(clipOf(v).clip), structuredClone(audioClip)], S(20));
    const pv = clipOf(pasted[0]!).clip as any;
    const pa = clipOf(pasted[1]!).clip as any;
    expect(pv.audioLink).toBeTruthy();
    expect(pv.audioLink).toBe(pa.audioLink);
    expect(pv.audioLink).not.toBe((clipOf(v).clip as any).audioLink);
    healthy();
    // restoring the original only removes ITS audio
    st().toggleExtractAudio([v]);
    expect(clipOf(pasted[1]!)).toBeTruthy();
  });
});

describe('audit: extract / restore audio and linkage', () => {
  it('extract makes an exact audio copy and mutes the video; restore undoes it; both one undo step', () => {
    const [v5] = setup(A.v5());
    const v = st().addClip(v5!, { at: 0 })!;
    st().trimStart(v, S(1));
    undoable(() => st().toggleExtractAudio([v]));
    const au = st().project.tracks.find((t) => t.kind === 'audio')!.clips[0]! as any;
    expect(au).toMatchObject({ start: 0, duration: S(4), inPoint: S(1), speed: 1 });
    expect((clipOf(v).clip as any).audio.muted).toBe(true);
    undoable(() => st().toggleExtractAudio([v]));
    expect(st().project.tracks.some((t) => t.kind === 'audio')).toBe(false);
    expect((clipOf(v).clip as any).audio.muted).toBe(false);
  });
  it('REGRESSION: deleting the extracted audio leaves no dangling link; ⌘⇧S then extracts again', () => {
    const [v5] = setup(A.v5());
    const v = st().addClip(v5!, { at: 0 })!;
    st().toggleExtractAudio([v]);
    const au = st().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    st().deleteClips([au.id]);
    expect((clipOf(v).clip as any).audioLink).toBeUndefined();
    expect((clipOf(v).clip as any).audio.muted).toBe(true);
    healthy();
    const r = st().toggleExtractAudio([v]);
    expect(r.extracted).toHaveLength(1);
    healthy();
  });
  it('REGRESSION: deleting the video unlinks its extracted audio', () => {
    const [v5] = setup(A.v5());
    const v = st().addClip(v5!, { at: 0 })!;
    st().toggleExtractAudio([v]);
    st().deleteClips([v]);
    expect((st().project.tracks.find((t) => t.kind === 'audio')!.clips[0] as any).audioLink).toBeUndefined();
    healthy();
  });
  it('FIXED: linkage on — the extracted audio follows its video when it moves or ripples; off — it stays', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    st().toggleExtractAudio([b]);
    const audioOf = () => st().project.tracks.find((t) => t.kind === 'audio')!.clips[0]!;
    expect(audioOf().start).toBe(S(5));
    expect(st().linkage).toBe(true);
    undoable(() => st().deleteClips([a])); // ripple: b moves to 0
    expect(clipOf(b).clip.start).toBe(0);
    expect(audioOf().start).toBe(0);
    st().undo();
    undoable(() => st().moveClip(b, { start: 0 })); // reorder: b first
    expect(audioOf().start).toBe(0);
    st().undo();
    // a trim is not a move: the audio stays
    st().trimStart(b, S(6));
    expect(audioOf().start).toBe(S(5));
    st().undo();
    st().setLinkage(false);
    st().deleteClips([a]);
    expect(clipOf(b).clip.start).toBe(0);
    expect(audioOf().start).toBe(S(5));
  });
});

describe('audit: transitions', () => {
  it('add, change duration (clamped to half the shorter clip), change type, delete — orphan-free', () => {
    const [v5, v3] = setup(A.v5(), A.v3());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v3!, { at: S(5) })!;
    let id: string | null = null;
    undoable(() => (id = st().addTransition(a, 'mix')));
    expect(main().transitions).toEqual([expect.objectContaining({ fromClipId: a, toClipId: b, duration: S(0.5) })]);
    undoable(() => st().updateTransition(id!, { duration: S(9), type: 'zoom' }));
    expect(main().transitions[0]).toMatchObject({ duration: S(1.5), type: 'zoom' });
    undoable(() => st().removeTransition(id!));
    expect(main().transitions).toEqual([]);
    st().undo();
    st().deleteClips([b]);
    expect(main().transitions).toEqual([]);
  });
  it('no transition across a gap or on audio', () => {
    const [v5, v3, odd] = setup(A.v5(), A.v3(), A.odd());
    st().setMagnet(false);
    const a = st().addClip(v5!, { at: 0 })!;
    st().addClip(v3!, { at: S(6) });
    expect(st().addTransition(a, 'mix')).toBeNull();
    const x = st().addClip(odd!, { at: 0 })!;
    expect(st().addTransition(x, 'mix')).toBeNull();
  });
});

describe('audit: lock / hide / mute really work', () => {
  it('a locked track refuses EVERY edit (its JSON never changes)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const o1 = st().addClip(v5!, { at: 0, kind: 'overlay' })!;
    const o2 = st().addClip(v4!, { at: S(5), trackId: clipOf(o1).track.id })!;
    st().addTransition(o1, 'mix');
    const tr = clipOf(o1).track.transitions[0]!.id;
    const track = clipOf(o1).track.id;
    st().select([o1]);
    st().setTrack(track, { locked: true });
    expect(st().selection.clipIds).toEqual([]); // REGRESSION: locking deselects
    const frozen = () => JSON.stringify(st().project.tracks.find((t) => t.id === track));
    const before = frozen();
    st().setPlayhead(S(2));
    const tries: Array<() => unknown> = [
      () => st().moveClip(o1, { start: S(20) }),
      () => st().moveClip(o1, { start: 0, newTrack: 'above' }),
      () => st().moveClips([o1, o2], S(3), 0),
      () => st().trimStart(o1, S(1)),
      () => st().trimEnd(o1, S(1)),
      () => st().splitClip(o1, S(2)),
      () => st().splitAtPlayhead(),
      () => st().splitAllAtPlayhead(),
      () => st().deleteClips([o1, o2]),
      () => st().deleteLeft(),
      () => st().deleteRight(),
      () => st().duplicateClips([o1]),
      () => st().updateClip(o1, { transform: { scale: 2 } }),
      () => st().setSpeed(o1, 2),
      () => st().setDuration(o1, S(1)),
      () => st().toggleExtractAudio([o1]),
      () => st().nudgeVolume([o1], 3),
      () => st().setAnimation(o1, 'in', 'fade'),
      () => st().addTransition(o1, 'zoom'),
      () => st().updateTransition(tr, { duration: S(1) }),
      () => st().removeTransition(tr),
      () => st().applyTransitionToAll(tr),
      () => st().addClip(v5!, { at: S(1), trackId: track }),
      () => st().addTextClip({ at: 0, trackId: track }),
      () => st().insertClips([structuredClone(clipOf(o1).clip)], 0),
      () => (st().select([o1, o2]), st().mirrorSelected(), st().rotateSelected(90), st().deleteSelected()),
    ];
    for (const t of tries) {
      t();
      expect(frozen()).toBe(before);
    }
    expect(st().selection.clipIds).toEqual([]); // a locked clip cannot be selected
    healthy();
  });
  it('REGRESSION: with the main track locked, new media goes to an overlay track (was: inserted into the locked track)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    st().setTrack(main().id, { locked: true });
    const before = JSON.stringify(main());
    const b = st().addClip(v4!, { at: 0 })!;
    expect(clipOf(b).track.kind).toBe('overlay');
    const pasted = st().insertClips([structuredClone(clipOf(a).clip)], 0);
    expect(clipOf(pasted[0]!).track.kind).toBe('overlay');
    expect(JSON.stringify(main())).toBe(before);
    healthy();
  });
});

describe('audit: magnet, markers, selection', () => {
  it('magnet on packs the main track as one undo step; REGRESSION: undoing it turns the magnet off again', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().setMagnet(false);
    st().addClip(v5!, { at: 0 });
    const b = st().addClip(v4!, { at: S(8) })!;
    expect(clipOf(b).clip.start).toBe(S(8));
    st().setMagnet(true);
    expect(clipOf(b).clip.start).toBe(S(5));
    st().undo();
    expect(clipOf(b).clip.start).toBe(S(8));
    expect(st().magnet).toBe(false);
    // the next unrelated edit no longer closes the gap behind the user's back
    st().addMarker(S(1));
    expect(clipOf(b).clip.start).toBe(S(8));
  });
  it('markers: frame-snapped, one per frame, undoable; remove', () => {
    const before = json();
    const id = st().addMarker(1_234_567);
    expect(st().project.markers[0]!.time).toBe(1_233_333);
    expect(st().addMarker(1_240_000)).toBe(id);
    st().removeMarker(id);
    expect(st().project.markers).toEqual([]);
    st().undo();
    st().undo();
    expect(json()).toBe(before);
  });
  it('[ / ] select exactly the clips left / right of the playhead', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    const b = st().addClip(v4!, { at: S(5) })!;
    st().setPlayhead(S(5));
    expect(st().selectSide('left')).toEqual([a]);
    expect(st().selectSide('right')).toEqual([b]);
  });
});

describe('audit: no empty undo steps', () => {
  it('REGRESSION: refused or no-op edits leave no undo step (was: every call pushed one)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    const a = st().addClip(v5!, { at: 0 })!;
    st().addClip(v4!, { at: S(5) });
    st().addTransition(a, 'mix');
    const tr = main().transitions[0]!;
    const n = st().past.length;
    st().moveClip(a, { start: 0 }); // same spot
    st().updateTransition(tr.id, { type: tr.type, duration: tr.duration }); // same values
    st().applyTransitionToAll(tr.id);
    st().setAnimation(a, 'in', null);
    st().setMagnet(true); // already packed
    st().setTrack(main().id, { locked: true });
    const m = st().past.length;
    st().deleteLeft(); // refused: locked
    st().splitClip(a, S(1));
    st().trimEnd(a, S(1));
    expect(n + 1).toBe(m); // only the lock was a step
    expect(st().past.length).toBe(m);
  });
  it('REGRESSION: a gesture that ends where it started is not an undo step', () => {
    const [v5] = setup(A.v5());
    const a = st().addClip(v5!, { at: 0 })!;
    const n = st().past.length;
    st().beginTx();
    st().updateClip(a, { transform: { scale: 2 } });
    st().updateClip(a, { transform: { scale: 1 } });
    st().commitTx();
    expect(st().past.length).toBe(n);
  });
});

describe('audit: magnet undo / redo symmetry', () => {
  it('REGRESSION: redo of "magnet on" turns the magnet back on (undo had turned it off)', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().setMagnet(false);
    st().addClip(v5!, { at: 0 });
    const b = st().addClip(v4!, { at: S(8) })!;
    st().setMagnet(true);
    st().undo();
    expect([st().magnet, clipOf(b).clip.start]).toEqual([false, S(8)]);
    st().redo();
    expect([st().magnet, clipOf(b).clip.start]).toEqual([true, S(5)]);
    healthy();
  });
  it('redo of an ordinary magnet-off edit that happens to close a gap leaves the magnet off', () => {
    const [v5, v4] = setup(A.v5(), A.v4());
    st().setMagnet(false);
    st().addClip(v5!, { at: 0 });
    const b = st().addClip(v4!, { at: S(8) })!;
    st().moveClip(b, { start: S(5) });
    st().undo();
    st().redo();
    expect(st().magnet).toBe(false);
  });
});

describe('audit: hide / mute reach the preview AND the export (shared frame state + mix plan)', () => {
  it('a hidden track draws nothing in getFrameState (player and exporter) but still sounds; a muted one is silent in both', () => {
    const [v5, odd] = setup(A.v5(), A.odd());
    const v = st().addClip(v5!, { at: 0 })!;
    const a = st().addClip(odd!, { at: 0 })!;
    const mainId = main().id;
    const audioId = clipOf(a).track.id;
    const drawn = () => getFrameState(st().project, S(1)).ops.filter((o) => o.kind === 'media').length;
    const heard = () => getFrameState(st().project, S(1)).audio.map((x) => x.clipId).sort();
    const mixed = () => planMix(st().project).map((x) => x.clipId).sort();
    expect([drawn(), heard(), mixed()]).toEqual([1, [v, a].sort(), [v, a].sort()]);
    st().setTrack(mainId, { hidden: true });
    expect([drawn(), heard(), mixed()]).toEqual([0, [v, a].sort(), [v, a].sort()]);
    st().setTrack(mainId, { hidden: false, muted: true });
    expect([drawn(), heard(), mixed()]).toEqual([1, [a], [a]]);
    st().setTrack(audioId, { muted: true });
    expect([heard(), mixed()]).toEqual([[], []]);
    // extracted audio: the video's own sound is off, the audio clip carries it
    st().setTrack(mainId, { muted: false });
    st().setTrack(audioId, { muted: false });
    st().toggleExtractAudio([v]);
    const ex = st().project.tracks.filter((t) => t.kind === 'audio').at(-1)!.clips[0]!.id;
    expect(mixed()).toEqual([a, ex].sort());
  });
});
