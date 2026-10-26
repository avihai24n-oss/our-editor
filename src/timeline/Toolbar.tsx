/**
 * Timeline toolbar (CapCut screenshot 08 + right half of 01).
 * Left: tool ▾ (Select / Split / Select leftward / Select rightward, ./tools.ts) | Undo Redo | Split, Delete left, Delete right, Delete | Marker, Mirror, Rotate.
 * Right: Main-track magnet, Auto snapping, Linkage, Preview axis | Zoom − / slider / + , Zoom to fit.
 */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { findClip } from '../model/project';
import { clipContains } from '../model/time';
import { selectCanRedo, selectCanUndo, useEditor } from '../store';
import { Icon, type IconName } from '../ui/Icon';
import { SLIDER_MAX, sliderToZoom, zoomToSlider } from './geometry';
import { shortcutLabel, withShortcut as ws, type Command } from './shortcutDefs';
import { TOOLS, toolDef } from './tools';
import { TRACK_SCALE_MAX, TRACK_SCALE_MIN, useTimelineUi } from './uiStore';

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

interface ToggleProps {
  icon: IconName;
  /** Lower-case feature name, as CapCut's tooltip writes it: "Turn off main track magnet(P)". */
  name: string;
  command: Command;
  on: boolean;
  onChange: (on: boolean) => void;
  testId: string;
  /**
   * When set, a ▾ button is joined on the right (CapCut's linkage and preview-axis toggles).
   * CapCut's dropdown contents are not documented anywhere we could check, so the menu only
   * repeats this toggle with a checkmark rather than inventing options.
   */
  menuLabel?: string;
  /** What the toggle does, added to the tooltip after the CapCut text. */
  hint?: string;
}

/** CapCut toggle tile: ON = cyan glyph on a lighter rounded tile, OFF = plain light glyph. */
function Toggle({ icon, name, command, on, onChange, testId, menuLabel, hint }: ToggleProps) {
  const key = shortcutLabel(command);
  const label = `Turn ${on ? 'off' : 'on'} ${name}${key ? `(${key})` : ''}`;
  const title = hint ? `${label}: ${hint}` : label;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className={`tl-toggle${on ? ' is-on' : ''}${menuLabel ? ' has-menu' : ''}`} ref={ref} data-testid={`${testId}-group`}>
      <button
        type="button"
        className="tl-toggle__btn"
        title={title}
        aria-label={label}
        aria-pressed={on}
        onClick={() => onChange(!on)}
        onMouseDown={(e) => e.preventDefault()}
        data-testid={testId}
      >
        <Icon name={icon} size={20} />
      </button>
      {menuLabel && (
        <button
          type="button"
          className="tl-toggle__more"
          title={`${menuLabel} options`}
          aria-label={`${menuLabel} options`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          onMouseDown={(e) => e.preventDefault()}
          data-testid={`${testId}-menu`}
        >
          <Icon name="chevron-down" size={12} weight={2} />
        </button>
      )}
      {open && menuLabel && (
        <div className="menu tl-toggle__menu" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            className="menu__item tl-toggle__item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange(!on);
              setOpen(false);
            }}
          >
            <span className="tl-toggle__check">{on ? <Icon name="check" size={14} /> : null}</span>
            <span>{menuLabel}</span>
            {key && <kbd>{key}</kbd>}
          </button>
        </div>
      )}
    </div>
  );
}

const Divider = () => <span className="tl-toolbar__divider" aria-hidden />;

/** ↔ / ↕: whether the zoom slider and − + drive the timeline zoom or the track height. */
function ZoomModeToggle({ mode, onChange }: { mode: 'time' | 'height'; onChange: (m: 'time' | 'height') => void }) {
  const height = mode === 'height';
  return (
    <button
      type="button"
      className={`tl-zoom-mode${height ? ' is-height' : ''}`}
      onClick={() => onChange(height ? 'time' : 'height')}
      onMouseDown={(e) => e.preventDefault()}
      title={height ? 'Slider: track height — click for timeline zoom' : 'Slider: timeline zoom — click for track height'}
      aria-label={height ? 'Slider controls track height' : 'Slider controls timeline zoom'}
      aria-pressed={height}
      data-testid="zoom-mode"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {height ? <path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3" /> : <path d="M2 8h12M5 5L2 8l3 3M11 5l3 3-3 3" />}
      </svg>
    </button>
  );
}

export function Toolbar() {
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const { zoom, magnet, snapping } = useEditor(useShallow((s) => ({ zoom: s.zoom, magnet: s.magnet, snapping: s.snapping })));
  const { zoomMode, trackScale, setZoomMode, setTrackScale } = useTimelineUi(
    useShallow((s) => ({ zoomMode: s.zoomMode, trackScale: s.trackScale, setZoomMode: s.setZoomMode, setTrackScale: s.setTrackScale })),
  );
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
  const active = toolDef(tool);

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
            title={ws(active.label, active.command)}
            aria-label={`Tool: ${active.label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenuOpen((o) => !o)}
            data-testid="timeline-tool-menu"
            data-tool={tool}
          >
            <Icon name={active.icon} />
            <Icon name="chevron-down" size={12} />
          </button>
          {menuOpen && (
            <div className="menu tl-select__menu" role="menu" data-testid="timeline-tool-list">
              {TOOLS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={tool === d.id}
                  className={`menu__item${tool === d.id ? ' is-active' : ''}`}
                  data-tool={d.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setTool(d.id);
                    setMenuOpen(false);
                  }}
                >
                  <Icon name={d.icon} size={14} /> <span className="tl-select__label">{d.label}</span> <kbd>{shortcutLabel(d.command)}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
        <Divider />
        <Tool icon="undo" title={ws('Undo', 'undo')} onClick={() => a().undo()} disabled={!canUndo} testId="timeline-undo" />
        <Tool icon="redo" title={ws('Redo', 'redo')} onClick={() => a().redo()} disabled={!canRedo} testId="timeline-redo" />
        <Tool icon="split" title={ws('Split', 'split')} onClick={() => void a().splitAtPlayhead()} disabled={!somethingUnderPlayhead} testId="timeline-split" />
        <Tool icon="delete-left" title={ws('Delete left', 'deleteLeft')} onClick={() => a().deleteLeft()} disabled={!somethingUnderPlayhead} />
        <Tool icon="delete-right" title={ws('Delete right', 'deleteRight')} onClick={() => a().deleteRight()} disabled={!somethingUnderPlayhead} />
        <Tool icon="trash" title={ws('Delete', 'delete')} onClick={() => a().deleteSelected()} disabled={!hasSelection} testId="timeline-delete" />
        <Tool icon="marker" title={ws('Add marker', 'marker')} onClick={() => void a().addMarker()} />
        <Tool icon="mirror" title="Mirror" onClick={() => a().mirrorSelected()} disabled={!hasVisualSelection} />
        <Tool icon="rotate" title="Rotate 90°" onClick={() => a().rotateSelected(90)} disabled={!hasVisualSelection} />
      </div>

      <div className="tl-toolbar__group">
        <Toggle
          icon="magnet"
          name="main track magnet"
          command="toggleMagnet"
          on={magnet}
          onChange={(v) => a().setMagnet(v)}
          testId="timeline-magnet"
        />
        <Toggle icon="snap" name="auto snapping" command="toggleSnapping" on={snapping} onChange={(v) => a().setSnapping(v)} testId="timeline-snapping" />
        <Toggle
          icon="link"
          name="linkage"
          command="toggleLinkage"
          on={linkage}
          onChange={setLinkage}
          testId="timeline-linkage"
          menuLabel="Linkage"
          hint="clips on other tracks (audio, text, overlays) move with the main / overlay clip under their start"
        />
        <Toggle
          icon="preview-axis"
          name="preview axis"
          command="togglePreviewAxis"
          on={previewAxis}
          onChange={setPreviewAxis}
          testId="timeline-preview-axis"
          menuLabel="Preview axis"
        />
        <Divider />
        <ZoomModeToggle mode={zoomMode} onChange={setZoomMode} />
        {zoomMode === 'height' ? (
          <>
            <Tool icon="zoom-out" title="Lower tracks" onClick={() => setTrackScale(trackScale / 1.2)} testId="track-height-down" />
            <input
              type="range"
              className="tl-zoom"
              min={TRACK_SCALE_MIN * 100}
              max={TRACK_SCALE_MAX * 100}
              step={5}
              value={Math.round(trackScale * 100)}
              aria-label="Track height"
              title={`Track height ${Math.round(trackScale * 100)}% (double-click: 100%)`}
              onChange={(e) => setTrackScale(Number(e.target.value) / 100)}
              onDoubleClick={() => setTrackScale(1)}
              onKeyDown={(e) => {
                if (/^(Arrow|Page|Home|End)/.test(e.key)) e.stopPropagation();
              }}
              data-testid="track-height"
            />
            <Tool icon="zoom-in" title="Taller tracks" onClick={() => setTrackScale(trackScale * 1.2)} testId="track-height-up" />
          </>
        ) : (
          <>
            <Tool icon="zoom-out" title={ws('Zoom out', 'zoomOut')} onClick={() => view?.zoomBy(1 / 1.25)} />
            <input
              type="range"
              className="tl-zoom"
              min={0}
              max={SLIDER_MAX}
              value={zoomToSlider(zoom)}
              aria-label="Timeline zoom"
              onChange={(e) => view?.zoomTo(sliderToZoom(Number(e.target.value)))}
              // the slider keeps its own arrow / page / home / end keys; tool letters still reach the editor
              onKeyDown={(e) => {
                if (/^(Arrow|Page|Home|End)/.test(e.key)) e.stopPropagation();
              }}
              data-testid="timeline-zoom"
            />
            <Tool icon="zoom-in" title={ws('Zoom in', 'zoomIn')} onClick={() => view?.zoomBy(1.25)} />
          </>
        )}
        <Tool
          icon="zoom-fit"
          title={zoomMode === 'height' ? 'Default track height' : ws('Zoom to fit', 'fit')}
          onClick={() => (zoomMode === 'height' ? setTrackScale(1) : view?.fit())}
          testId="timeline-fit"
        />
      </div>
    </div>
  );
}
