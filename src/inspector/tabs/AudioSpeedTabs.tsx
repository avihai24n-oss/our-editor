/**
 * Audio › Basic (volume dB, fade in/out, mute). The Speed tab is in ./SpeedTab.tsx.
 */
import { LIMITS } from '../../model/catalog';
import { secToUs, usToSec } from '../../model/time';
import type { AudioClip, Clip, TimedClip, VideoClip } from '../../model/types';
import { useEditor } from '../../store';
import { SegmentedTabs, Section, SliderRow } from '../controls';
import { fadeMax, formatDb } from '../inspectorLogic';

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

/** Speed › Standard | Curve | Velocity effects lives in ./SpeedTab.tsx. */
export { SpeedTab } from './SpeedTab';

export const isTimed = (c: Clip): c is TimedClip => c.type === 'video' || c.type === 'audio';
