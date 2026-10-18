// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset } from '../model/defaults';
import { findClip } from '../model/project';
import { secToUs } from '../model/time';
import { LeftPanel, LIBRARY_TABS } from '../panels/LeftPanel';
import { addTextPreset } from '../panels/TextTab';
import { TEXT_PRESETS } from '../panels/presets';
import { useEditor } from '../store';
import { Inspector } from './Inspector';

const st = () => useEditor.getState();
const S = secToUs;
const video = () => createAsset({ kind: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 1, duration: S(4), width: 1920, height: 1080, hasAudio: true });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  act(() => st().newProject());
});
afterEach(cleanup);

describe('Inspector', () => {
  it('shows Project details with nothing selected', () => {
    render(<Inspector />);
    expect(screen.getByTestId('inspector-project')).toBeTruthy();
    expect(screen.getByText('1080 × 1920')).toBeTruthy();
  });

  it('shows CapCut tabs for a video clip and switches to Speed', () => {
    const a = video();
    act(() => {
      st().addAssets([a]);
      st().addClip(a.id, { at: 0 });
    });
    render(<Inspector />);
    for (const label of ['Video', 'Audio', 'Speed', 'Animation', 'Adjust']) expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Speed' }));
    expect(screen.getByTestId('speed-row')).toBeTruthy();
  });

  it('a slider drag is one undo step', () => {
    const a = video();
    let id = '';
    act(() => {
      st().addAssets([a]);
      id = st().addClip(a.id, { at: 0 })!;
    });
    render(<Inspector />);
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    const before = st().past.length;
    const slider = screen.getByRole('slider', { name: 'Opacity' });
    act(() => {
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: '80' } });
      fireEvent.change(slider, { target: { value: '50' } });
      fireEvent.change(slider, { target: { value: '30' } });
      window.dispatchEvent(new Event('pointerup'));
    });
    const clip = findClip(st().project, id)!.clip;
    expect(clip.type !== 'audio' && clip.transform.opacity).toBe(0.3);
    expect(st().past.length).toBe(before + 1);
    act(() => st().undo());
    const undone = findClip(st().project, id)!.clip;
    expect(undone.type !== 'audio' && undone.transform.opacity).toBe(1);
  });

  it('number box commits on Enter', () => {
    const a = video();
    let id = '';
    act(() => {
      st().addAssets([a]);
      id = st().addClip(a.id, { at: 0 })!;
    });
    render(<Inspector />);
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    const box = screen.getByLabelText('Position X') as HTMLInputElement;
    act(() => {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: '120' } });
      fireEvent.blur(box);
    });
    const c = findClip(st().project, id)!.clip;
    expect(c.type !== 'audio' && c.transform.x).toBe(120);
  });

  it('shows the Transition panel for a selected transition', () => {
    const a = video();
    const b = video();
    act(() => {
      st().addAssets([a, b]);
      const c1 = st().addClip(a.id, { at: 0 })!;
      st().addClip(b.id, { at: S(10) });
      st().addTransition(c1, 'mix');
    });
    render(<Inspector />);
    expect(screen.getByTestId('inspector-transition')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom' }));
    expect(st().project.tracks[0]!.transitions[0]!.type).toBe('zoom');
  });

  it('text clip shows Text tab and edits content', () => {
    let id = '';
    act(() => {
      id = st().addTextClip({ at: 0 });
    });
    render(<Inspector />);
    const ta = screen.getByTestId('text-content') as HTMLTextAreaElement;
    const before = st().past.length;
    act(() => {
      fireEvent.focus(ta);
      fireEvent.change(ta, { target: { value: 'Hello' } });
      fireEvent.change(ta, { target: { value: 'Hello world' } });
      fireEvent.blur(ta);
    });
    const c = findClip(st().project, id)!.clip;
    expect(c.type === 'text' && c.text.content).toBe('Hello world');
    expect(st().past.length).toBe(before + 1);
  });
});

describe('Library', () => {
  it('renders every tab without crashing', () => {
    render(<LeftPanel />);
    for (const t of LIBRARY_TABS) {
      fireEvent.click(screen.getByTestId(`library-tab-${t.id}`));
    }
    fireEvent.click(screen.getByTestId('library-tab-media'));
    expect(screen.getByTestId('media-import-input')).toBeTruthy();
  });

  it('lists imported assets with the e2e attributes and an Added badge', () => {
    const a = video();
    act(() => st().addAssets([a]));
    render(<LeftPanel />);
    const tile = screen.getByTestId('media-asset');
    expect(tile.getAttribute('data-asset-name')).toBe('clip.mp4');
    expect(tile.getAttribute('data-asset-kind')).toBe('video');
    expect(screen.queryByText('Added')).toBeNull();
    fireEvent.click(screen.getByLabelText('Add clip.mp4 to timeline'));
    expect(st().project.tracks[0]!.clips).toHaveLength(1);
    expect(screen.getByText('Added')).toBeTruthy();
  });

  it('a text preset adds one styled clip in one undo step', () => {
    const before = st().past.length;
    let id = '';
    act(() => {
      id = addTextPreset(TEXT_PRESETS.find((p) => p.id === 'neon')!);
    });
    const c = findClip(st().project, id)!.clip;
    expect(c.type === 'text' && c.text.shadow.enabled).toBe(true);
    expect(st().past.length).toBe(before + 1);
  });

  it('filter tile applies to the selected clip', () => {
    const a = video();
    let id = '';
    act(() => {
      st().addAssets([a]);
      id = st().addClip(a.id, { at: 0 })!;
    });
    render(<LeftPanel />);
    fireEvent.click(screen.getByTestId('library-tab-filters'));
    fireEvent.click(screen.getByRole('button', { name: 'Noir' }));
    const c = findClip(st().project, id)!.clip;
    expect(c.type !== 'audio' && c.filter).toEqual({ id: 'noir', intensity: 1 });
  });
});
