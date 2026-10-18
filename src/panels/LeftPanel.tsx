/**
 * Left panel — the Library. PLACEHOLDER from the skeleton; Builder A replaces the internals.
 * Final interface: no props, reads/writes the store.
 */
import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { formatShort } from '../model/time';
import { useEditor } from '../store';
import { Icon, type IconName } from '../ui/Icon';

export type LibraryTab =
  | 'media'
  | 'audio'
  | 'text'
  | 'stickers'
  | 'effects'
  | 'transitions'
  | 'captions'
  | 'filters'
  | 'adjustment'
  | 'templates';

export const LIBRARY_TABS: { id: LibraryTab; label: string; icon: IconName; v1: boolean }[] = [
  { id: 'media', label: 'Media', icon: 'media', v1: true },
  { id: 'audio', label: 'Audio', icon: 'audio', v1: true },
  { id: 'text', label: 'Text', icon: 'text', v1: true },
  { id: 'stickers', label: 'Stickers', icon: 'stickers', v1: false },
  { id: 'effects', label: 'Effects', icon: 'effects', v1: false },
  { id: 'transitions', label: 'Transitions', icon: 'transitions', v1: true },
  { id: 'captions', label: 'Captions', icon: 'captions', v1: false },
  { id: 'filters', label: 'Filters', icon: 'filters', v1: true },
  { id: 'adjustment', label: 'Adjustment', icon: 'adjustment', v1: false },
  { id: 'templates', label: 'Templates', icon: 'templates', v1: false },
];

export function LeftPanel() {
  const [tab, setTab] = useState<LibraryTab>('media');
  const assets = useEditor(useShallow((s) => Object.values(s.project.assets)));
  const importFiles = useEditor((s) => s.importFiles);
  const addClip = useEditor((s) => s.addClip);
  const addTextClip = useEditor((s) => s.addTextClip);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = LIBRARY_TABS.find((t) => t.id === tab)!;

  return (
    <>
      <div style={{ display: 'flex', height: 'var(--tabbar-h)', borderBottom: '1px solid var(--border)', overflowX: 'auto', flex: 'none' }}>
        {LIBRARY_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              minWidth: 56,
              padding: '0 6px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              fontSize: 'var(--fs-xs)',
              color: tab === t.id ? 'var(--accent)' : t.v1 ? 'var(--text)' : 'var(--text-faint)',
            }}
          >
            <Icon name={t.icon} size={18} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel__body" style={{ padding: 12 }}>
        {!current.v1 && <div className="empty">{current.label} — coming soon</div>}
        {tab === 'media' && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="video/*,audio/*,image/*"
              hidden
              onChange={(e) => {
                if (e.target.files) void importFiles([...e.target.files]);
                e.target.value = '';
              }}
            />
            <button className="btn" onClick={() => fileRef.current?.click()}>
              <Icon name="import" size={14} /> Import
            </button>
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
              {assets.map((a) => (
                <li key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                  <button className="icon-btn" title="Add to timeline" onClick={() => addClip(a.id)}>
                    <Icon name="plus" />
                  </button>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{a.kind === 'image' ? 'IMG' : formatShort(a.duration)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === 'text' && (
          <button className="btn" onClick={() => addTextClip()}>
            <Icon name="plus" size={14} /> Default text
          </button>
        )}
        {(tab === 'audio' || tab === 'transitions' || tab === 'filters') && <div className="empty">{current.label} — builder A</div>}
      </div>
    </>
  );
}
