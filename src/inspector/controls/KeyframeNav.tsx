/**
 * A working CapCut ‹ ◇ › keyframe cluster: ◇ adds a keyframe at the playhead (filled = one is
 * there; click removes it), ‹ › jump the playhead to the previous / next keyframe. The arrows only
 * show once the property has keyframes.
 */
import { Icon } from '../../ui/Icon';

export interface KeyframeNavProps {
  /** A keyframe sits at the playhead. */
  on: boolean;
  /** The property has keyframes (shows ‹ ›). */
  any: boolean;
  /** The playhead is outside the clip: ◇ cannot add one. */
  disabled?: boolean;
  onToggle: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  testId?: string;
}

export function KeyframeNav(p: KeyframeNavProps) {
  const title = p.disabled ? 'Move the playhead over the clip to add a keyframe' : p.on ? 'Remove keyframe' : 'Add keyframe';
  return (
    <span className="kfnav" data-testid={p.testId}>
      {p.any && (
        <button className="kfnav__arrow" disabled={!p.onPrev} onClick={() => p.onPrev?.()} title="Previous keyframe" aria-label="Previous keyframe">
          ‹
        </button>
      )}
      <button
        className={`kf kf--live${p.on ? ' is-on' : ''}`}
        disabled={p.disabled}
        onClick={p.onToggle}
        title={title}
        aria-label={title}
        aria-pressed={p.on}
        data-testid={p.testId && `${p.testId}-toggle`}
      >
        <Icon name={p.on ? 'keyframe-filled' : 'keyframe'} size={14} />
      </button>
      {p.any && (
        <button className="kfnav__arrow" disabled={!p.onNext} onClick={() => p.onNext?.()} title="Next keyframe" aria-label="Next keyframe">
          ›
        </button>
      )}
    </span>
  );
}
