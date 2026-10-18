/**
 * Track header (left column): type icon, lock, eye (visual tracks), speaker (tracks that can
 * carry sound), and the Cover tile on the main track.
 */
import { memo } from 'react';
import type { Track } from '../model/types';
import { useEditor } from '../store';
import { Icon, type IconName } from '../ui/Icon';

const TYPE_ICON: Record<Track['kind'], IconName> = {
  main: 'video-track',
  overlay: 'video-track',
  text: 'text-track',
  audio: 'audio-track',
};

const TYPE_LABEL: Record<Track['kind'], string> = {
  main: 'Main track',
  overlay: 'Overlay track',
  text: 'Text track',
  audio: 'Audio track',
};

export const TrackHeader = memo(function TrackHeader({ track }: { track: Track }) {
  const setTrack = useEditor.getState().setTrack;
  const visual = track.kind !== 'audio';
  const sound = track.kind !== 'text';
  return (
    <div className={`tl-header${track.kind === 'main' ? ' tl-header--main' : ''}`} title={TYPE_LABEL[track.kind]}>
      <span className="tl-header__type" aria-label={TYPE_LABEL[track.kind]}>
        <Icon name={TYPE_ICON[track.kind]} size={14} />
      </span>
      <button
        type="button"
        className={`icon-btn tl-header__btn${track.locked ? ' is-on' : ''}`}
        title={track.locked ? 'Unlock track' : 'Lock track'}
        aria-pressed={track.locked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setTrack(track.id, { locked: !track.locked })}
        data-testid="track-lock"
      >
        <Icon name={track.locked ? 'lock' : 'unlock'} size={14} />
      </button>
      {visual ? (
        <button
          type="button"
          className={`icon-btn tl-header__btn${track.hidden ? ' is-on' : ''}`}
          title={track.hidden ? 'Show track' : 'Hide track'}
          aria-pressed={track.hidden}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTrack(track.id, { hidden: !track.hidden })}
          data-testid="track-hide"
        >
          <Icon name={track.hidden ? 'eye-off' : 'eye'} size={14} />
        </button>
      ) : (
        <span className="tl-header__spacer" />
      )}
      {sound ? (
        <button
          type="button"
          className={`icon-btn tl-header__btn${track.muted ? ' is-on' : ''}`}
          title={track.muted ? 'Unmute track' : 'Mute track'}
          aria-pressed={track.muted}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTrack(track.id, { muted: !track.muted })}
          data-testid="track-mute"
        >
          <Icon name={track.muted ? 'volume-mute' : 'volume'} size={14} />
        </button>
      ) : (
        <span className="tl-header__spacer" />
      )}
      {track.kind === 'main' && (
        <button type="button" className="tl-cover" title="Cover (coming soon)" disabled onMouseDown={(e) => e.preventDefault()}>
          <Icon name="image" size={14} />
          <span>Cover</span>
        </button>
      )}
    </div>
  );
});
