/**
 * One clip on a track: coloured body by type, name, speed badge, content (filmstrip / waveform /
 * text label), animation ramps, selection outline with trim handles. Pointer handling is delegated
 * to the Timeline's gesture controller through `onPointerDown`.
 */
import { memo, type PointerEvent as RPointerEvent } from 'react';
import { usToPx } from '../model/time';
import type { Clip, MediaAsset } from '../model/types';
import { Icon } from '../ui/Icon';
import { Filmstrip, ImageStrip, Waveform } from './ClipContent';
import { speedBadge } from './geometry';

export type ClipPart = 'body' | 'left' | 'right';

export interface ClipViewProps {
  clip: Clip;
  asset: MediaAsset | undefined;
  zoom: number;
  height: number;
  selected: boolean;
  locked: boolean;
  /** The original of a clip being dragged (drawn faded). */
  ghosted?: boolean;
  /** Visible lane window, lane px. */
  viewFrom: number;
  viewTo: number;
  onPointerDown: (e: RPointerEvent, clip: Clip, part: ClipPart) => void;
}

export const ClipView = memo(function ClipView({ clip, asset, zoom, height, selected, locked, ghosted, viewFrom, viewTo, onPointerDown }: ClipViewProps) {
  const left = usToPx(clip.start, zoom);
  const width = Math.max(2, usToPx(clip.duration, zoom));
  const fromPx = viewFrom - left;
  const toPx = viewTo - left;
  const bodyH = height - 8; // 4px vertical inset
  const badge = clip.type === 'video' || clip.type === 'audio' ? speedBadge(clip.speed) : null;
  const missing = !!asset?.missing;
  const contentH = Math.max(8, bodyH);

  const cls = [
    'tl-clip',
    `tl-clip--${clip.type}`,
    selected && 'is-selected',
    clip.disabled && 'is-disabled',
    ghosted && 'is-ghosted',
    locked && 'is-locked',
    missing && 'is-missing',
  ]
    .filter(Boolean)
    .join(' ');

  const anim = clip.type !== 'audio' ? clip : null;
  const inW = anim?.animationIn ? Math.min(width, usToPx(anim.animationIn.duration, zoom)) : 0;
  const outW = anim?.animationOut ? Math.min(width, usToPx(anim.animationOut.duration, zoom)) : 0;
  const comboW = anim?.animationCombo ? Math.min(width, usToPx(anim.animationCombo.duration, zoom)) : 0;
  const looping = !!anim?.animationLoop;
  const animSlots = anim ? [anim.animationIn && 'in', anim.animationOut && 'out', anim.animationCombo && 'combo', anim.animationLoop && 'loop'].filter(Boolean) : [];
  const fadeInW = clip.type === 'audio' || clip.type === 'video' ? usToPx(clip.audio.fadeIn, zoom) : 0;
  const fadeOutW = clip.type === 'audio' || clip.type === 'video' ? usToPx(clip.audio.fadeOut, zoom) : 0;

  return (
    <div
      className={cls}
      style={{ left, width, height: bodyH }}
      data-testid="timeline-clip"
      data-clip-id={clip.id}
      data-clip-name={clip.name}
      data-clip-type={clip.type}
      data-selected={selected ? 'true' : 'false'}
      data-animations={animSlots.join(',')}
      onPointerDown={(e) => onPointerDown(e, clip, 'body')}
      title={`${clip.name}${clip.disabled ? ' (disabled)' : ''}`}
    >
      <div className="tl-clip__content">
        {clip.type === 'video' && asset && (
          <Filmstrip clip={clip} asset={asset} width={width} height={contentH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
        )}
        {clip.type === 'image' && asset && <ImageStrip clip={clip} asset={asset} />}
        {clip.type === 'audio' && asset && (
          <Waveform clip={clip} asset={asset} width={width} height={contentH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
        )}
        {clip.type === 'text' && <div className="tl-clip__text">{clip.text.content.replace(/\n/g, ' ') || 'Text'}</div>}
        {missing && <div className="tl-clip__lost">Media lost</div>}
      </div>

      {inW > 0 && <div className="tl-clip__ramp tl-clip__ramp--in" style={{ width: inW }} />}
      {outW > 0 && <div className="tl-clip__ramp tl-clip__ramp--out" style={{ width: outW }} />}
      {comboW > 0 && <div className="tl-clip__ramp tl-clip__ramp--combo" style={{ width: comboW }} />}
      {fadeInW > 0 && clip.type === 'audio' && <div className="tl-clip__fade tl-clip__fade--in" style={{ width: fadeInW }} />}
      {fadeOutW > 0 && clip.type === 'audio' && <div className="tl-clip__fade tl-clip__fade--out" style={{ width: fadeOutW }} />}

      {width > 28 && (
        <div className="tl-clip__label">
          {clip.type === 'video' && clip.audio.muted && <Icon name="volume-mute" size={11} />}
          {badge && <span className="tl-clip__badge">{badge}</span>}
          {looping && (
            <span className="tl-clip__badge tl-clip__badge--loop" title="Loop animation">
              ∞
            </span>
          )}
          {clip.type !== 'text' && <span className="tl-clip__name">{clip.name}</span>}
        </div>
      )}

      {!locked && (
        <>
          <div className="tl-clip__handle tl-clip__handle--left" onPointerDown={(e) => onPointerDown(e, clip, 'left')} />
          <div className="tl-clip__handle tl-clip__handle--right" onPointerDown={(e) => onPointerDown(e, clip, 'right')} />
        </>
      )}
    </div>
  );
});
