/**
 * Timeline toolbar (CapCut screenshot 08 + right half of 01).
 * Left: Select ▾ | Undo Redo | Split, Delete left, Delete right, Delete | Marker, Mirror, Rotate.
 * Right: Main-track magnet, Auto snapping, Linkage, Preview axis | Zoom − / slider / + , Zoom to fit.
 */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { findClip } from '../model/project';
import { clipContains } from '../model/time';
import { selectCanRedo, selectCanUndo, useEditor } from '../store';
import { Icon, type IconName } from '../ui/Icon';
import { SLIDER_MAX, sliderToZoom, zoomToSlider } from './geometry';
import { useTimelineUi } from './uiStore';

interface ToolProps {
  icon: IconName;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}

function Tool({ icon, title, onClick, disabled, active, testId }: ToolProps) {
  return (
    <button
      type="button"
      className={`icon-btn tl-tool${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      // keep keyboard focus off toolbar buttons so Space stays play/pause
      onMouseDown={(e) => e.preventDefault()}
    >
      <Icon name={icon} />
    </button>
  );
}

const Divider = () => <span className="tl-toolbar__divider" aria-hidden />;

export function Toolbar() {
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const { zoom, magnet, snapping } = useEditor(useShallow((s) => ({ zoom: s.zoom, magnet: s.magnet, snapping: s.snapping })));
  const hasSelection = useEditor((s) => s.selection.clipIds.length > 0 || s.selection.transitionId !== null);
  const hasVisualSelection = useEditor((s) =>
    s.selection.clipIds.some((id) => {
      const c = findClip(s.project, id)?.clip;
      return !!c && c.type !== 'audio';
    }),
  );
  // Split / Q / W have something to act on when any unlocked clip is under the playhead.
  const somethingUnderPlayhead = useEditor((s) =>
    s.project.tracks.some((t) => !t.locked && t.clips.some((c) => clipContains(c, s.playhead) && c.start !== s.playhead)),
  );
  const { tool, setTool, linkage, setLinkage, previewAxis, setPreviewAxis, view } = useTimelineUi();
  const a = useEditor.getState;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  return (
    <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
      <div className="tl-toolbar__group">
        <div className="tl-select" ref={menuRef}>
          <button
            type="button"
            className="icon-btn tl-select__btn"
            title={tool === 'split' ? 'Split mode (B)' : 'Select (A)'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenuOpen((o) => !o)}
            data-testid="timeline-tool-menu"
          >
            <Icon name={tool === 'split' ? 'split' : 'select'} />
            <Icon name="chevron-down" size={12} />
          </button>
          {menuOpen && (
            <div className="menu tl-select__menu" role="menu">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={tool === 'select'}
                className={`menu__item${tool === 'select' ? ' is-active' : ''}`}
                onClick={() => {
                  setTool('select');
                  setMenuOpen(false);
                }}
              >
                <Icon name="select" size={14} /> Select <kbd>A</kbd>
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={tool === 'split'}
                className={`menu__item${tool === 'split' ? ' is-active' : ''}`}
                onClick={() => {
                  setTool('split');
                  setMenuOpen(false);
                }}
              >
                <Icon name="split" size={14} /> Split <kbd>B</kbd>
              </button>
            </div>
          )}
        </div>
        <Divider />
        <Tool icon="undo" title="Undo (⌘Z)" onClick={() => a().undo()} disabled={!canUndo} testId="timeline-undo" />
        <Tool icon="redo" title="Redo (⇧⌘Z)" onClick={() => a().redo()} disabled={!canRedo} testId="timeline-redo" />
        <Tool icon="split" title="Split (⌘B)" onClick={() => void a().splitAtPlayhead()} disabled={!somethingUnderPlayhead} testId="timeline-split" />
        <Tool icon="delete-left" title="Delete left (Q)" onClick={() => a().deleteLeft()} disabled={!somethingUnderPlayhead} />
        <Tool icon="delete-right" title="Delete right (W)" onClick={() => a().deleteRight()} disabled={!somethingUnderPlayhead} />
        <Tool icon="trash" title="Delete (⌫)" onClick={() => a().deleteSelected()} disabled={!hasSelection} testId="timeline-delete" />
        <Tool icon="marker" title="Add marker (M)" onClick={() => void a().addMarker()} />
        <Tool icon="mirror" title="Mirror" onClick={() => a().mirrorSelected()} disabled={!hasVisualSelection} />
        <Tool icon="rotate" title="Rotate 90°" onClick={() => a().rotateSelected(90)} disabled={!hasVisualSelection} />
      </div>

      <div className="tl-toolbar__group">
        <Tool icon="magnet" title={`Main track magnet (P): ${magnet ? 'on' : 'off'}`} active={magnet} onClick={() => a().setMagnet(!magnet)} testId="timeline-magnet" />
        <Tool icon="snap" title={`Auto snapping (N): ${snapping ? 'on' : 'off'}`} active={snapping} onClick={() => a().setSnapping(!snapping)} testId="timeline-snapping" />
        <Tool icon={linkage ? 'link' : 'unlink'} title={`Linkage: ${linkage ? 'on' : 'off'}`} active={linkage} onClick={() => setLinkage(!linkage)} />
        <Tool icon="preview-axis" title={`Preview axis (S): ${previewAxis ? 'on' : 'off'}`} active={previewAxis} onClick={() => setPreviewAxis(!previewAxis)} />
        <Divider />
        <Tool icon="zoom-out" title="Zoom out (⌘−)" onClick={() => view?.zoomBy(1 / 1.25)} />
        <input
          type="range"
          className="tl-zoom"
          min={0}
          max={SLIDER_MAX}
          value={zoomToSlider(zoom)}
          aria-label="Timeline zoom"
          onChange={(e) => view?.zoomTo(sliderToZoom(Number(e.target.value)))}
          onKeyDown={(e) => e.stopPropagation()}
          data-testid="timeline-zoom"
        />
        <Tool icon="zoom-in" title="Zoom in (⌘=)" onClick={() => view?.zoomBy(1.25)} />
        <Tool icon="zoom-fit" title="Zoom to fit (⇧Z)" onClick={() => view?.fit()} testId="timeline-fit" />
      </div>
    </div>
  );
}
