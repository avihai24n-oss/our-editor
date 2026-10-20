/**
 * Export dialog (CapCut layout): cover on the left; Name, then a Video section with Resolution,
 * Bit rate, Codec, Format, Frame rate; duration + size estimate in the footer. Export renders
 * every frame offline (see runExport.ts) with a progress bar and Cancel, then downloads the file.
 * Interface fixed by the shell: { open, onClose }.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { rootProject } from '../model/compound';
import { formatTimecode, projectDuration } from '../model/time';
import { useEditor } from '../store';
import { Icon } from '../ui/Icon';
import type { ExportProgress, RunExportResult } from './runExport';
import {
  defaultExportSettings,
  estimateBytes,
  exportFileName,
  formatBytes,
  FRAME_RATES,
  outputSize,
  QUALITIES,
  RESOLUTIONS,
  videoBitrate,
  type ExportFps,
  type ExportSettings,
  type QualityId,
  type ResolutionId,
} from './settings';
import './export.css';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Stage =
  | { kind: 'form' }
  | { kind: 'running'; progress: ExportProgress }
  | { kind: 'done'; result: RunExportResult; fileName: string; seconds: number }
  | { kind: 'error'; message: string };

const PHASE_LABEL: Record<ExportProgress['phase'], string> = {
  preparing: 'Preparing…',
  audio: 'Mixing audio…',
  video: 'Rendering video…',
  finishing: 'Finishing…',
};

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const project = useEditor((s) => s.project);
  const duration = projectDuration(rootProject(project)); // the main timeline, even inside a compound clip
  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(project.name, project.settings.fps));
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const abortRef = useRef<AbortController | null>(null);
  const coverRef = useRef<HTMLCanvasElement>(null);
  const blobRef = useRef<{ blob: Blob; name: string } | null>(null);

  const size = outputSize(project.settings.width, project.settings.height, settings.resolution);
  const vBitrate = videoBitrate(size.width, size.height, settings.fps, settings.quality);
  const estimate = useMemo(() => estimateBytes(duration, vBitrate, true), [duration, vBitrate]);
  const running = stage.kind === 'running';
  // no WebCodecs → runExport records WebM with MediaRecorder; say so before the user exports
  const webm = typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined';

  // cover = a snapshot of the player's current frame
  useEffect(() => {
    if (!open) return;
    const src = document.querySelector<HTMLCanvasElement>('[data-testid="player-canvas"]');
    const dst = coverRef.current;
    if (!src || !dst || !src.width || !src.height) return;
    const k = Math.min(dst.width / src.width, dst.height / src.height);
    const ctx = dst.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, dst.width, dst.height);
    const w = src.width * k;
    const h = src.height * k;
    try {
      ctx.drawImage(src, (dst.width - w) / 2, (dst.height - h) / 2, w, h);
    } catch {
      /* tainted or empty canvas: keep the black cover */
    }
  }, [open]);

  // closing the dialog cancels a running export
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!open) return null;

  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  async function start() {
    if (duration <= 0 || running) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const t0 = performance.now();
    setStage({ kind: 'running', progress: { phase: 'preparing', fraction: 0, frame: 0, frames: 0 } });
    let last = 0;
    try {
      const { runExport } = await import('./runExport');
      const snapshot = useEditor.getState().project;
      const result = await runExport({
        project: snapshot,
        settings,
        signal: ac.signal,
        onProgress: (p) => {
          const now = performance.now();
          if (now - last < 80 && p.fraction < 1) return; // ~12 UI updates/s
          last = now;
          setStage({ kind: 'running', progress: p });
        },
      });
      const fileName = exportFileName(settings.fileName || project.name, result.ext);
      blobRef.current = { blob: result.blob, name: fileName };
      const { downloadBlob } = await import('./exportMp4');
      downloadBlob(result.blob, fileName);
      setStage({ kind: 'done', result, fileName, seconds: (performance.now() - t0) / 1000 });
    } catch (e) {
      if (ac.signal.aborted || (e instanceof Error && e.name === 'ExportCanceled')) setStage({ kind: 'form' });
      else setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }

  const progress = stage.kind === 'running' ? stage.progress : null;
  const pct = progress ? Math.floor(progress.fraction * 100) : 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal export" role="dialog" aria-modal="true" aria-label="Export" data-testid="export-dialog">
        <div className="modal__head">
          <span>Export</span>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </div>

        <div className="export__body">
          <div className="export__cover">
            <canvas ref={coverRef} width={180} height={240} />
            <span className="export__cover-label">Cover</span>
          </div>

          <div className="export__form">
            <label className="export__row">
              <span className="export__label">Name</span>
              <input
                className="export__input"
                value={settings.fileName}
                onChange={(e) => set('fileName', e.target.value)}
                disabled={running}
                spellCheck={false}
                data-testid="export-name"
              />
            </label>

            <div className="export__section">
              <div className="export__section-title">
                <Icon name="check" size={14} /> Video
              </div>
              <label className="export__row">
                <span className="export__label">Resolution</span>
                <select className="export__select" value={settings.resolution} onChange={(e) => set('resolution', e.target.value as ResolutionId)} disabled={running} data-testid="export-resolution">
                  {RESOLUTIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="export__row">
                <span className="export__label">Bit rate</span>
                <select className="export__select" value={settings.quality} onChange={(e) => set('quality', e.target.value as QualityId)} disabled={running}>
                  {QUALITIES.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="export__row">
                <span className="export__label">Codec</span>
                <span className="export__value" data-testid="export-codec">{webm ? 'VP9 (fallback)' : 'H.264'}</span>
              </div>
              <div className="export__row">
                <span className="export__label">Format</span>
                <span className="export__value" data-testid="export-format">{webm ? 'WebM' : 'MP4'}</span>
              </div>
              <label className="export__row">
                <span className="export__label">Frame rate</span>
                <select className="export__select" value={settings.fps} onChange={(e) => set('fps', Number(e.target.value) as ExportFps)} disabled={running} data-testid="export-fps">
                  {FRAME_RATES.map((f) => (
                    <option key={f} value={f}>
                      {f}fps
                    </option>
                  ))}
                </select>
              </label>
              <div className="export__hint">
                {size.width}×{size.height} · {(vBitrate / 1e6).toFixed(1)} Mbps · {webm ? 'Opus' : 'AAC'} 192 kbps
              </div>
            </div>

            {stage.kind === 'error' && (
              <div className="export__error" role="alert">
                {stage.message}
              </div>
            )}
            {stage.kind === 'done' && (
              <div className="export__done">
                <Icon name="check" size={14} /> Exported <b>{stage.fileName}</b> ({formatBytes(stage.result.blob.size)}) in {stage.seconds.toFixed(1)} s.
                {stage.result.fallback && <div className="export__hint">Saved as WebM (this browser has no MP4 encoder). Some players cannot seek in it.</div>}
                <button className="btn btn--ghost export__again" onClick={() => blobRef.current && void import('./exportMp4').then((m) => m.downloadBlob(blobRef.current!.blob, blobRef.current!.name))}>
                  Download again
                </button>
              </div>
            )}
            {progress && (
              <div className="export__progress" data-testid="export-progress">
                <div className="export__progress-head">
                  <span>{PHASE_LABEL[progress.phase]}</span>
                  <span>
                    {progress.frames > 0 && `${progress.frame} / ${progress.frames} · `}
                    {pct}%
                  </span>
                </div>
                <div className="export__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className="export__bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal__foot export__foot">
          <span className="export__meta">
            Duration: {formatTimecode(duration, project.settings.fps)} · Size: about {formatBytes(estimate)}
          </span>
          {running ? (
            <button className="btn" onClick={() => abortRef.current?.abort()} data-testid="export-cancel">
              Cancel
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {stage.kind === 'done' ? 'Close' : 'Cancel'}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void start()}
                disabled={duration <= 0}
                title={duration <= 0 ? 'Add media to the timeline first' : 'Export'}
                data-testid="export-confirm"
              >
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
