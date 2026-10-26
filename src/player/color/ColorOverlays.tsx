/**
 * Player overlays of Adjust › Color: the before/after split divider (drag to move) and the
 * qualifier eyedropper (click the picture to key that colour; Shift-click adds it to the range).
 */
import { useEffect, useRef } from 'react';
import { findClip } from '../../model/project';
import { useEditor } from '../../store';
import { activePreviewEngine } from '../PreviewEngine';
import { pickStageInput, useColorView } from './colorView';
import { qualifierFromPick } from './qualifierPick';
import { ScopesPanel } from './ScopesPanel';

export function SplitOverlay() {
  const pos = useColorView((s) => s.splitPos);
  const setPos = useColorView((s) => s.setSplitPos);
  const ref = useRef<HTMLDivElement>(null);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (r && r.width > 0) setPos((ev.clientX - r.left) / r.width);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div className="csplit" ref={ref} data-testid="color-split">
      <span className="csplit__label" style={{ left: 8 }}>
        Before
      </span>
      <span className="csplit__label" style={{ right: 8 }}>
        After
      </span>
      <div className="csplit__line" style={{ left: `${pos * 100}%` }} />
      <div className="csplit__handle" style={{ left: `${pos * 100}%` }} onPointerDown={onDown} data-testid="color-split-handle" title="Drag to move the split">
        ⇔
      </div>
    </div>
  );
}

export function PickOverlay({ clipId }: { clipId: string }) {
  const setPick = useColorView((s) => s.setPick);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPick(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setPick]);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) {
      setPick(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const rgb = pickStageInput(clipId, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    setPick(null);
    if (!rgb) return;
    const st = useEditor.getState();
    const clip = findClip(st.project, clipId)?.clip;
    if (!clip || clip.type === 'audio') return;
    const color = clip.grade.color;
    st.updateClip(clipId, { grade: { color: { ...color, qualifier: qualifierFromPick(rgb, color.qualifier, e.shiftKey) } } });
  };
  return (
    <div className="cpick" onPointerDown={onDown} onContextMenu={(e) => e.preventDefault()} data-testid="color-pick-overlay">
      <span className="cpick__hint">Click a colour to qualify it · Shift-click to add · Esc to cancel</span>
    </div>
  );
}

// ---------------------------------------------------------------- what Player.tsx mounts

/** Inside the canvas box: split divider + eyedropper; re-renders the preview when they change. */
export function ColorCanvasOverlays({ hidden }: { hidden: boolean }) {
  const split = useColorView((s) => s.split);
  const pick = useColorView((s) => s.pickClipId);
  useEffect(
    () =>
      useColorView.subscribe((s, prev) => {
        if (s.split !== prev.split || s.splitPos !== prev.splitPos || s.scopes !== prev.scopes || s.kinds !== prev.kinds) activePreviewEngine()?.invalidate();
      }),
    [],
  );
  if (hidden) return null;
  return (
    <>
      {split && <SplitOverlay />}
      {pick && <PickOverlay clipId={pick} />}
    </>
  );
}

/** Player bar chips: Scopes and Before/After split. */
export function ColorBarButtons() {
  const scopes = useColorView((s) => s.scopes);
  const split = useColorView((s) => s.split);
  const st = useColorView.getState();
  return (
    <>
      <button
        className={`btn btn--ghost player__chip${scopes ? ' is-on' : ''}`}
        title="Video scopes (waveform, parade, vectorscope, histogram)"
        aria-pressed={scopes}
        onClick={() => st.setScopes(!scopes)}
        data-testid="player-scopes"
      >
        Scopes
      </button>
      <button
        className={`btn btn--ghost player__chip${split ? ' is-on' : ''}`}
        title="Before / after split (left: no colour adjustments)"
        aria-pressed={split}
        onClick={() => st.setSplit(!split)}
        data-testid="player-split"
      >
        Split
      </button>
    </>
  );
}

/** The scopes strip under the stage (when Scopes is on). */
export function ScopesDock({ hidden }: { hidden: boolean }) {
  const scopes = useColorView((s) => s.scopes);
  return scopes && !hidden ? <ScopesPanel /> : null;
}
