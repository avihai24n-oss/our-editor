/**
 * Bottom timeline. PLACEHOLDER from the skeleton; Builder B replaces the internals
 * (toolbar, ruler, track headers, clips, drag/trim/snap, playhead, zoom, shortcuts).
 * Final interface: no props, reads/writes the store.
 */
import { useShallow } from 'zustand/react/shallow';
import { timelineRows } from '../model/project';
import { usToPx } from '../model/time';
import { useEditor, selectCanRedo, selectCanUndo } from '../store';
import { Icon, type IconName } from '../ui/Icon';

export function Timeline() {
  const rows = useEditor(useShallow((s) => timelineRows(s.project)));
  const zoom = useEditor((s) => s.zoom);
  const playhead = useEditor((s) => s.playhead);
  const selected = useEditor((s) => s.selection.clipIds);
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const a = useEditor.getState();

  const tools: { icon: IconName; title: string; run: () => void; disabled?: boolean }[] = [
    { icon: 'undo', title: 'Undo (⌘Z)', run: a.undo, disabled: !canUndo },
    { icon: 'redo', title: 'Redo (⇧⌘Z)', run: a.redo, disabled: !canRedo },
    { icon: 'split', title: 'Split (⌘B)', run: () => void a.splitAtPlayhead() },
    { icon: 'delete-left', title: 'Delete left (Q)', run: a.deleteLeft },
    { icon: 'delete-right', title: 'Delete right (W)', run: a.deleteRight },
    { icon: 'trash', title: 'Delete (⌫)', run: a.deleteSelected, disabled: selected.length === 0 },
    { icon: 'marker', title: 'Add marker (M)', run: () => void a.addMarker() },
  ];

  return (
    <>
      <div style={{ height: 'var(--tl-toolbar-h)', display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        {tools.map((t) => (
          <button key={t.icon} className="icon-btn" title={t.title} disabled={t.disabled} onClick={t.run}>
            <Icon name={t.icon} />
          </button>
        ))}
      </div>
      <div className="panel__body" style={{ position: 'relative' }}>
        {rows.map((track) => (
          <div key={track.id} style={{ display: 'flex', height: track.kind === 'main' ? 'var(--tl-main-track-h)' : 'var(--tl-track-h)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: 'var(--tl-header-w)', flex: 'none', padding: '0 8px', display: 'flex', alignItems: 'center', color: 'var(--text-dim)' }}>{track.name}</div>
            <div style={{ position: 'relative', flex: 1 }}>
              {track.clips.map((c) => (
                <div
                  key={c.id}
                  onPointerDown={(e) => a.select([c.id], e.shiftKey ? 'toggle' : 'replace')}
                  style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: usToPx(c.start, zoom),
                    width: usToPx(c.duration, zoom),
                    background: c.type === 'audio' ? 'var(--clip-audio)' : c.type === 'text' ? 'var(--clip-text)' : 'var(--clip-video)',
                    border: `2px solid ${selected.includes(c.id) ? 'var(--clip-selected)' : 'transparent'}`,
                    borderRadius: 4,
                    padding: '2px 6px',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    fontSize: 'var(--fs-xs)',
                  }}
                >
                  {c.name}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `calc(var(--tl-header-w) + ${usToPx(playhead, zoom)}px)`,
            width: 1,
            background: 'var(--playhead)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </>
  );
}
