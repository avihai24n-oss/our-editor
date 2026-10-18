/**
 * CapCut's "Keyboard shortcuts" panel (keyboard icon next to Export). Generated from the one
 * shortcut table in src/timeline/shortcutDefs.ts, so the panel cannot drift from the handler.
 * Mac shows ⌘⇧⌥ glyphs, Windows shows Ctrl / Shift / Alt.
 */
import { useEffect, useRef } from 'react';
import { detectPlatform, formatDef, SHORTCUT_GROUPS, SHORTCUTS, type Platform, type ShortcutDef } from '../timeline/shortcutDefs';
import { Icon } from './Icon';
import './shortcuts.css';

const TAGS: Partial<Record<ShortcutDef['status'], string>> = {
  soon: 'Coming soon',
  browser: 'Not in a browser',
};

export function ShortcutsPanel({ onClose, platform = detectPlatform() }: { onClose: () => void; platform?: Platform }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal kbd-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="shortcuts-panel">
        <div className="modal__head">
          <span>Keyboard shortcuts</span>
          <span className="kbd-panel__platform">{platform === 'mac' ? 'macOS' : 'Windows'}</span>
          <button ref={closeRef} className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="kbd-panel__body">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g} className="kbd-panel__group" data-testid="shortcuts-group">
              <h3>{g}</h3>
              <ul>
                {SHORTCUTS.filter((d) => d.group === g).map((d) => (
                  <li key={d.label} className={`kbd-panel__row is-${d.status}`} data-testid="shortcuts-row" data-status={d.status} title={d.note}>
                    <span className="kbd-panel__label">
                      {d.label}
                      {TAGS[d.status] && <span className="kbd-panel__tag">{TAGS[d.status]}</span>}
                    </span>
                    <span className="kbd-panel__keys">
                      {formatDef(d, platform)
                        .split(' / ')
                        .map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
