/**
 * One clip on a track: coloured body by type, name, speed badge, content (filmstrip / waveform /
 * text label), animation ramps, selection outline with trim handles. Pointer handling is delegated
 * to the Timeline's gesture controller through `onPointerDown`.
 *
 * A video clip that carries sound also gets CapCut's audio lane: its waveform along the bottom of
 * the filmstrip, on a dark band. It is the clip's own sound, so it follows the clip's volume,
 * fades and speed — muting the clip flattens it.
 */
import { memo, type PointerEvent as RPointerEvent } from 'react';
import { usToPx } from '../model/time';
import type { Clip, MediaAsset } from '../model/types';
import { Icon } from '../ui/Icon';
import { openCompound } from '../actions/compound';
import { Filmstrip, ImageStrip, Waveform } from './ClipContent';
import { VolumeLine } from './VolumeLine';

/** Stacked-frames glyph of a compound clip (CapCut draws its compound clips with a stack icon). */
export function CompoundGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg className="tl-clip__compound-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M4.5 3.5V3a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14.5 3v7a1.5 1.5 0 0 1-1.5 1.5h-.5" />
    </svg>
  );
}
import { curveBadge, speedBadge } from './geometry';

export type ClipPart = 'body' | 'left' | 'right';

const DOUBLE_PRESS_MS = 400;
let lastPress: { id: string; at: number } | null = null;
/** True when this press on the clip follows a press on the same clip within the double-click time. */
function isSecondPress(id: string, at: number): boolean {
  const hit = !!lastPress && lastPress.id === id && at - lastPress.at < DOUBLE_PRESS_MS;
  lastPress = hit ? null : { id, at };
  return hit;
}

export interface ClipViewProps {
  clip: Clip;
  asset: MediaAsset | undefined;
  zoom: number;
  height: number;
  selected: boolean;
  /** Select leftward / rightward: a click here would take this clip. */
  toolTarget?: boolean;
  locked: boolean;
  /** The original of a clip being dragged (drawn faded). */
  ghosted?: boolean;
  /** Visible lane window, lane px. */
  viewFrom: number;
  viewTo: number;
  onPointerDown: (e: RPointerEvent, clip: Clip, part: ClipPart) => void;
}

export const ClipView = memo(function ClipView({ clip, asset, zoom, height, selected, toolTarget, locked, ghosted, viewFrom, viewTo, onPointerDown }: ClipViewProps) {
  const left = usToPx(clip.start, zoom);
  const width = Math.max(2, usToPx(clip.duration, zoom));
  const fromPx = viewFrom - left;
  const toPx = viewTo - left;
  const bodyH = height - 8; // 4px vertical inset
  const badge = clip.type === 'video' || clip.type === 'audio' ? (clip.speedCurve ? curveBadge(clip.speedCurve.preset) : speedBadge(clip.speed)) : null;
  const missing = !!asset?.missing;
  const contentH = Math.max(8, bodyH);
  // the lane only appears on a clip tall enough to keep the filmstrip readable above it
  const hasSound = clip.type === 'video' && !!asset && !missing && asset.hasAudio !== false;
  const audioH = hasSound && bodyH >= 26 ? Math.round(Math.min(22, Math.max(10, bodyH * 0.32))) : 0;

  const cls = [
    'tl-clip',
    `tl-clip--${clip.type}`,
    selected && 'is-selected',
    toolTarget && !selected && 'is-tool-target',
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
      onPointerDown={(e) => {
        // compound clip: a second press within the double-click time opens it (the timeline's drag
        // gesture captures the pointer, so the browser's own dblclick never reaches the clip)
        if (clip.type === 'compound' && e.button === 0 && isSecondPress(clip.id, e.timeStamp)) {
          e.preventDefault();
          e.stopPropagation();
          openCompound(clip.id);
          return;
        }
        onPointerDown(e, clip, 'body');
      }}
      title={`${clip.name}${clip.disabled ? ' (disabled)' : ''}${clip.type === 'compound' ? ' — double-click to edit' : ''}`}
    >
      <div className="tl-clip__content">
        {clip.type === 'video' && asset && (
          <Filmstrip clip={clip} asset={asset} width={width} height={contentH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
        )}
        {clip.type === 'video' && asset && audioH > 0 && (
          <div className="tl-clip__audio" style={{ height: audioH }} data-testid="clip-audio-band">
            <Waveform clip={clip} asset={asset} width={width} height={audioH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
          </div>
        )}
        {clip.type === 'image' && asset && <ImageStrip clip={clip} asset={asset} />}
        {clip.type === 'audio' && asset && (
          <Waveform clip={clip} asset={asset} width={width} height={contentH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
        )}
        {clip.type === 'compound' && (
          <div className="tl-clip__compound" data-testid="compound-clip-body">
            <CompoundGlyph />
          </div>
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
          {badge && <span className="tl-clip__badge" data-testid="clip-speed-badge">{badge}</span>}
          {looping && (
            <span className="tl-clip__badge tl-clip__badge--loop" title="Loop animation">
              ∞
            </span>
          )}
          {clip.type !== 'text' && <span className="tl-clip__name">{clip.name}</span>}
        </div>
      )}

      {!locked && !missing && width > 24 && bodyH >= 20 && (clip.type === 'audio' || (clip.type === 'video' && hasSound)) && (
        <VolumeLine clip={clip} width={width} height={bodyH} zoom={zoom} fromPx={fromPx} toPx={toPx} />
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
