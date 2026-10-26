import { beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { secToUs } from '../model/time';
import { useEditor } from '../store';
import { AUDITION_LONG_US, auditionClip, auditionRange, auditionSeek, auditionState, auditionStopAt, endAudition, resetAudition } from './audition';

const S = secToUs;
const st = () => useEditor.getState();

function addAudio(sec: number, at: number): string {
  const a = createAsset({ kind: 'audio', name: 'a.wav', mime: 'audio/wav', size: 1, duration: S(sec), hasAudio: true });
  st().addAssets([a]);
  return st().addClip(a.id, { at: S(at) })!;
}

beforeEach(() => {
  st().newProject();
  resetAudition();
});

describe('auditionRange', () => {
  const short = { start: S(10), duration: S(6) };
  const long = { start: S(10), duration: S(60) };

  it('a short clip always plays from its start to its end', () => {
    expect(auditionRange(short, S(0))).toEqual({ from: S(10), to: S(16) });
    expect(auditionRange(short, S(13))).toEqual({ from: S(10), to: S(16) });
    expect(auditionRange(short, S(30))).toEqual({ from: S(10), to: S(16) });
  });

  it('a long clip starts at the playhead when it is inside (not in the last second)', () => {
    expect(long.duration).toBeGreaterThan(AUDITION_LONG_US);
    expect(auditionRange(long, S(42))).toEqual({ from: S(42), to: S(70) });
    expect(auditionRange(long, S(5))).toEqual({ from: S(10), to: S(70) });
    expect(auditionRange(long, S(69.5))).toEqual({ from: S(10), to: S(70) });
    expect(auditionRange(long, S(70))).toEqual({ from: S(10), to: S(70) });
  });

  it('an anchor inside the clip wins; one outside is ignored', () => {
    expect(auditionRange(long, S(60), S(42))).toEqual({ from: S(42), to: S(70) });
    expect(auditionRange(short, S(10), S(12))).toEqual({ from: S(12), to: S(16) });
    expect(auditionRange(short, S(10), S(20))).toEqual({ from: S(10), to: S(16) });
  });
});

describe('auditionClip', () => {
  it('jumps to the clip start, plays, and stops at the clip end', () => {
    const id = addAudio(4, 3);
    st().setPlayhead(S(1));
    auditionClip(id);
    expect(st().playhead).toBe(S(3));
    expect(st().playing).toBe(true);
    expect(auditionStopAt()).toBe(S(7));
  });

  it('restarts from the same anchor while playing, and after it stopped where it stopped', () => {
    const id = addAudio(40, 0);
    st().setPlayhead(S(12));
    auditionClip(id);
    expect(st().playhead).toBe(S(12));
    // playback moved on; a new pick restarts at the anchor
    st().setPlayhead(S(15));
    auditionClip(id);
    expect(st().playhead).toBe(S(12));
    // it stopped (Space) at 18 s: the next pick still restarts at 12 s
    st().pause();
    st().setPlayhead(S(18));
    endAudition(S(18));
    expect(auditionStopAt()).toBeNull();
    auditionClip(id);
    expect(st().playhead).toBe(S(12));
    // the user moved the playhead after a stop: a new anchor
    st().pause();
    endAudition(st().playhead);
    st().setPlayhead(S(25));
    auditionClip(id);
    expect(st().playhead).toBe(S(25));
  });

  it('a seek out of the clip turns the audition into normal playback', () => {
    const id = addAudio(4, 2);
    auditionClip(id);
    auditionSeek(S(3));
    expect(auditionState()?.clipId).toBe(id);
    auditionSeek(S(9));
    expect(auditionState()).toBeNull();
    expect(auditionStopAt()).toBeNull();
  });

  it('plain play has no stop point', () => {
    addAudio(4, 0);
    st().play();
    expect(auditionStopAt()).toBeNull();
  });
});
