/**
 * Right inspector. PLACEHOLDER from the skeleton; Builder A replaces the internals.
 * Final interface: no props. Selection drives it:
 *   nothing → Project; video → Video/Audio/Speed/Animation/Adjust; image → Video/Animation/Adjust;
 *   audio → Audio/Speed; text → Text/Animation; transition → Transition.
 */
import { useEditor, selectSelectedClip, selectSelectedTransition } from '../store';
import { formatSeconds } from '../model/time';

export function Inspector() {
  const clip = useEditor(selectSelectedClip);
  const transition = useEditor(selectSelectedTransition);
  const project = useEditor((s) => s.project);
  const count = useEditor((s) => s.selection.clipIds.length);

  if (transition) {
    return (
      <>
        <div className="panel__header">Transition</div>
        <div className="panel__body" style={{ padding: 12 }}>
          {transition.type} · {formatSeconds(transition.duration)}
        </div>
      </>
    );
  }
  if (clip) {
    return (
      <>
        <div className="panel__header">{clip.type === 'text' ? 'Text' : clip.type === 'audio' ? 'Audio' : 'Video'}</div>
        <div className="panel__body" style={{ padding: 12 }}>
          {clip.name} · {formatSeconds(clip.duration)}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="panel__header">{count > 1 ? `${count} clips selected` : 'Project'}</div>
      <div className="panel__body" style={{ padding: 12, display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 6 }}>
        <span style={{ color: 'var(--text-dim)' }}>Name</span>
        <span>{project.name}</span>
        <span style={{ color: 'var(--text-dim)' }}>Ratio</span>
        <span>{project.settings.aspect}</span>
        <span style={{ color: 'var(--text-dim)' }}>Resolution</span>
        <span>
          {project.settings.width}×{project.settings.height}
        </span>
        <span style={{ color: 'var(--text-dim)' }}>Frame rate</span>
        <span>{project.settings.fps} fps</span>
        <span style={{ color: 'var(--text-dim)' }}>Media</span>
        <span>{Object.keys(project.assets).length}</span>
      </div>
    </>
  );
}
