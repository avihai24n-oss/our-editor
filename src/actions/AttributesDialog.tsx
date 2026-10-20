/**
 * Paste attributes dialog (CapCut: right-click › Copy/paste attributes › Paste attributes, ⌥⌘V).
 * One checkbox per attribute group that the copied clip has and the targets support; all ticked
 * by default. Paste applies the ticked groups to every target as one undo step.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { useTimelineUi } from '../timeline/uiStore';
import { showToast } from '../ui/appEvents';
import { applicableGroups, ATTR_GROUPS, pasteAttributes, usePasteAttributesDialog, type AttrGroup } from './attributes';
import './attributes.css';

export function AttributesDialog() {
  const { open, targets, close } = usePasteAttributesDialog();
  if (!open) return null;
  return <DialogBody targets={targets} close={close} />;
}

function DialogBody({ targets, close }: { targets: string[]; close: () => void }) {
  const snap = useTimelineUi((s) => s.attributeClipboard);
  const project = useEditor((s) => s.project);
  const groups = useMemo(() => applicableGroups(snap, project, targets), [snap, project, targets]);
  const [checked, setChecked] = useState<Set<AttrGroup>>(() => new Set(groups));
  const okRef = useRef<HTMLButtonElement>(null);
  const picked = groups.filter((g) => checked.has(g));
  const all = picked.length === groups.length;

  const apply = () => {
    if (!picked.length) return;
    const changed = pasteAttributes(targets, picked, snap);
    close();
    showToast(changed.length ? `Attributes pasted to ${changed.length} clip${changed.length > 1 ? 's' : ''}` : 'Nothing changed');
  };

  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        apply();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggle = (g: AttrGroup, on: boolean) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (on) n.add(g);
      else n.delete(g);
      return n;
    });

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal attrs" role="dialog" aria-modal="true" aria-label="Paste attributes" data-testid="paste-attributes-dialog">
        <div className="modal__head">Paste attributes</div>
        <div className="modal__body attrs__body">
          <label className="attrs__row attrs__all">
            <input type="checkbox" className="checkbox" checked={all} onChange={(e) => setChecked(new Set(e.target.checked ? groups : []))} data-testid="attr-all" />
            <span>Select all</span>
          </label>
          {ATTR_GROUPS.filter((g) => groups.includes(g.id)).map((g) => (
            <label key={g.id} className="attrs__row">
              <input
                type="checkbox"
                className="checkbox"
                checked={checked.has(g.id)}
                onChange={(e) => toggle(g.id, e.target.checked)}
                data-testid={`attr-${g.id}`}
              />
              <span>{g.label}</span>
            </label>
          ))}
        </div>
        <div className="modal__foot">
          <button className="btn" onClick={close} data-testid="attr-cancel">
            Cancel
          </button>
          <button ref={okRef} className="btn btn--primary" disabled={!picked.length} onClick={apply} data-testid="attr-paste">
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
