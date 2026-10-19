/**
 * Speed › Standard (log speed slider,
 * duration, change audio pitch, reset). Curve is shown disabled (v2).
 */
import { useState } from 'react';
import { LIMITS } from '../../model/catalog';
import { formatSeconds, secToUs, sourceSpan, usToSec } from '../../model/time';
import type { Clip, TimedClip } from '../../model/types';
import { useEditor } from '../../store';
import { NumberBox, SegmentedTabs, SliderRow, ToggleRow } from '../controls';
import { SPEED_SLIDER_MAX, SPEED_TICKS, sliderToSpeed, speedTickPos, speedToSlider } from '../inspectorLogic';

/** Audio tab: see ./AudioTab.tsx (Basic | Voice changer). */
export { AudioTab } from './AudioTab';

export function SpeedTab(props: { clip: TimedClip; sub?: 'standard' | 'curve'; onSubChange?: (s: 'standard' | 'curve') => void }) {
  const { clip } = props;
  const setSpeed = useEditor((s) => s.setSpeed);
  const setDuration = useEditor((s) => s.setDuration);
  const updateClip = useEditor((s) => s.updateClip);
  const [ownSub, setOwnSub] = useState<'standard' | 'curve'>('standard');
  const sub = props.sub ?? ownSub;
  const setSub = props.onSubChange ?? setOwnSub;
  const original = sourceSpan(clip);
  const ticks = SPEED_TICKS.map(speedTickPos);
  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'standard', label: 'Standard' },
          { id: 'curve', label: 'Curve', disabled: true, title: 'Speed curves — coming in v2' },
        ]}
        value={sub}
        onChange={setSub}
      />
      {sub === 'curve' && (
        <div className="ipad" data-testid="speed-curve-soon">
          <div className="inotice">Speed curves (Montage, Hero, Bullet, Custom…) are coming in v2. Use Standard for now.</div>
          <button className="btn" onClick={() => setSub('standard')}>
            Back to Standard
          </button>
        </div>
      )}
      {sub === 'standard' && (
      <>
      <div className="ipad">
        <SliderRow
          label="Speed"
          value={clip.speed}
          min={LIMITS.speedMin}
          max={LIMITS.speedMax}
          step={0.1}
          digits={2}
          unit="x"
          toSlider={speedToSlider}
          fromSlider={sliderToSpeed}
          sliderMin={0}
          sliderMax={SPEED_SLIDER_MAX}
          sliderStep={1}
          ticks={ticks}
          keyframe={false}
          onChange={(v) => setSpeed(clip.id, v)}
          testId="speed-row"
        />
        <div className="ispeed-ticks" aria-hidden>
          {SPEED_TICKS.map((t, i) => (
            <span key={t} style={{ left: `${ticks[i]! * 100}%` }}>
              {t}x
            </span>
          ))}
        </div>
        <div className="irow irow--stack">
          <span className="irow__label">Duration</span>
          <div className="iduration">
            <span className="iduration__from">{formatSeconds(original)}</span>
            <span className="iduration__arrow" aria-hidden />
            <NumberBox
              value={Math.round(usToSec(clip.duration) * 10) / 10}
              min={0.1}
              max={Math.max(0.1, (usToSec(original) / LIMITS.speedMin))}
              step={0.1}
              digits={1}
              unit="s"
              label="Duration"
              testId="duration-input"
              onCommit={(v) => setDuration(clip.id, secToUs(v))}
            />
          </div>
        </div>
        <ToggleRow
          label="Change audio pitch"
          hint="Off keeps the original pitch when the speed changes."
          on={!clip.preservePitch}
          onChange={(on) => updateClip(clip.id, { preservePitch: !on })}
        />
      </div>
      <div className="ifoot">
        <span className="ifoot__spacer" />
        <button className="btn" disabled={clip.speed === 1} onClick={() => setSpeed(clip.id, 1)}>
          Reset
        </button>
      </div>
      </>
      )}
    </>
  );
}

export const isTimed = (c: Clip): c is TimedClip => c.type === 'video' || c.type === 'audio';
