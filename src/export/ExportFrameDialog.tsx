/**
 * Player ⋯ › Export frame…: saves the frame at the playhead as PNG / JPEG / WebP at the project's
 * size into a folder on this Mac (default ~/Downloads; Finder picks another, remembered). Format and
 * quality are remembered too.
 * The frame is rendered once when the dialog opens: the preview shows it, Export saves that render.
 */
import { useEffect, useRef, useState } from 'react';
import { formatTimecode } from '../model/time';
import { usePref } from '../panels/prefs';
import { useEditor } from '../store';
import { showToast } from '../ui/appEvents';
import { Icon } from '../ui/Icon';
import {
  chooseFolder,
  downloadBlob,
  encodeStill,
  FRAME_FORMATS,
  frameFileName,
  renderStill,
  saveDefaults,
  saveToFolder,
  tildePath,
  type FrameFormat,
} from './exportFrame';

/** The preview fits 408 × 240 px (the dialog's width; a portrait frame is limited by height). */
function previewBox(w: number, h: number): { width: number; height: number } {
  const k = Math.min(408 / w, 240 / h);
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

export function ExportFrameDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  // the frame is the one under the playhead when the dialog opened
  const t = useRef(useEditor.getState().playhead).current;
  const [format, setFormat] = usePref<FrameFormat>('frameExport.format', 'png');
  const [quality, setQuality] = usePref<number>('frameExport.quality', 92);
  const [name, setName] = useState(() => frameFileName(project.name, t, project.settings.fps, format));
  // '' = Downloads; the server's defaults arrive async (null = this server cannot save → download)
  const [savedDir, setSavedDir] = usePref<string>('frameExport.dir', '');
  const [defaults, setDefaults] = useState<{ home: string; downloads: string } | null | undefined>(undefined);
  const dir = savedDir || defaults?.downloads || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [still, setStill] = useState<OffscreenCanvas | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const info = FRAME_FORMATS.find((f) => f.id === format)!;

  useEffect(() => {
    void saveDefaults().then(setDefaults);
  }, []);
  // render the frame once, at full size
  useEffect(() => {
    let live = true;
    renderStill(project, t)
      .then((c) => live && setStill(c))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []); // once: the frame of the moment the dialog opened
  // draw it into the preview, scaled to the preview's pixels
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !still) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
    const ctx = cv.getContext('2d');
    ctx?.drawImage(still, 0, 0, cv.width, cv.height);
  }, [still]);
  // the extension follows the format
  useEffect(() => {
    setName((n) => n.replace(/\.(png|jpe?g|webp)$/i, '') + `.${info.ext}`);
  }, [info.ext]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const [choosing, setChoosing] = useState(false);
  const choose = async () => {
    setChoosing(true);
    try {
      const d = await chooseFolder(dir);
      if (d) setSavedDir(d === defaults?.downloads ? '' : d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChoosing(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const canvas = still ?? (await renderStill(project, t));
      const blob = await encodeStill(canvas, format, quality / 100);
      if (defaults && dir) {
        const written = await saveToFolder(dir, name.trim(), blob);
        showToast(`Frame saved: ${tildePath(written, defaults.home)}`);
      } else {
        downloadBlob(blob, name);
        showToast(`Frame downloaded: ${name}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal frame-export" role="dialog" aria-modal="true" aria-label="Export frame" data-testid="frame-export-dialog">
        <div className="modal__head">
          <span>Export frame</span>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        <div className="frame-export__body">
          <div className="frame-export__preview" style={previewBox(project.settings.width, project.settings.height)}>
            <canvas ref={previewRef} data-testid="frame-export-preview" data-ready={still ? 'true' : 'false'} />
            {!still && !error && <span className="frame-export__loading">Rendering frame…</span>}
          </div>
          <div className="export__row">
            <span className="export__label">Frame</span>
            <span className="export__value">
              {formatTimecode(t, project.settings.fps)} · {project.settings.width}×{project.settings.height}
            </span>
          </div>
          <label className="export__row">
            <span className="export__label">Name</span>
            <input className="export__input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} disabled={busy} data-testid="frame-export-name" />
          </label>
          <label className="export__row">
            <span className="export__label">Format</span>
            <select className="export__select" value={format} onChange={(e) => setFormat(e.target.value as FrameFormat)} disabled={busy} data-testid="frame-export-format">
              {FRAME_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {info.lossy && (
            <label className="export__row">
              <span className="export__label">Quality</span>
              <span className="frame-export__quality">
                <input type="range" min={50} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={busy} data-testid="frame-export-quality" />
                <span className="export__value">{quality}%</span>
              </span>
            </label>
          )}
          <div className="export__row">
            <span className="export__label">Folder</span>
            {defaults ? (
              <span className="frame-export__folder">
                <span className="export__value frame-export__folder-name" dir="auto" title={dir} data-testid="frame-export-folder">
                  {tildePath(dir, defaults.home)}
                </span>
                {savedDir && (
                  <button className="btn" onClick={() => setSavedDir('')} disabled={busy || choosing} title="Back to Downloads" data-testid="frame-export-downloads">
                    Downloads
                  </button>
                )}
                <button className="btn" onClick={() => void choose()} disabled={busy || choosing} data-testid="frame-export-choose">
                  {choosing ? 'Choosing…' : 'Change…'}
                </button>
              </span>
            ) : (
              <span className="export__value">{defaults === undefined ? '…' : 'Downloads (browser download)'}</span>
            )}
          </div>
          {error && <div className="frame-export__error">{error}</div>}
        </div>
        <div className="modal__foot">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => void save()} disabled={busy || !name.trim() || !still} data-testid="frame-export-save">
            {busy ? 'Saving…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
