/**
 * Library › Captions: Auto captions (whisper.cpp on this Mac, from what you hear on the timeline),
 * caption styles (MakePodcast's presets + ours, drawn by the real renderer) and caption files
 * (SRT / VTT / word JSON import and export, burn-in on export).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../../store';
import { usePref } from '../../panels/prefs';
import { GridLabel, LibraryBody, type SidebarItem } from '../../panels/LibraryLayout';
import { formatTimestamp } from '../srt';
import { CAPTION_PRESETS, presetById, presetStyle } from '../presets';
import { captionTracks } from '../ops';
import { selectionRange, transcribeInfo, wholeRange, LANGUAGE_OPTIONS, type CaptionLanguage, type ServerInfo } from '../transcribe';
import { PresetThumb } from './PresetThumb';
import { applyCaptionPreset, cancelAutoCaptions, exportCaptionFile, importCaptionFile, resplit, runAutoCaptions, setBurnIn, useCaptionJob, edit } from './actions';
import * as cops from '../ops';
import { loadCaptionFonts } from '../fonts';
import { activePreviewEngine } from '../../player/PreviewEngine';
import './captions.css';

// the player drew captions before the bundled fonts arrived: draw the frame again once they have
void loadCaptionFonts().then(() => activePreviewEngine()?.invalidate());

const SIDEBAR: SidebarItem[] = [
  { id: 'auto', label: 'Auto captions' },
  { id: 'styles', label: 'Caption styles' },
  { id: 'files', label: 'Caption files' },
];

const PHASE_LABEL = { mixing: 'Mixing the timeline audio…', uploading: 'Sending audio to Whisper…', transcribing: 'Transcribing (Whisper)…', done: 'Placing captions…' } as const;

const fmt = (us: number) => formatTimestamp(us, '.').replace(/^00:/, '').slice(0, -1);

function AutoCaptions() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection.clipIds);
  const job = useCaptionJob();
  const [lang, setLang] = usePref<string>('cap.lang', 'he');
  const [rangeMode, setRangeMode] = usePref<string>('cap.range', 'all');
  const [onlySelected, setOnlySelected] = usePref<boolean>('cap.onlySelected', false);
  const [presetId] = usePref<string>('cap.preset', '');
  const preset = presetById(presetId) ?? presetById(project.settings.width > project.settings.height ? 'subtitle' : 'karaoke')!;
  const [maxWords, setMaxWords] = usePref<number>(`cap.maxWords.${preset.id}`, preset.maxWords);
  const [maxChars, setMaxChars] = usePref<number>(`cap.maxChars.${preset.id}`, preset.maxChars);
  const [info, setInfo] = useState<ServerInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void transcribeInfo().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);

  const sel = selectionRange(project, selection);
  const range = rangeMode === 'selected' && sel ? sel : wholeRange(project);
  const empty = range.end <= range.start;
  const existing = captionTracks(project).length > 0;

  const start = () =>
    void runAutoCaptions({
      lang: lang as CaptionLanguage,
      range,
      onlyClipIds: rangeMode === 'selected' && onlySelected ? selection : undefined,
      grouping: { maxWords, maxChars },
      style: presetStyle(preset.id, project.settings.width, project.settings.height),
    });

  return (
    <div className="lib__scroll cap-panel" data-testid="captions-auto">
      <GridLabel>Auto captions</GridLabel>
      <p className="cap-note">Transcribes what you hear on the timeline with Whisper on this Mac and places word-timed captions on a caption track.</p>
      <label className="cap-field">
        <span>Language</span>
        <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Caption language" data-testid="cap-lang" disabled={job.running}>
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="cap-field">
        <span>Range</span>
        <select value={rangeMode} onChange={(e) => setRangeMode(e.target.value)} aria-label="Caption range" data-testid="cap-range" disabled={job.running}>
          <option value="all">Whole timeline</option>
          <option value="selected" disabled={!sel}>
            Selected clips{sel ? ` (${fmt(sel.start)}–${fmt(sel.end)})` : ''}
          </option>
        </select>
      </label>
      {rangeMode === 'selected' && sel && (
        <label className="cap-check">
          <input type="checkbox" className="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} disabled={job.running} />
          <span>Listen to the selected clips only (mute the rest)</span>
        </label>
      )}
      <div className="cap-row2">
        <label className="cap-field">
          <span>Max words</span>
          <input type="number" min={1} max={20} value={maxWords} onChange={(e) => setMaxWords(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} aria-label="Max words per caption" data-testid="cap-max-words" disabled={job.running} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <label className="cap-field">
          <span>Max characters</span>
          <input type="number" min={6} max={120} value={maxChars} onChange={(e) => setMaxChars(Math.max(6, Math.min(120, Math.round(Number(e.target.value) || 6))))} aria-label="Max characters per caption" data-testid="cap-max-chars" disabled={job.running} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      <div className="cap-meta">
        Style: <b>{preset.label}</b> · {info === undefined ? 'checking Whisper…' : info?.available ? `Whisper ${info.model}` : 'Whisper not available on the server'}
      </div>
      {job.running ? (
        <div className="cap-progress" data-testid="cap-progress">
          <div className="cap-progress__label">{PHASE_LABEL[job.progress?.phase ?? 'mixing']}</div>
          <div className="cap-progress__bar">
            <div style={{ width: `${Math.round((job.progress?.fraction ?? 0) * 100)}%` }} />
          </div>
          <button className="btn" onClick={cancelAutoCaptions} data-testid="cap-cancel">
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn btn--primary cap-go" disabled={empty || info === null || info?.available === false} onClick={start} data-testid="cap-generate">
          {existing ? 'Generate again (replaces this range)' : 'Generate captions'}
        </button>
      )}
      {empty && <div className="cap-meta">The timeline is empty.</div>}
      {job.error && (
        <div className="cap-error" role="alert" data-testid="cap-error">
          {job.error}
        </div>
      )}
      {job.done && !job.running && (
        <div className="cap-done" data-testid="cap-done">
          {job.done}
        </div>
      )}
    </div>
  );
}

function Styles() {
  const project = useEditor((s) => s.project);
  const tracks = captionTracks(project);
  const track = tracks[0];
  const [presetId, setPresetId] = usePref<string>('cap.preset', '');
  const current = track?.captions?.style.preset ?? presetId;
  const hebrew = (track?.captions?.language ?? 'he') === 'he';
  return (
    <div className="lib__scroll" data-testid="captions-styles">
      <GridLabel>From MakePodcast</GridLabel>
      <StyleGrid presets={CAPTION_PRESETS.filter((p) => p.makepodcast)} current={current} hebrew={hebrew} onPick={(id) => pick(id)} />
      <GridLabel>More styles</GridLabel>
      <StyleGrid presets={CAPTION_PRESETS.filter((p) => !p.makepodcast)} current={current} hebrew={hebrew} onPick={(id) => pick(id)} />
      <p className="cap-note">{track ? 'Click a style to apply it to the caption track. Fine-tune it in the inspector (select a caption).' : 'The style is used for the next captions you generate or import.'}</p>
      {track && presetById(current) && (
        <button className="btn" disabled={track.locked} onClick={() => resplit(track.id, presetById(current)!.maxWords, presetById(current)!.maxChars)} data-testid="cap-resplit-preset" title="Regroup the captions with this style's words per caption (word timings are kept)">
          Re-split for {presetById(current)!.label}: ≤ {presetById(current)!.maxWords} words
        </button>
      )}
    </div>
  );
  function pick(id: string) {
    setPresetId(id);
    if (track) applyCaptionPreset(track.id, id);
  }
}

function StyleGrid(props: { presets: typeof CAPTION_PRESETS; current: string; hebrew: boolean; onPick: (id: string) => void }) {
  return (
    <div className="cap-grid">
      {props.presets.map((p) => (
        <button key={p.id} className={`cap-tile${props.current === p.id ? ' is-active' : ''}`} title={p.desc} onClick={() => props.onPick(p.id)} data-testid={`cap-preset-${p.id}`} aria-pressed={props.current === p.id}>
          <PresetThumb presetId={p.id} hebrew={props.hebrew} />
          <span className="cap-tile__label">{p.label}</span>
        </button>
      ))}
    </div>
  );
}

function Files() {
  const project = useEditor((s) => s.project);
  const tracks = captionTracks(project);
  const track = tracks[0];
  const count = useMemo(() => tracks.reduce((n, t) => n + t.clips.filter((c) => c.type === 'text' && c.caption).length, 0), [tracks]);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="lib__scroll cap-panel" data-testid="captions-files">
      <GridLabel>Import</GridLabel>
      <button className="btn" onClick={() => input.current?.click()} data-testid="cap-import">
        Import SRT / VTT / word JSON…
      </button>
      <input
        ref={input}
        type="file"
        accept=".srt,.vtt,.json,text/vtt,application/x-subrip,application/json"
        hidden
        data-testid="cap-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importCaptionFile(f);
        }}
      />
      <GridLabel>Export</GridLabel>
      <div className="cap-btns">
        <button className="btn" disabled={!count} onClick={() => void exportCaptionFile('srt', track?.id)} data-testid="cap-export-srt">
          SRT
        </button>
        <button className="btn" disabled={!count} onClick={() => void exportCaptionFile('vtt', track?.id)} data-testid="cap-export-vtt">
          VTT
        </button>
        <button className="btn" disabled={!count} onClick={() => void exportCaptionFile('json', track?.id)} data-testid="cap-export-json">
          Word JSON
        </button>
      </div>
      <p className="cap-note">Files are saved to ~/Downloads. Word JSON keeps every word&apos;s timing.</p>
      {track?.captions && (
        <>
          <GridLabel>Video export</GridLabel>
          <label className="cap-check">
            <input type="checkbox" className="checkbox" checked={track.captions.burnIn !== false} onChange={(e) => setBurnIn(track.id, e.target.checked)} data-testid="cap-burn-in" disabled={track.locked} />
            <span>Burn captions into the exported video</span>
          </label>
          <button className="btn cap-danger" disabled={track.locked || !count} onClick={() => edit((d) => cops.clearCaptions(d, track.id))} data-testid="cap-clear">
            Remove all captions
          </button>
        </>
      )}
      <p className="cap-note">{count} captions on the timeline.</p>
    </div>
  );
}

export function CaptionsTab() {
  const [cat, setCat] = usePref('lib.captions.cat', 'auto');
  return (
    <LibraryBody sidebar={SIDEBAR} value={cat} onChange={setCat}>
      {cat === 'styles' ? <Styles /> : cat === 'files' ? <Files /> : <AutoCaptions />}
    </LibraryBody>
  );
}
