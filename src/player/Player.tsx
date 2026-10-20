/**
 * Centre player (CapCut desktop): header "Player", letterboxed canvas, bottom bar with
 * current / total timecode, Play/Pause, zoom (Fit / %), Ratio menu and fullscreen.
 * The canvas is driven by PreviewEngine (getFrameState → renderFrame). On-canvas: click selects
 * the topmost clip; the selected clip gets a box with corner scale handles and a rotate handle;
 * drag to move with centre snap guides. Every gesture is one undo step (beginTx … commitTx).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DrawnBox } from '../engine/render';
import { hitTest, letterbox, moveWithSnap, rotateFromDrag, scaleFromDrag, scaleXYFromDrag, type Pt } from '../engine/render/geometry';
import { ASPECTS, LIMITS } from '../model/catalog';
import { findClip } from '../model/project';
import { formatTimecode, projectDuration } from '../model/time';
import type { Id } from '../model/types';
import { useEditor } from '../store';
import { withShortcut } from '../timeline/shortcutDefs';
import { onAppEvent } from '../ui/appEvents';
import { Icon } from '../ui/Icon';
import { MaskOverlay } from './MaskOverlay';
import { PreviewEngine } from './PreviewEngine';
import { SourcePlayer, useSourcePreview } from './sourcePreview';
import './player.css';

type ZoomMode = 'fit' | 0.5 | 1.5 | 2;
const ZOOMS: { id: ZoomMode; label: string }[] = [
  { id: 'fit', label: 'Fit' },
  { id: 0.5, label: '50%' },
  { id: 1.5, label: '150%' },
  { id: 2, label: '200%' },
];

type Gesture =
  | { kind: 'move'; clipId: Id; startPt: Pt; startX: number; startY: number }
  | { kind: 'scale'; clipId: Id; startPt: Pt; startScale: number; centre: Pt; uniform: boolean; startScaleX: number; startScaleY: number }
  | { kind: 'rotate'; clipId: Id; startPt: Pt; startRotation: number; centre: Pt };

const sameBox = (a: DrawnBox | null, b: DrawnBox | null) =>
  a === b || (!!a && !!b && a.clipId === b.clipId && a.cx === b.cx && a.cy === b.cy && a.w === b.w && a.h === b.h && a.rotation === b.rotation);

export function Player() {
  const settings = useEditor((s) => s.project.settings);
  const duration = useEditor((s) => projectDuration(s.project));
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => (s.selection.clipIds.length === 1 ? s.selection.clipIds[0]! : null));
  const togglePlay = useEditor((s) => s.togglePlay);
  const setAspectRatio = useEditor((s) => s.setAspectRatio);
  // source preview (a media-bin item clicked): the canvas shows that file, not the timeline
  const srcId = useSourcePreview((s) => s.assetId);
  const srcName = useEditor((s) => (srcId ? s.project.assets[srcId]?.name ?? '' : ''));
  const srcKind = useEditor((s) => (srcId ? s.project.assets[srcId]?.kind ?? null : null));
  const srcPlaying = useSourcePreview((s) => s.playing);
  const srcTime = useSourcePreview((s) => s.time);
  const srcDuration = useSourcePreview((s) => s.duration);
  const sourceRef = useRef<SourcePlayer | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const boxesRef = useRef<DrawnBox[]>([]);
  const selectedRef = useRef<Id | null>(selectedId);
  selectedRef.current = selectedId;

  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<ZoomMode>('fit');
  const [menu, setMenu] = useState<'ratio' | 'zoom' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [selBox, setSelBox] = useState<DrawnBox | null>(null);
  const [guides, setGuides] = useState({ x: false, y: false });
  const gestureRef = useRef<Gesture | null>(null);

  // ---- engine lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new PreviewEngine(canvas, {
      onBoxes: (boxes) => {
        boxesRef.current = boxes;
        const id = selectedRef.current;
        const box = id ? boxes.find((b) => b.clipId === id) ?? null : null;
        setSelBox((prev) => (sameBox(prev, box) ? prev : box));
      },
    });
    engineRef.current = engine;
    engine.start();
    const source = new SourcePlayer(canvas, (on) => engine.setSuspended(on));
    sourceRef.current = source;
    return () => {
      source.dispose();
      sourceRef.current = null;
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // selection changed → overlay follows (engine boxes are from the last render)
  useEffect(() => {
    const box = selectedId ? boxesRef.current.find((b) => b.clipId === selectedId) ?? null : null;
    setSelBox((prev) => (sameBox(prev, box) ? prev : box));
  }, [selectedId]);

  // ---- stage size
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = letterbox(stage.w, stage.h, settings.width, settings.height, fullscreen ? 0 : 12);
  const zk = zoom === 'fit' ? 1 : zoom;
  const cw = Math.floor(fit.width * zk);
  const ch = Math.floor(fit.height * zk);
  const k = settings.width > 0 ? cw / settings.width : 0; // css px per project px

  useEffect(() => {
    engineRef.current?.resize(cw, ch, window.devicePixelRatio || 1);
    sourceRef.current?.redraw();
  }, [cw, ch, settings.width, settings.height]);

  // ---- fullscreen
  useEffect(() => {
    const on = () => setFullscreen(!!rootRef.current && document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  };
  // ⌘⇧F / ⌃⌘F (full screen) and ⌥⇧Z (fit preview to window) from the shortcut table.
  // Synchronous listeners: requestFullscreen still sees the keydown's user activation.
  useEffect(() => {
    const offFs = onAppEvent('fullscreenPreview', () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
    });
    const offFit = onAppEvent('fitPreview', () => setZoom('fit'));
    return () => {
      offFs();
      offFit();
    };
  }, []);

  // ---- menus close on outside click
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.player__menu-anchor')) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  // ---- pointer → project coordinates
  const toProject = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const r = surfaceRef.current?.getBoundingClientRect();
      if (!r || k <= 0) return { x: 0, y: 0 };
      return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
    },
    [k],
  );

  const clipEditable = (id: Id): boolean => {
    const s = useEditor.getState();
    const f = findClip(s.project, id);
    return !!f && !f.track.locked && f.clip.type !== 'audio';
  };

  const beginGesture = (g: Gesture, e: React.PointerEvent) => {
    if (!clipEditable(g.clipId)) return;
    surfaceRef.current?.setPointerCapture?.(e.pointerId);
    gestureRef.current = g;
    useEditor.getState().beginTx();
  };

  const onSurfaceDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const pt = toProject(e);
    const hit = hitTest(boxesRef.current, pt);
    const s = useEditor.getState();
    if (!hit) {
      s.clearSelection();
      return;
    }
    if (e.shiftKey) {
      s.select([hit.clipId], 'toggle');
      return;
    }
    if (!s.selection.clipIds.includes(hit.clipId) || s.selection.clipIds.length !== 1) s.select([hit.clipId], 'replace');
    const clip = findClip(s.project, hit.clipId)?.clip;
    if (!clip || clip.type === 'audio') return;
    beginGesture({ kind: 'move', clipId: hit.clipId, startPt: pt, startX: clip.transform.x, startY: clip.transform.y }, e);
  };

  const onHandleDown = (kind: 'scale' | 'rotate') => (e: React.PointerEvent) => {
    if (e.button !== 0 || !selBox) return;
    e.stopPropagation();
    const clip = findClip(useEditor.getState().project, selBox.clipId)?.clip;
    if (!clip || clip.type === 'audio') return;
    const centre = { x: selBox.cx, y: selBox.cy };
    const startPt = toProject(e);
    const tf = clip.transform;
    if (kind === 'scale')
      beginGesture({ kind, clipId: clip.id, startPt, startScale: tf.scale, centre, uniform: tf.uniformScale !== false, startScaleX: tf.scaleX ?? tf.scale, startScaleY: tf.scaleY ?? tf.scale }, e);
    else beginGesture({ kind, clipId: clip.id, startPt, startRotation: clip.transform.rotation, centre }, e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const pt = toProject(e);
    const s = useEditor.getState();
    if (g.kind === 'move') {
      const threshold = k > 0 && !e.altKey ? 8 / k : -1;
      const m = moveWithSnap({ x: g.startX, y: g.startY }, { x: pt.x - g.startPt.x, y: pt.y - g.startPt.y }, threshold);
      setGuides((p) => (p.x === m.guideX && p.y === m.guideY ? p : { x: m.guideX, y: m.guideY }));
      s.updateClip(g.clipId, { transform: { x: m.x, y: m.y } });
    } else if (g.kind === 'scale') {
      if (g.uniform) s.updateClip(g.clipId, { transform: { scale: scaleFromDrag(g.startScale, g.centre, g.startPt, pt, LIMITS.scaleMin, LIMITS.scaleMax) } });
      else s.updateClip(g.clipId, { transform: scaleXYFromDrag(g.startScaleX, g.startScaleY, g.centre, g.startPt, pt, LIMITS.scaleMin, LIMITS.scaleMax) });
    } else {
      s.updateClip(g.clipId, { transform: { rotation: rotateFromDrag(g.startRotation, g.centre, g.startPt, pt, e.altKey ? 0 : 4) } });
    }
  };

  const endGesture = (cancel: boolean) => {
    if (!gestureRef.current) return;
    gestureRef.current = null;
    setGuides({ x: false, y: false });
    const s = useEditor.getState();
    if (cancel) s.cancelTx();
    else s.commitTx();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gestureRef.current) {
        e.stopPropagation();
        endGesture(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---- render
  const inSource = srcId !== null;
  const total = formatTimecode(inSource ? srcDuration : duration, settings.fps);
  const current = inSource ? formatTimecode(Math.min(srcTime, srcDuration), settings.fps) : formatTimecode(Math.min(playhead, duration), settings.fps);
  const isPlaying = inSource ? srcPlaying : playing;
  const onPlay = () => (inSource ? useSourcePreview.getState().togglePlay() : togglePlay());
  const zoomLabel = ZOOMS.find((z) => z.id === zoom)?.label ?? 'Fit';

  return (
    <div className={`player${fullscreen ? ' is-fullscreen' : ''}${inSource ? ' is-source' : ''}`} ref={rootRef} data-mode={inSource ? 'source' : 'timeline'}>
      {!fullscreen && (
        <div className="panel__header" data-testid="player-header">
          {inSource ? `Media · ${srcName}` : 'Player'}
        </div>
      )}
      <div className={`player__stage${zoom === 'fit' ? '' : ' is-zoomed'}`} ref={stageRef}>
        <div className="player__canvas-wrap" style={{ width: cw, height: ch }}>
          <canvas ref={canvasRef} className="player__canvas" data-testid="player-canvas" />
          <div
            ref={surfaceRef}
            hidden={inSource}
            className="player__surface"
            onPointerDown={onSurfaceDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => endGesture(false)}
            onPointerCancel={() => endGesture(true)}
          >
            {guides.x && <div className="player__guide player__guide--v" />}
            {guides.y && <div className="player__guide player__guide--h" />}
            {selBox && k > 0 && (
              <div
                className="player__selbox"
                data-testid="player-selection"
                style={{
                  left: (selBox.cx - selBox.w / 2) * k,
                  top: (selBox.cy - selBox.h / 2) * k,
                  width: selBox.w * k,
                  height: selBox.h * k,
                  transform: `rotate(${selBox.rotation}deg)`,
                }}
              >
                {(['nw', 'ne', 'se', 'sw'] as const).map((c) => (
                  <div key={c} className={`player__handle player__handle--${c}`} onPointerDown={onHandleDown('scale')} />
                ))}
                <div className="player__rotate" title="Rotate" onPointerDown={onHandleDown('rotate')}>
                  <Icon name="rotate" size={12} />
                </div>
              </div>
            )}
            {selBox && k > 0 && <MaskOverlay box={selBox} k={k} toProject={toProject} />}
          </div>
        </div>
      </div>
      {inSource && srcKind !== 'image' && (
        <input
          type="range"
          className="player__seek"
          data-testid="source-seek"
          aria-label="Seek source"
          min={0}
          max={Math.max(1, srcDuration)}
          step={1000}
          value={Math.min(srcTime, srcDuration)}
          onChange={(e) => useSourcePreview.getState().seek(Number(e.target.value))}
        />
      )}
      <div className="player__bar">
        <span className="player__tc" data-testid="timecode">
          <span className="player__tc-cur">{current}</span>
          <span className="player__tc-sep"> / </span>
          <span className="player__tc-total">{total}</span>
        </span>
        <button
          className="icon-btn player__play"
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          data-testid="play-button"
          onClick={onPlay}
        >
          <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
        </button>
        <div className="player__right">
          <div className="player__menu-anchor">
            <button className="btn btn--ghost player__chip" title={withShortcut('Zoom (fit to window)', 'fitPreview')} onClick={() => setMenu(menu === 'zoom' ? null : 'zoom')} data-testid="player-zoom">
              {zoomLabel}
            </button>
            {menu === 'zoom' && (
              <div className="menu player__menu">
                {ZOOMS.map((z) => (
                  <button
                    key={String(z.id)}
                    className={`menu__item${z.id === zoom ? ' is-active' : ''}`}
                    onClick={() => {
                      setZoom(z.id);
                      setMenu(null);
                    }}
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="player__menu-anchor">
            <button className="btn btn--ghost player__chip" title="Aspect ratio" onClick={() => setMenu(menu === 'ratio' ? null : 'ratio')} data-testid="player-ratio">
              Ratio
            </button>
            {menu === 'ratio' && (
              <div className="menu player__menu" data-testid="player-ratio-menu">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    className={`menu__item player__ratio-item${a.id === settings.aspect ? ' is-active' : ''}`}
                    onClick={() => {
                      setAspectRatio(a.id);
                      setMenu(null);
                    }}
                  >
                    <span className="player__ratio-swatch" style={{ aspectRatio: `${a.width} / ${a.height}` }} />
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" title={fullscreen ? 'Exit full screen (Esc)' : withShortcut('Full screen', 'fullscreenPreview')} onClick={toggleFullscreen} data-testid="player-fullscreen">
            <Icon name={fullscreen ? 'exit-fullscreen' : 'fullscreen'} />
          </button>
        </div>
      </div>
    </div>
  );
}
