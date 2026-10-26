/**
 * Adjust › Color › Log wheels (DaVinci Resolve): Shadow / Midtone / Highlight offsets limited to a
 * tonal range — Shadow below Low range, Highlight above High range, Midtone in between, with soft
 * overlaps (engine/color/colorStage.ts step 5).
 */
import { defaultLogWheels, type LogWheelsSettings } from '../../../model/colorPage';
import type { VisualClip, WheelValue } from '../../../model/types';
import { Section, SliderRow } from '../../controls';
import { WheelControl } from '../adjust/WheelsPanel';
import { round, useSetColorPage } from './common';

const LOG: { id: 'shadow' | 'midtone' | 'highlight'; label: string; hint: string }[] = [
  { id: 'shadow', label: 'Shadow', hint: 'Below low range' },
  { id: 'midtone', label: 'Midtone', hint: 'Between' },
  { id: 'highlight', label: 'Highlight', hint: 'Above high range' },
];

const neutral = (w: WheelValue) => Math.hypot(w.x, w.y) < 1e-4 && !w.luma;

export function LogWheelsSection({ clip }: { clip: VisualClip }) {
  const set = useSetColorPage(clip);
  const lw = clip.grade.color.logWheels;
  const setL = (patch: Partial<LogWheelsSettings>) => set({ logWheels: { ...lw, ...patch } });
  const d = defaultLogWheels();
  const allNeutral = LOG.every((w) => neutral(lw[w.id])) && lw.low === d.low && lw.high === d.high;
  return (
    <Section
      id="color-log"
      title="Log wheels"
      checked={lw.enabled}
      onCheck={(on) => setL({ enabled: on })}
      resetDisabled={allNeutral}
      onReset={() => setL({ ...defaultLogWheels(), enabled: lw.enabled })}
    >
      <div className="iwheels icolor-log">
        {LOG.map((w) => (
          <WheelControl key={w.id} id={`log-${w.id}`} label={w.label} hint={w.hint} value={lw[w.id]} lumaLabel="Master" onChange={(v) => setL({ [w.id]: v })} />
        ))}
      </div>
      <SliderRow label="Low range" value={lw.low} min={0} max={1} step={0.001} sliderStep={0.005} digits={3} keyframe={false} onChange={(v) => setL({ low: round(Math.min(v, lw.high), 3) })} testId="log-low" />
      <SliderRow label="High range" value={lw.high} min={0} max={1} step={0.001} sliderStep={0.005} digits={3} keyframe={false} onChange={(v) => setL({ high: round(Math.max(v, lw.low), 3) })} testId="log-high" />
    </Section>
  );
}
