import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getFrameState } from '../engine/frameState';
import { planMix } from '../export/offlineMix';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { AudioClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { loadProject, saveProject } from '../store/persistence';

const st = () => useEditor.getState();
const S = secToUs;
const audioOf = (id: string) => (findClip(st().project, id)!.clip as VideoClip | AudioClip).audio;

function setup() {
  const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(6), width: 1080, height: 1920, hasAudio: true });
  st().addAssets([v]);
  return st().addClip(v.id, { at: 0 })!;
}

describe('Audio tab fields in the store', () => {
  beforeEach(() => st().newProject());

  it('new clips start with every audio effect off', () => {
    const id = setup();
    expect(audioOf(id)).toEqual({ volumeDb: 0, fadeIn: 0, fadeOut: 0, muted: false, normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null, voiceIsolation: null });
  });

  it('every control is one undo step and redoes', () => {
    const id = setup();
    const steps: [string, Parameters<ReturnType<typeof st>['updateClip']>[1]][] = [
      ['normalize', { audio: { normalize: true } }],
      ['reduceNoise', { audio: { reduceNoise: true } }],
      ['fillChannel', { audio: { fillChannel: 'right' } }],
      ['voiceFilter', { audio: { voiceFilter: { id: 'echo', strength: 70 } } }],
      ['volumeDb', { audio: { volumeDb: -6 } }],
    ];
    for (const [, patch] of steps) st().updateClip(id, patch);
    expect(audioOf(id)).toMatchObject({ normalize: true, reduceNoise: true, fillChannel: 'right', voiceFilter: { id: 'echo', strength: 70 }, volumeDb: -6 });
    for (let i = steps.length - 1; i >= 0; i--) {
      st().undo();
      const a = audioOf(id) as unknown as Record<string, unknown>;
      expect(a[steps[i]![0]], `undo ${steps[i]![0]}`).toEqual({ normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null, volumeDb: 0 }[steps[i]![0]]);
    }
    for (let i = 0; i < steps.length; i++) st().redo();
    expect(audioOf(id)).toMatchObject({ normalize: true, fillChannel: 'right', voiceFilter: { id: 'echo', strength: 70 } });
  });

  it('a voice filter strength change replaces the filter object (no shared mutation)', () => {
    const id = setup();
    st().updateClip(id, { audio: { voiceFilter: { id: 'robot', strength: 50 } } });
    const before = audioOf(id).voiceFilter;
    st().updateClip(id, { audio: { voiceFilter: { id: 'robot', strength: 80 } } });
    expect(before).toEqual({ id: 'robot', strength: 50 });
    expect(audioOf(id).voiceFilter).toEqual({ id: 'robot', strength: 80 });
  });

  it('split and extract audio carry the effects; restore brings the video sound back', () => {
    const id = setup();
    st().updateClip(id, { audio: { normalize: true, fillChannel: 'left', voiceFilter: { id: 'deep', strength: 40 } } });
    const right = st().splitClip(id, S(3))!;
    expect(audioOf(right)).toMatchObject({ normalize: true, fillChannel: 'left', voiceFilter: { id: 'deep', strength: 40 } });
    const { extracted } = st().toggleExtractAudio([id]);
    expect(extracted).toHaveLength(1);
    expect(audioOf(id).muted).toBe(true);
    expect(audioOf(extracted[0]!)).toMatchObject({ muted: false, normalize: true, fillChannel: 'left', voiceFilter: { id: 'deep', strength: 40 } });
    // the muted video is silent; the extracted clip carries the effects into preview + export
    const ops = getFrameState(st().project, S(1)).audio;
    expect(ops.map((o) => o.clipId)).toEqual([extracted[0]]);
    expect(ops[0]!.fx).toEqual({ normalize: true, reduceNoise: false, fillChannel: 'left', voiceFilter: { id: 'deep', strength: 40 }, voiceIsolation: null });
    expect(planMix(st().project).find((c) => c.clipId === extracted[0])!.fx.fillChannel).toBe('left');
    expect(st().toggleExtractAudio([id]).restored).toBe(1);
    expect(audioOf(id).muted).toBe(false);
  });

  it('frame state and the export plan carry the source span for normalize', () => {
    const id = setup();
    st().trimStart(id, S(1));
    st().setSpeed(id, 2);
    st().updateClip(id, { audio: { normalize: true } });
    const c = findClip(st().project, id)!.clip as VideoClip;
    const op = getFrameState(st().project, c.start + 1).audio[0]!;
    expect(op.spanIn).toBe(S(1));
    expect(op.spanLength).toBe(S(5));
    const plan = planMix(st().project)[0]!;
    expect(plan.inSec).toBe(1);
    expect(plan.durationSec * plan.speed).toBeCloseTo(5, 6);
    expect(plan.fx.normalize).toBe(true);
  });

  it('settings survive a save / reload', async () => {
    const id = setup();
    st().updateClip(id, { audio: { normalize: true, reduceNoise: true, fillChannel: 'right', voiceFilter: { id: 'hall', strength: 20 }, volumeDb: -6 } });
    await saveProject(st().project);
    const back = await loadProject(st().project.id);
    st().setProject(back!);
    expect(audioOf(id)).toMatchObject({ normalize: true, reduceNoise: true, fillChannel: 'right', voiceFilter: { id: 'hall', strength: 20 }, volumeDb: -6 });
  });
});
