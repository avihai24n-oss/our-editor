/**
 * Media › Subprojects: every compound clip's sequence (CapCut lists compound clips here). A tile
 * can be dragged to the timeline, or "+" adds it at the playhead, to make another instance: all
 * instances show the same sequence, so an edit inside one shows in every one.
 */
import { useShallow } from 'zustand/react/shallow';
import { addSubproject } from '../actions/compound';
import { canPlaceSequence, instancesOf, sequencesOf } from '../model/compound';
import { formatShort } from '../model/time';
import { useEditor } from '../store';
import { CompoundGlyph } from '../timeline/ClipView';
import { DND_MIME } from '../timeline/dnd';
import { Icon } from '../ui/Icon';
import { GridLabel } from './LibraryLayout';

export function SubprojectsList() {
  const items = useEditor(
    useShallow((s) =>
      Object.values(sequencesOf(s.project))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((q) => `${q.id}\u0000${q.name}\u0000${q.duration}\u0000${instancesOf(s.project, q.id).length}\u0000${canPlaceSequence(s.project, q.id) ? 1 : 0}`),
    ),
  );
  const list = items.map((x) => {
    const [id, name, duration, uses, ok] = x.split('\u0000');
    return { id: id!, name: name!, duration: Number(duration), uses: Number(uses), placeable: ok === '1' };
  });
  return (
    <div className="lib__scroll" data-testid="subprojects-panel">
      <GridLabel>Subprojects</GridLabel>
      {list.length === 0 ? (
        <div className="lib-empty">
          <CompoundGlyph size={24} />
          <div>Select clips on the timeline and press ⌥G (Create compound clip) to make a subproject.</div>
        </div>
      ) : (
        <div className="lib-list">
          {list.map((q) => (
            <div
              key={q.id}
              className="lib-subproject"
              data-testid="subproject-tile"
              data-sequence-id={q.id}
              draggable={q.placeable}
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_MIME, JSON.stringify({ kind: 'sequence', sequenceId: q.id }));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={q.placeable ? 'Drag to the timeline to add another instance' : 'Open here: a compound clip cannot contain itself'}
            >
              <span className="lib-subproject__icon">
                <CompoundGlyph size={18} />
              </span>
              <span className="lib-subproject__name">{q.name}</span>
              <span className="lib-subproject__meta">
                {formatShort(q.duration)} · {q.uses} {q.uses === 1 ? 'use' : 'uses'}
              </span>
              <button
                className="icon-btn"
                title="Add at the playhead"
                aria-label={`Add ${q.name} at the playhead`}
                disabled={!q.placeable}
                data-testid="subproject-add"
                onClick={() => addSubproject(q.id)}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
