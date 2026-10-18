/**
 * Audio › Basic (volume dB, fade in/out, mute) and Speed › Standard (log speed slider,
 * duration, change audio pitch, reset). Curve is shown disabled (v2).
 */
import { useState } from 'react';
import { LIMITS } from '../../model/catalog';
import { formatSeconds, secToUs, sourceSpan, usToSec } from '../../model/time';
import type { AudioClip, Clip, TimedClip, VideoClip } from '../../model/types';
import { useEditor } from '../../store';
import { NumberBox, SegmentedTabs, Section, SliderRow, ToggleRow } from '../controls';
import { fadeMax, formatDb, SPEED_SLIDER_MAX, SPEED_TICKS, sliderToSpeed, speedTickPos, speedToSlider } from '../inspectorLogic';

export function AudioTab({ clip }: { clip: VideoClip | AudioClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const a = clip.audio;
  const set = (patch: Partial<typeof a>) => updateClip(clip.id, { audio: patch });
  const sec = (us: number) => Math.round(usToSec(us) * 10) / 10;
  const maxIn = usToSec(fadeMax(clip.duration, a.fadeOut));
  const maxOut = usToSec(fadeMax(clip.duration, a.fadeIn));
  const isDefault = a.volumeDb === 0 && a.fadeIn === 0 && a.fadeOut === 0;
  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'basic', label: 'Basic' },
          { id: 'voice', label: 'Voice changer', disabled: true },
        ]}
        value="basic"
        onChange={() => undefined}
      />
      <Section
        id="audio-basic"
        title="Basic"
        keyframe
        checked={!a.muted}
        onCheck={(on) => set({ muted: !on })}
        resetDisabled={isDefault}
        onReset={() => set({ volumeDb: 0, fadeIn: 0, fadeOut: 0 })}
      >
        <SliderRow
          label="Volume"
          value={a.volumeDb}
          min={LIMITS.volumeDbMin}
          max={LIMITS.volumeDbMax}
          step={0.1}
          digits={1}
          unit="dB"
          format={formatDb}
          disabled={a.muted}
          onChange={(v) => set({ volumeDb: Math.round(v * 10) / 10 })}
          testId="volume-row"
        />
        <SliderRow
          label="Fade in"
          value={sec(a.fadeIn)}
          min={0}
          max={Math.max(0, Math.floor(maxIn * 10) / 10)}
          step={0.1}
          digits={1}
          unit="s"
          keyframe={false}
          disabled={a.muted}
          onChange={(v) => set({ fadeIn: secToUs(v) })}
        />
        <SliderRow
          label="Fade out"
          value={sec(a.fadeOut)}
          min={0}
          max={Math.max(0, Math.floor(maxOut * 10) / 10)}
          step={0.1}
          digits={1}
          unit="s"
          keyframe={false}
          disabled={a.muted}
          onChange={(v) => set({ fadeOut: secToUs(v) })}
        />
      </Section>
    </>
  );
}

export function SpeedTab({ clip }: { clip: TimedClip }) {
  const setSpeed = useEditor((s) => s.setSpeed);
  const setDuration = useEditor((s) => s.setDuration);
  const updateClip = useEditor((s) => s.updateClip);
  const [sub, setSub] = useState<'standard' | 'curve'>('standard');
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
  );
}

export const isTimed = (c: Clip): c is TimedClip => c.type === 'video' || c.type === 'audio';
