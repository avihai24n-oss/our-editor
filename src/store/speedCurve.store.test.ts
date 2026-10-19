import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip, migrateProject } from '../model/project';
import { curveIntegral, curveMean, curveSpeedAt, presetCurve, type SpeedCurve } from '../model/speedCurve';
import { secToUs, sourceSpan, sourceTimeAt } from '../model/time';
import type { Project, TimedClip, VideoClip } from '../model/types';
import { useEditor } from './index';

const S = secToUs;
const st = () => useEditor.getState();
const proj = () => st().project;
const clip = (id: string) => findClip(proj(), id)!.clip as VideoClip;

function setup(sec = 5) {
  const a = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(sec), width: 1080, height: 1920, hasAudio: true });
  st().addAssets([a]);
  st().setPlayhead(0);
  const id = st().addClip(a.id, { at: 0 })!;
  useEditor.setState({ past: [], future: [] });
  return { a, id };
}

beforeEach(() => {
  st().newProject();
  useEditor.setState({ magnet: true, snapping: true, zoom: 60 });
});

describe('setSpeedCurve', () => {
  it('new clips have no curve', () => {
    const { id } = setup();
    expect(clip(id).speedCurve).toBeNull();
  });

  it('applying a preset keeps the source span and sets duration = span / mean', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('bullet'));
    const c = clip(id);
    expect(c.speed).toBe(1);
    expect(c.speedCurve?.preset).toBe('bullet');
    expect(c.duration).toBe(Math.round(S(5) / curveMean(presetCurve('bullet'))));
    expect(Math.abs(sourceSpan(c) - S(5))).toBeLessThanOrEqual(2);
    // the last frame of the clip is the end of the source
    expect(Math.abs(sourceTimeAt(c, c.start + c.duration) - S(5))).toBeLessThanOrEqual(2);
  });

  it('applies over a standard speed: the span is kept and the speed returns to 1x', () => {
    const { id } = setup(5);
    st().setSpeed(id, 2);
    expect(clip(id).duration).toBe(S(2.5));
    st().setSpeedCurve(id, presetCurve('custom')); // flat 1x
    expect(clip(id).speed).toBe(1);
    expect(clip(id).duration).toBe(S(5));
  });

  it('None removes the curve at 1x; standard speed replaces a curve (CapCut)', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('jump-cut'));
    st().setSpeedCurve(id, null);
    expect(clip(id).speedCurve).toBeNull();
    expect(clip(id).duration).toBe(S(5));
    st().setSpeedCurve(id, presetCurve('hero'));
    st().setSpeed(id, 0.5);
    expect(clip(id).speedCurve).toBeNull();
    expect(Math.abs(clip(id).duration - S(10))).toBeLessThanOrEqual(4); // µs rounding of the span
  });

  it('is one undo step each and redo restores it', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('montage'));
    const d = clip(id).duration;
    st().undo();
    expect(clip(id).speedCurve).toBeNull();
    expect(clip(id).duration).toBe(S(5));
    st().redo();
    expect(clip(id).speedCurve?.preset).toBe('montage');
    expect(clip(id).duration).toBe(d);
  });

  it('dragging a point inside a transaction is one undo step', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('custom'));
    st().beginTx();
    for (const v of [1.5, 2, 3, 4]) {
      const c = structuredClone(clip(id).speedCurve!) as SpeedCurve;
      c.points[2]!.v = v;
      st().setSpeedCurve(id, c);
    }
    st().commitTx();
    expect(clip(id).speedCurve!.points[2]!.v).toBe(4);
    st().undo();
    expect(clip(id).speedCurve!.points[2]!.v).toBe(1);
  });

  it('clamps point speeds to 0.1–10', () => {
    const { id } = setup(5);
    const c = presetCurve('custom');
    c.points[1]!.v = 50;
    c.points[3]!.v = 0.001;
    st().setSpeedCurve(id, c);
    expect(clip(id).speedCurve!.points.map((p) => p.v)).toEqual([1, 10, 1, 0.1, 1]);
  });

  it('resetSpeed returns to 1x standard with the original pitch', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('flash-in'));
    st().updateClip(id, { preservePitch: false });
    st().resetSpeed(id);
    expect(clip(id)).toMatchObject({ speed: 1, speedCurve: null, preservePitch: true, duration: S(5) });
  });
});

describe('split keeps each part of the curve', () => {
  it('left + right reproduce the original mapping exactly', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('montage'));
    const whole = structuredClone(clip(id)) as TimedClip;
    const t = Math.round(whole.duration * 0.4);
    const right = st().splitClip(id, t)!;
    const L = clip(id);
    const R = clip(right);
    expect(L.duration + R.duration).toBe(whole.duration);
    expect(R.speedCurve?.preset).toBe('montage');
    // every timeline time shows the same source frame as before the split
    for (let k = 0; k <= 20; k++) {
      const tt = Math.round((whole.duration * k) / 20);
      const part = tt < R.start ? L : R;
      expect(Math.abs(sourceTimeAt(part, tt) - sourceTimeAt(whole, tt))).toBeLessThanOrEqual(2);
      if (tt < whole.duration) {
        const x = (tt - part.start) / part.duration;
        expect(curveSpeedAt(part.speedCurve!, x)).toBeCloseTo(curveSpeedAt(whole.speedCurve!, tt / whole.duration), 6);
      }
    }
    // the right part starts on the source exactly where the left part ends
    expect(Math.abs(R.inPoint - sourceTimeAt(L, L.start + L.duration))).toBeLessThanOrEqual(1);
  });
});

describe('trim on a curve clip', () => {
  it('trimming the end inwards cuts the curve and keeps the mapping', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('hero'));
    const whole = structuredClone(clip(id)) as TimedClip;
    const e = Math.round(whole.duration * 0.7);
    st().trimEnd(id, e);
    const c = clip(id);
    expect(c.duration).toBe(e);
    for (let k = 0; k <= 10; k++) {
      const tt = Math.round((e * k) / 10);
      expect(Math.abs(sourceTimeAt(c, tt) - sourceTimeAt(whole, tt))).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(sourceSpan(c) - whole.duration * curveIntegral(whole.speedCurve!, 0.7))).toBeLessThanOrEqual(2);
  });

  it('trimming the start inwards moves inPoint by the source played in the cut part', () => {
    const { id } = setup(5);
    useEditor.setState({ magnet: false });
    st().setSpeedCurve(id, presetCurve('bullet'));
    const whole = structuredClone(clip(id)) as TimedClip;
    const s = Math.round(whole.duration * 0.3);
    st().trimStart(id, s);
    const c = clip(id);
    expect(c.start).toBe(s);
    expect(Math.abs(c.inPoint - sourceTimeAt(whole, s))).toBeLessThanOrEqual(1);
    for (let k = 0; k <= 10; k++) {
      const tt = s + Math.round(((whole.duration - s) * k) / 10);
      expect(Math.abs(sourceTimeAt(c, tt) - sourceTimeAt(whole, tt))).toBeLessThanOrEqual(2);
    }
  });

  it('trimming back out continues at the end speed and cannot read past the source', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('flash-out'));
    const d0 = clip(id).duration;
    st().trimEnd(id, Math.round(d0 * 0.5));
    st().trimEnd(id, d0 * 3); // far past the source end
    const c = clip(id);
    expect(sourceSpan(c)).toBeLessThanOrEqual(S(5) + 2);
    expect(Math.abs(sourceSpan(c) - S(5))).toBeLessThan(S(0.01));
    // the re-added tail runs at the cut point's speed
    const half = Math.round(d0 * 0.5);
    const vEnd = curveSpeedAt(presetCurve('flash-out'), 0.5);
    const expected = half + (S(5) - d0 * curveIntegral(presetCurve('flash-out'), 0.5)) / vEnd;
    expect(Math.abs(c.duration - expected)).toBeLessThan(S(0.01));
  });

  it('extending the start stops at inPoint 0', () => {
    const { id } = setup(5);
    useEditor.setState({ magnet: false });
    st().setSpeedCurve(id, presetCurve('jump-cut'));
    const d0 = clip(id).duration;
    st().trimStart(id, Math.round(d0 * 0.4));
    expect(clip(id).inPoint).toBeGreaterThan(0);
    st().trimStart(id, 0);
    expect(clip(id).inPoint).toBe(0);
    expect(clip(id).start).toBeGreaterThanOrEqual(0);
  });

  it('delete-left / delete-right at the playhead use the same exact cut', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('montage'));
    const whole = structuredClone(clip(id)) as TimedClip;
    const t = Math.round(whole.duration * 0.6);
    st().setPlayhead(t);
    st().select([id]);
    st().deleteRight();
    expect(clip(id).duration).toBe(t);
    expect(Math.abs(sourceTimeAt(clip(id), t - 1) - sourceTimeAt(whole, t - 1))).toBeLessThanOrEqual(2);
  });
});

describe('extract audio copies the curve', () => {
  it('the audio clip reads the same span with the same curve', () => {
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('hero'));
    st().toggleExtractAudio([id]);
    const audio = proj().tracks.find((t) => t.kind === 'audio')!.clips[0] as TimedClip;
    expect(audio.speedCurve).toEqual(clip(id).speedCurve);
    expect(audio.duration).toBe(clip(id).duration);
  });
});

describe('migration', () => {
  it('fills speedCurve = null on clips saved before curves, and repairs bad curves', () => {
    const { id } = setup(5);
    const p = structuredClone(proj()) as Project;
    const c = p.tracks[0]!.clips[0] as unknown as Record<string, unknown>;
    delete c.speedCurve;
    const m = migrateProject(p);
    expect((m.tracks[0]!.clips[0] as TimedClip).speedCurve).toBeNull();
    c.speedCurve = { preset: 'custom', points: [{ x: 0, v: 1 }] };
    expect((migrateProject(p).tracks[0]!.clips[0] as TimedClip).speedCurve).toBeNull();
    c.speedCurve = presetCurve('bullet');
    c.speed = 2;
    const m2 = migrateProject(p).tracks[0]!.clips[0] as TimedClip;
    expect(m2.speedCurve?.preset).toBe('bullet');
    expect(m2.speed).toBe(1);
    expect(id).toBeTruthy();
  });
  it('leaves a current project untouched (same object)', () => {
    setup(5);
    const p = proj();
    expect(migrateProject(p)).toBe(p);
  });
});

describe('getFrameState with a curve (player + export frames + preview audio)', () => {
  it('draw and audio ops carry the curve source time and the instantaneous speed', async () => {
    const { getFrameState } = await import('../engine/frameState');
    const { id } = setup(5);
    st().setSpeedCurve(id, presetCurve('jump-cut'));
    const c = clip(id);
    for (const f of [0.1, 0.5, 0.9]) {
      const t = Math.round(c.duration * f);
      const fs = getFrameState(proj(), t);
      const op = fs.ops[0]!;
      expect(op.kind).toBe('media');
      if (op.kind !== 'media') continue;
      expect(op.sourceTime).toBe(sourceTimeAt(c, t));
      expect(op.speed).toBeCloseTo(curveSpeedAt(c.speedCurve!, t / c.duration), 9);
      expect(op.varying).toBe(true);
      expect(fs.audio[0]!.sourceTime).toBe(op.sourceTime);
      expect(fs.audio[0]!.speed).toBeCloseTo(op.speed!, 12);
    }
  });
});
