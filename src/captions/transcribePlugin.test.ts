import { describe, expect, it } from 'vitest';
import { LANGS, listModels, whisperArgs } from '../../vite-plugins/transcribe.js';
import { onlyClips, selectionRange, wholeRange } from './transcribe';
import { createProject, createTextClip } from '../model/defaults';

describe('transcribe server plugin', () => {
  it('runs whisper-cli with DTW token timestamps (flash attention off) and full JSON', () => {
    const args = whisperArgs({ model: '/m/ggml-large-v3-turbo.bin', dtw: 'large.v3.turbo', lang: 'he', wav: '/w/a.wav', outBase: '/w/out', threads: 6 });
    expect(args.join(' ')).toBe('-m /m/ggml-large-v3-turbo.bin -f /w/a.wav -l he -ojf -of /w/out -pp -t 6 -nfa -dtw large.v3.turbo');
    expect(whisperArgs({ model: 'x', lang: 'auto', wav: 'a', outBase: 'o', threads: 4 })).not.toContain('-dtw');
    expect(LANGS.has('he') && LANGS.has('en') && LANGS.has('auto')).toBe(true);
  });

  it('lists no model for a folder that does not exist', () => {
    expect(listModels('/nonexistent/whisper-models')).toEqual([]);
  });
});

describe('transcription ranges', () => {
  it('whole timeline, selected clips, and "only the selected clips are heard"', () => {
    const p = createProject();
    const t = { ...p.tracks[0]!, clips: [createTextClip(p.tracks[0]!.id, 1_000_000), createTextClip(p.tracks[0]!.id, 5_000_000)] };
    const proj = { ...p, tracks: [t] };
    const [a, b] = t.clips;
    expect(selectionRange(proj, [a!.id, b!.id])).toEqual({ start: 1_000_000, end: 5_000_000 + b!.duration });
    expect(selectionRange(proj, [])).toBeNull();
    expect(wholeRange(proj)).toEqual({ start: 0, end: 5_000_000 + b!.duration });
    const only = onlyClips(proj, [a!.id]);
    expect(only.tracks[0]!.clips.map((c) => c.disabled)).toEqual([false, true]);
    expect(proj.tracks[0]!.clips[1]!.disabled).toBe(false);
  });
});
