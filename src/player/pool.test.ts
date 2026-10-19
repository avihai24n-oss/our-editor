// @vitest-environment jsdom
/**
 * Loop-stopping and release rules of the preview media pool and audio engine:
 * capped element counts, one-shot release timers that leave nothing armed, release on demand.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioOp, MediaDrawOp } from '../engine/frameState';
import { MEMORY_LIMITS } from '../media/memory';
import { registerAssetUrl, revokeAllAssetUrls } from '../media/registry';
import { createAsset, createProject } from '../model/defaults';
import type { Project } from '../model/types';
import { AudioEngine } from './audioEngine';
import { MediaPool } from './mediaPool';

let n = 0;
beforeAll(() => {
  // jsdom has no media pipeline: stub what the pool calls
  URL.createObjectURL = () => `blob:test/${n++}`;
  URL.revokeObjectURL = () => undefined;
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

function projectWith(count: number): { project: Project; assetIds: string[] } {
  const project = createProject();
  const assetIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = createAsset({ kind: 'video', name: `v${i}.mp4`, mime: 'video/mp4', size: 1, duration: 10e6, width: 1080, height: 1920, hasAudio: true });
    project.assets[a.id] = a;
    assetIds.push(a.id);
    registerAssetUrl(a.id, new Blob(['x']));
  }
  return { project, assetIds };
}

const op = (clipId: string, assetId: string): MediaDrawOp =>
  ({ kind: 'media', mediaType: 'video', clipId, assetId, sourceTime: 0, fitWidth: 1, fitHeight: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }) as unknown as MediaDrawOp;

describe('MediaPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    revokeAllAssetUrls();
  });

  it(`never holds more than ${MEMORY_LIMITS.previewVideos} <video> elements`, () => {
    const { project, assetIds } = projectWith(20);
    const pool = new MediaPool(() => undefined);
    pool.setProject(project);
    assetIds.forEach((id, i) => {
      const ops = [op(`c${i}`, id)];
      pool.sync(ops, 0, false, 30);
      pool.idle(new Set([`c${i}`]));
    });
    expect(pool.stats().videos).toBeLessThanOrEqual(MEMORY_LIMITS.previewVideos);
    expect(document.querySelectorAll('video').length).toBeLessThanOrEqual(MEMORY_LIMITS.previewVideos);
    pool.dispose();
  });

  it('releases off-screen elements while paused and idle, with one timer that then disarms', () => {
    const { project, assetIds } = projectWith(3);
    const pool = new MediaPool(() => undefined);
    pool.setProject(project);
    for (let i = 0; i < 3; i++) pool.sync([op(`c${i}`, assetIds[i]!)], 0, false, 30);
    pool.idle(new Set(['c2'])); // only c2 is on screen now
    expect(pool.stats().videos).toBe(3);
    vi.advanceTimersByTime(MEMORY_LIMITS.idleReleaseMs + 100);
    expect(pool.stats().videos).toBe(1); // the on-screen one stays
    expect(vi.getTimerCount()).toBe(0); // nothing keeps running while idle
    const released = HTMLMediaElement.prototype.load as unknown as { mock: { calls: unknown[] } };
    expect(released.mock.calls.length).toBeGreaterThanOrEqual(2); // src dropped + load() per release
    pool.dispose();
  });

  it('releaseAll frees every element and the detached ones leave the DOM', () => {
    const { project, assetIds } = projectWith(4);
    const pool = new MediaPool(() => undefined);
    pool.setProject(project);
    pool.sync(assetIds.map((id, i) => op(`c${i}`, id)), 0, false, 30);
    expect(document.querySelectorAll('video').length).toBe(4);
    pool.releaseAll();
    expect(pool.stats().videos).toBe(0);
    expect(document.querySelectorAll('video').length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AudioEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    revokeAllAssetUrls();
  });

  const aop = (clipId: string, assetId: string): AudioOp => ({ clipId, assetId, trackId: 't', sourceTime: 0, speed: 1, preservePitch: true, gain: 1, fx: { normalize: false, reduceNoise: false, fillChannel: null, voiceFilter: null }, spanIn: 0, spanLength: 1_000_000 });

  it('caps voices and frees them all a moment after a pause (one-shot timer)', () => {
    const { assetIds } = projectWith(12);
    const eng = new AudioEngine();
    assetIds.forEach((id, i) => eng.sync([aop(`a${i}`, id)], 30));
    expect(eng.voiceCount).toBeLessThanOrEqual(MEMORY_LIMITS.previewVoices);
    eng.stopAll();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MEMORY_LIMITS.idleReleaseMs + 10);
    expect(eng.voiceCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    eng.dispose();
  });

  it('resuming playback before the timer fires keeps the voices', () => {
    const { assetIds } = projectWith(2);
    const eng = new AudioEngine();
    eng.sync([aop('a0', assetIds[0]!), aop('a1', assetIds[1]!)], 30);
    eng.stopAll();
    vi.advanceTimersByTime(500);
    eng.sync([aop('a0', assetIds[0]!), aop('a1', assetIds[1]!)], 30);
    vi.advanceTimersByTime(MEMORY_LIMITS.idleReleaseMs * 2);
    expect(eng.voiceCount).toBe(2);
    eng.releaseAll();
    expect(eng.voiceCount).toBe(0);
    eng.dispose();
  });
});

describe('PreviewEngine idle / hidden rules', () => {
  afterEach(() => vi.useRealTimers());

  it('runs no rAF loop while paused, and a hidden tab pauses playback and frees every element', async () => {
    const { PreviewEngine } = await import('./PreviewEngine');
    const { useEditor } = await import('../store');
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    useEditor.getState().newProject();
    const eng = new PreviewEngine(document.createElement('canvas'));
    eng.start();
    await new Promise((r) => setTimeout(r, 50));
    const idleCalls = raf.mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(raf.mock.calls.length).toBe(idleCalls); // paused + nothing changed → no frames requested
    expect(eng.stats().looping).toBe(false);

    useEditor.setState({ playing: true });
    expect(eng.stats().looping).toBe(true);
    vis = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useEditor.getState().playing).toBe(false);
    expect(eng.stats()).toMatchObject({ videos: 0, images: 0, voices: 0, looping: false });

    // a change while hidden does not schedule a render
    const before = raf.mock.calls.length;
    useEditor.getState().setPlayhead(1_000_000);
    expect(raf.mock.calls.length).toBe(before);

    vis = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(raf.mock.calls.length).toBe(before + 1); // exactly one frame to repaint
    eng.dispose();
  });
});
