// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import type { AudioClip, VideoClip } from '../model/types';
import { useEditor } from '../store';
import { Inspector } from './Inspector';

const st = () => useEditor.getState();
const S = secToUs;
const audioOf = (id: string) => (findClip(st().project, id)!.clip as VideoClip | AudioClip).audio;

function addVideo(): string {
  const a = createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1080, height: 1920, hasAudio: true });
  let id = '';
  act(() => {
    st().addAssets([a]);
    id = st().addClip(a.id, { at: 0 })!;
  });
  return id;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  act(() => st().newProject());
});
afterEach(cleanup);

const openAudio = () => {
  render(<Inspector />);
  fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
};

describe('Audio tab', () => {
  it('Basic lists CapCut sections in order; AI rows are disabled "coming soon"', () => {
    addVideo();
    openAudio();
    const ids = Array.from(document.querySelectorAll('[data-testid^="section-audio-"], [data-testid^="audio-ai-"]')).map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['section-audio-basic', 'section-audio-normalize', 'audio-ai-enhance', 'audio-ai-translator', 'section-audio-noise', 'section-audio-isolate', 'section-audio-fill']);
    for (const ai of ['enhance', 'translator']) {
      const row = screen.getByTestId(`audio-ai-${ai}`);
      expect((within(row).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
      expect(row.textContent).toContain('Coming soon');
    }
  });

  it('audio clips have no Video translator row', () => {
    const a = createAsset({ kind: 'audio', name: 'a.mp3', mime: 'audio/mpeg', size: 1, duration: S(4), hasAudio: true });
    act(() => {
      st().addAssets([a]);
      st().addClip(a.id, { at: 0 });
    });
    render(<Inspector />);
    expect(screen.queryByTestId('audio-ai-translator')).toBeNull();
    expect(screen.getByTestId('audio-ai-enhance')).toBeTruthy();
  });

  it('checkboxes write the clip and undo one step each', async () => {
    const id = addVideo();
    openAudio();
    const check = (title: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Enable ${title}` }));
    act(() => check('Normalize loudness'));
    act(() => check('Reduce noise'));
    act(() => check('Fill channel'));
    expect(audioOf(id)).toMatchObject({ normalize: true, reduceNoise: true, fillChannel: 'left' });
    expect(screen.getByTestId('normalize-readout').textContent).toContain('Target −23.0 LUFS');
    // no media in jsdom: the measurement settles as "silent" (gain 0 dB)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.getByTestId('normalize-readout').textContent).toContain('Silent');
    act(() => {
      fireEvent.change(screen.getByTestId('fill-channel-select'), { target: { value: 'right' } });
    });
    expect(audioOf(id).fillChannel).toBe('right');
    act(() => st().undo());
    expect(audioOf(id).fillChannel).toBe('left');
    act(() => st().undo());
    expect(audioOf(id).fillChannel).toBeNull();
    act(() => st().undo());
    expect(audioOf(id).reduceNoise).toBe(false);
  });

  it('Basic reset restores volume and fades; Basic checkbox mutes the clip', () => {
    const id = addVideo();
    act(() => st().updateClip(id, { audio: { volumeDb: -6, fadeIn: S(1) } }));
    openAudio();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset Basic' }));
    });
    expect(audioOf(id)).toMatchObject({ volumeDb: 0, fadeIn: 0 });
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Basic' }));
    });
    expect(audioOf(id).muted).toBe(true);
  });

  it('Voice changer: pick a filter, change strength (one undo step), None clears', () => {
    const id = addVideo();
    openAudio();
    fireEvent.click(screen.getByRole('tab', { name: 'Voice changer' }));
    act(() => {
      fireEvent.click(screen.getByTestId('voice-filter-robot'));
    });
    expect(audioOf(id).voiceFilter).toEqual({ id: 'robot', strength: 50 });
    const before = st().past.length;
    const slider = within(screen.getByTestId('voice-strength-row')).getByRole('slider');
    act(() => {
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: '70' } });
      fireEvent.change(slider, { target: { value: '80' } });
      fireEvent.pointerUp(window);
    });
    expect(audioOf(id).voiceFilter).toEqual({ id: 'robot', strength: 80 });
    expect(st().past.length).toBe(before + 1);
    expect(screen.getByTestId('audio-ai-characters')).toBeTruthy();
    expect(screen.getByTestId('audio-ai-speech-to-song')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByTestId('voice-filter-none'));
    });
    expect(audioOf(id).voiceFilter).toBeNull();
  });

  it('Isolate voice (DSP): checkbox, mode, strength (one undo step), off', () => {
    const id = addVideo();
    openAudio();
    const sec = screen.getByTestId('section-audio-isolate');
    expect(sec.textContent).toContain('DSP');
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Isolate voice' }));
    });
    expect(audioOf(id).voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });
    const before = st().past.length;
    const slider = within(screen.getByTestId('isolate-strength-row')).getByRole('slider');
    act(() => {
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: '70' } });
      fireEvent.change(slider, { target: { value: '60' } });
      fireEvent.pointerUp(window);
    });
    expect(audioOf(id).voiceIsolation).toEqual({ mode: 'isolate', strength: 60 });
    expect(st().past.length).toBe(before + 1);
    act(() => {
      fireEvent.change(screen.getByTestId('isolate-mode-select'), { target: { value: 'remove' } });
    });
    expect(audioOf(id).voiceIsolation).toEqual({ mode: 'remove', strength: 60 });
    act(() => st().undo());
    expect(audioOf(id).voiceIsolation).toEqual({ mode: 'isolate', strength: 60 });
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Isolate voice' }));
    });
    expect(audioOf(id).voiceIsolation).toBeNull();
  });

  it('a video whose audio was extracted shows the link and can restore it', () => {
    const id = addVideo();
    let audioId = '';
    act(() => {
      audioId = st().toggleExtractAudio([id]).extracted[0]!;
      st().select([id]);
    });
    openAudio();
    expect(screen.getByTestId('audio-extracted')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByTestId('select-extracted-audio'));
    });
    expect(st().selection.clipIds).toEqual([audioId]);
    act(() => {
      st().select([id]);
    });
    act(() => {
      fireEvent.click(screen.getByTestId('restore-audio'));
    });
    expect(audioOf(id).muted).toBe(false);
    expect(findClip(st().project, audioId)).toBeUndefined();
  });
});
