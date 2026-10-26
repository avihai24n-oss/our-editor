// @vitest-environment jsdom
/** The audio lane CapCut draws along the bottom of a video clip that carries sound. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createAsset, createProject, newId } from '../model/defaults';
import { secToUs } from '../model/time';
import type { Clip, MediaAsset, VideoClip } from '../model/types';
import { ClipView } from './ClipView';

const asset = (hasAudio: boolean | undefined): MediaAsset =>
  createAsset({ kind: 'video', name: 'c.mp4', mime: 'video/mp4', size: 1, duration: secToUs(4), width: 1920, height: 1080, hasAudio });

function videoClip(): VideoClip {
  const p = createProject();
  return {
    id: newId('clp'),
    type: 'video',
    name: 'c.mp4',
    trackId: p.tracks[0]!.id,
    assetId: 'a1',
    start: 0,
    duration: secToUs(4),
    inPoint: 0,
    speed: 1,
    speedCurve: null,
    preservePitch: true,
    disabled: false,
    audio: { volumeDb: 0, muted: false, fadeIn: 0, fadeOut: 0 },
  } as VideoClip;
}

function draw(clip: Clip, a: MediaAsset | undefined, height = 64) {
  render(
    <ClipView
      clip={clip}
      asset={a}
      zoom={60}
      height={height}
      selected={false}
      locked={false}
      viewFrom={0}
      viewTo={2000}
      onPointerDown={() => undefined}
    />,
  );
}

afterEach(cleanup);

describe('video clip audio lane', () => {
  it('appears on a video clip whose media has sound', () => {
    draw(videoClip(), asset(true));
    const band = screen.getByTestId('clip-audio-band');
    expect(band).toBeTruthy();
    expect(Number.parseInt(band.style.height, 10)).toBeGreaterThan(8);
  });

  it('is left out when the media has no audio track', () => {
    draw(videoClip(), asset(false));
    expect(screen.queryByTestId('clip-audio-band')).toBeNull();
  });

  it('is left out when the media is lost', () => {
    draw(videoClip(), { ...asset(true), missing: true });
    expect(screen.queryByTestId('clip-audio-band')).toBeNull();
  });

  it('is left out on a clip too short to keep the filmstrip readable', () => {
    draw(videoClip(), asset(true), 20);
    expect(screen.queryByTestId('clip-audio-band')).toBeNull();
  });

  it('stays off an audio clip, which already is a waveform', () => {
    const c = { ...videoClip(), type: 'audio' } as unknown as Clip;
    draw(c, createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: secToUs(4), hasAudio: true }));
    expect(screen.queryByTestId('clip-audio-band')).toBeNull();
  });
});
