/** CapCut's ‹ ◇ › keyframe cluster — shown disabled in v1 (keyframes are a v2 feature). */
import { Icon } from '../../ui/Icon';

export function KeyframeButton() {
  return (
    <span className="kf" title="Keyframes — coming soon" aria-label="Keyframes — coming soon" role="img">
      <Icon name="keyframe" size={14} />
    </span>
  );
}
