/**
 * Nested editing bar (compound clips, ⌥G): shown while a compound clip is open in the timeline.
 * "Main › Compound 1": click a crumb to go back to that level; "Back" closes one level.
 */
import { useShallow } from 'zustand/react/shallow';
import { closeCompoundTo } from '../actions/compound';
import { breadcrumb } from '../model/compound';
import { useEditor } from '../store';

export function CompoundBreadcrumb() {
  const flat = useEditor(useShallow((s) => (s.project.focus?.length ? breadcrumb(s.project).flatMap((c) => [c.sequenceId ?? '', c.name]) : [])));
  if (!flat.length) return null;
  const crumbs = Array.from({ length: flat.length / 2 }, (_, i) => ({ sequenceId: flat[i * 2] || null, name: flat[i * 2 + 1]! }));
  return (
    <div className="tl-crumbs" data-testid="compound-breadcrumb" role="navigation" aria-label="Compound clip">
      <button type="button" className="tl-crumbs__back" data-testid="compound-back" onClick={() => closeCompoundTo(crumbs.length - 2)} title="Back">
        ‹ Back
      </button>
      {crumbs.map((c, i) => (
        <span key={c.sequenceId ?? 'main'} className="tl-crumbs__item">
          {i > 0 && <span className="tl-crumbs__sep">›</span>}
          {i < crumbs.length - 1 ? (
            <button type="button" className="tl-crumbs__link" data-testid={`compound-crumb-${i}`} onClick={() => closeCompoundTo(i)}>
              {c.name}
            </button>
          ) : (
            <span className="tl-crumbs__current" data-testid={`compound-crumb-${i}`}>
              {c.name}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
