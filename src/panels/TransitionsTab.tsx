/**
 * Transitions tab: the built-in transitions with animated CSS previews (play on hover).
 * Click / "+" → applies to the selected cut (see resolveTransitionTarget); drag onto a cut
 * on the timeline ({kind:'transition', type}).
 */
import { TRANSITIONS } from '../model/catalog';
import type { TransitionType } from '../model/types';
import { selectSelectedTransition, useEditor } from '../store';
import { GridLabel, LibraryBody, PresetTile, useFlash, type SidebarItem } from './LibraryLayout';
import { resolveTransitionTarget, setDragPayload } from './libraryLogic';
import { TRANSITION_GROUPS } from './presets';
import { usePref } from './prefs';

const SIDEBAR: SidebarItem[] = [{ id: 'all', label: 'All' }, ...TRANSITION_GROUPS.map((g) => ({ id: g.id, label: g.label }))];

export function TransitionPreview({ type }: { type: TransitionType }) {
  return (
    <div className={`tprev tprev--${type}`} aria-hidden>
      <div className="tprev__a">A</div>
      <div className="tprev__b">B</div>
      {(type === 'fade-black' || type === 'fade-white') && <div className="tprev__flash" />}
    </div>
  );
}

export function applyTransition(type: TransitionType): string | null {
  const s = useEditor.getState();
  const target = resolveTransitionTarget(s.project, s.selection, s.playhead);
  if (!target) return null;
  if (target.mode === 'update') {
    s.updateTransition(target.transitionId, { type });
    return target.transitionId;
  }
  return s.addTransition(target.fromClipId, type);
}

export function TransitionsTab() {
  const [cat, setCat] = usePref('lib.transitions.cat', 'all');
  const current = useEditor(selectSelectedTransition);
  const [flash, showFlash] = useFlash();
  const groups = cat === 'all' ? TRANSITION_GROUPS : TRANSITION_GROUPS.filter((g) => g.id === cat);

  return (
    <LibraryBody sidebar={SIDEBAR} value={cat} onChange={setCat}>
      <div className="lib__scroll">
        {groups.map((g) => (
          <div key={g.id}>
            <GridLabel>{g.label}</GridLabel>
            <div className="lib-grid">
              {g.types.map((type) => {
                const label = TRANSITIONS.find((t) => t.id === type)?.label ?? type;
                return (
                  <PresetTile
                    key={type}
                    label={label}
                    active={current?.type === type}
                    title={`${label} — select a clip (or a cut) and click, or drag onto a cut`}
                    testId="transition-preset"
                    preview={<TransitionPreview type={type} />}
                    onApply={() => {
                      if (!applyTransition(type)) showFlash('Select a clip that touches another clip on the same track');
                    }}
                    onDragStart={(e) => setDragPayload(e.dataTransfer, { kind: 'transition', type })}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {flash}
    </LibraryBody>
  );
}
