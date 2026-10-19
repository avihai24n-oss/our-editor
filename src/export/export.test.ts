import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { mainTrack } from '../model/project';
import { secToUs } from '../model/time';
import { useEditor } from '../store';
import { SequentialReader, type TimedFrame } from './frameSource';
import { gainPoints, planMix } from './offlineMix';
import { defaultExportSettings, estimateBytes, exportFileName, formatBytes, frameCount, outputSize, videoBitrate } from './settings';

const S = secToUs;
const st = () => useEditor.getState();

describe('export settings', () => {
  it('resolution is the short side, even pixels', () => {
    expect(outputSize(1080, 1920, '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(1080, 1920, '720p')).toEqual({ width: 720, height: 1280 });
    expect(outputSize(1920, 1080, '4k')).toEqual({ width: 3840, height: 2160 });
    expect(outputSize(1080, 1350, '720p')).toEqual({ width: 720, height: 900 });
    expect(outputSize(1080, 1080, '2k')).toEqual({ width: 1440, height: 1440 });
  });

  it('bitrate scales with pixels × fps × quality', () => {
    expect(videoBitrate(1080, 1920, 30, 'recommended')).toBe(6_220_800);
    expect(videoBitrate(1080, 1920, 30, 'higher')).toBeGreaterThan(videoBitrate(1080, 1920, 30, 'recommended'));
    expect(videoBitrate(10, 10, 24, 'lower')).toBe(1e6); // floor
  });

  it('size estimate, formatting, file names, frame count', () => {
    expect(estimateBytes(S(10), 8e6, false)).toBe(10_000_000);
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(exportFileName('My: clip/v1', 'mp4')).toBe('My_ clip_v1.mp4');
    expect(exportFileName('  ', 'webm')).toBe('Untitled.webm');
    expect(exportFileName('done.mp4', 'mp4')).toBe('done.mp4');
    expect(frameCount(S(3), 30)).toBe(90);
    expect(frameCount(S(3) + 1, 30)).toBe(91);
    expect(frameCount(0, 30)).toBe(0);
  });

  it('defaults follow the project fps when it is offered', () => {
    expect(defaultExportSettings('a', 25)).toMatchObject({ fps: 25, resolution: '1080p', quality: 'recommended' });
  });
});

describe('planMix', () => {
  beforeEach(() => st().newProject());

  it('includes audible clips with volume, fades and speed; skips silent ones', () => {
    const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(10), width: 1920, height: 1080, hasAudio: true });
    const mute = createAsset({ kind: 'video', name: 'm.mp4', mime: 'video/mp4', size: 1, duration: S(10), width: 1920, height: 1080, hasAudio: false });
    const a = createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(20), hasAudio: true });
    st().addAssets([v, mute, a]);
    const vc = st().addClip(v.id, { at: 0 })!;
    st().addClip(mute.id, { at: S(10) });
    const ac = st().addClip(a.id, { at: S(2) })!;
    st().updateClip(ac, { audio: { volumeDb: -6, fadeIn: S(1), fadeOut: S(2) } });
    st().setSpeed(vc, 2);

    const plan = planMix(st().project);
    expect(plan.map((p) => p.clipId).sort()).toEqual([vc, ac].sort());
    const pa = plan.find((p) => p.clipId === ac)!;
    expect(pa.volume).toBeCloseTo(0.501, 2);
    expect(pa).toMatchObject({ startSec: 2, fadeInSec: 1, fadeOutSec: 2, speed: 1 });
    expect(plan.find((p) => p.clipId === vc)).toMatchObject({ speed: 2, durationSec: 5, inSec: 0, preservePitch: true });
    st().updateClip(vc, { preservePitch: false }); // "Change audio pitch" on → playbackRate path
    expect(planMix(st().project).find((p) => p.clipId === vc)?.preservePitch).toBe(false);

    st().updateClip(ac, { audio: { muted: true } });
    expect(planMix(st().project).map((p) => p.clipId)).toEqual([vc]);
    st().setTrack(mainTrack(st().project).id, { muted: true });
    expect(planMix(st().project)).toEqual([]);
  });

  it('hidden tracks still sound; disabled clips and lost media do not', () => {
    const v = createAsset({ kind: 'video', name: 'v.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: true });
    st().addAssets([v]);
    const id = st().addClip(v.id, { at: 0 })!;
    st().setTrack(mainTrack(st().project).id, { hidden: true });
    expect(planMix(st().project)).toHaveLength(1);
    st().updateClip(id, { disabled: true });
    expect(planMix(st().project)).toHaveLength(0);
    st().updateClip(id, { disabled: false });
    st().setAssetsMissing([v.id]);
    expect(planMix(st().project)).toHaveLength(0);
  });
});

describe('gainPoints', () => {
  it('fade in, hold, fade out', () => {
    expect(gainPoints({ startSec: 1, durationSec: 4, volume: 0.5, fadeInSec: 1, fadeOutSec: 1 })).toEqual([
      [1, 0],
      [2, 0.5],
      [4, 0.5],
      [5, 0],
    ]);
    expect(gainPoints({ startSec: 0, durationSec: 2, volume: 1, fadeInSec: 0, fadeOutSec: 0 })).toEqual([[0, 1]]);
  });

  it('overlapping fades are scaled to fit the clip', () => {
    const p = gainPoints({ startSec: 0, durationSec: 2, volume: 1, fadeInSec: 2, fadeOutSec: 2 });
    expect(p).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
    ]);
  });
});

describe('SequentialReader', () => {
  const fps = 10;
  function source(total = 100) {
    const opens: number[] = [];
    const open = (start: number) => {
      opens.push(start);
      return (async function* () {
        // like Mediabunny: start at the frame covering `start`
        for (let i = Math.max(0, Math.floor(start * fps + 1e-9)); i < total; i++) {
          yield { canvas: { width: 1, height: 1 } as TimedFrame['canvas'], timestamp: i / fps };
        }
      })();
    };
    return { open, opens };
  }

  it('returns the frame covering each time, decoding forward', async () => {
    const s = source();
    const r = new SequentialReader(s.open);
    expect((await r.frameAt(0))?.timestamp).toBe(0);
    expect((await r.frameAt(0.05))?.timestamp).toBe(0);
    expect((await r.frameAt(0.1))?.timestamp).toBe(0.1);
    expect((await r.frameAt(0.37))?.timestamp).toBeCloseTo(0.3);
    expect(s.opens).toEqual([0]);
  });

  it('restarts on a backwards or long forward jump', async () => {
    const s = source();
    const r = new SequentialReader(s.open);
    await r.frameAt(1);
    await r.frameAt(0.5);
    expect(s.opens).toEqual([1, 0.5]);
    await r.frameAt(6);
    expect(s.opens).toEqual([1, 0.5, 6]);
    expect((await r.frameAt(6.25))?.timestamp).toBeCloseTo(6.2);
  });

  it('holds the last frame past the end', async () => {
    const s = source(5);
    const r = new SequentialReader(s.open);
    expect((await r.frameAt(0.2))?.timestamp).toBeCloseTo(0.2);
    expect((await r.frameAt(1.5))?.timestamp).toBeCloseTo(0.4);
    expect((await r.frameAt(1.6))?.timestamp).toBeCloseTo(0.4);
    expect(s.opens).toHaveLength(1);
  });
});
