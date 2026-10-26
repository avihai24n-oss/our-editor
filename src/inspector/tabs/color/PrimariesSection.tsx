/**
 * Adjust › Color › Primaries (DaVinci Resolve): the Lift / Gamma / Gain / Offset wheels (the same
 * `grade.wheels` the Color wheel sub-tab edits — one wheel system) with per-channel readouts and
 * a Master (luminance) slider each, then the primaries bar: Contrast + Pivot, Temp / Tint,
 * Saturation, Hue, Lum Mix, Color Boost, Shadows / Highlights, Midtone Detail.
 */
import { WHEELS } from '../../../model/catalog';
import { defaultPrimaries, PIVOT_DEFAULT, type PrimariesSettings } from '../../../model/colorPage';
import { defaultWheels } from '../../../model/defaults';
import type { VisualClip, WheelId, WheelValue } from '../../../model/types';
import { K, wheelChroma } from '../../../engine/color/params';
import { useEditor } from '../../../store';
import { GroupLabel, Section, SliderRow } from '../../controls';
import { WheelControl } from '../adjust/WheelsPanel';
import { round, useSetColorPage } from './common';

const isNeutral = (w: WheelValue) => Math.hypot(w.x, w.y) < 1e-4 && !w.luma;

const KS: Record<WheelId, [number, number]> = {
  lift: [K.WHEEL_LIFT, K.WHEEL_LIFT_LUMA],
  gamma: [K.WHEEL_GAMMA, K.WHEEL_GAMMA_LUMA],
  gain: [K.WHEEL_GAIN, K.WHEEL_GAIN_LUMA],
  offset: [K.WHEEL_OFFSET, K.WHEEL_OFFSET_LUMA],
};

/** Resolve-style per-channel numbers under a wheel (gain as a multiplier, the others as offsets). */
export function wheelReadout(id: WheelId, w: WheelValue): string {
  const c = wheelChroma(w);
  const [kc, kl] = KS[id];
  const l = (w.luma / 100) * kl;
  const v = c.map((x) => x * kc + l);
  const f = (x: number) => (id === 'gain' ? (1 + x).toFixed(2) : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`);
  return `R ${f(v[0]!)}  G ${f(v[1]!)}  B ${f(v[2]!)}`;
}

const PRIMARY_KEYS = Object.keys(defaultPrimaries()).filter((k) => k !== 'enabled') as (keyof Omit<PrimariesSettings, 'enabled'>)[];

export function PrimariesSection({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const set = useSetColorPage(clip);
  const wheels = clip.grade.wheels;
  const pr = clip.grade.color.primaries;
  const setP = (patch: Partial<PrimariesSettings>) => set({ primaries: { ...pr, ...patch } });
  const setWheel = (id: WheelId, v: WheelValue) => updateClip(clip.id, { grade: { wheels: { ...wheels, [id]: v } } });
  const d = defaultPrimaries();
  const barNeutral = PRIMARY_KEYS.every((k) => k === 'lumMix' || pr[k] === d[k]);

  return (
    <>
      <Section
        id="color-wheels"
        title="Primaries · Wheels"
        checked={wheels.enabled}
        onCheck={(on) => updateClip(clip.id, { grade: { wheels: { ...wheels, enabled: on } } })}
        resetDisabled={WHEELS.every((w) => isNeutral(wheels[w.id]))}
        onReset={() => updateClip(clip.id, { grade: { wheels: { ...defaultWheels(), enabled: wheels.enabled } } })}
      >
        <div className="iwheels">
          {WHEELS.map((w) => (
            <WheelControl
              key={w.id}
              id={`p-${w.id}`}
              label={w.label}
              hint={w.hint}
              value={wheels[w.id]}
              lumaLabel="Master"
              readout={wheelReadout(w.id, wheels[w.id])}
              onChange={(v) => setWheel(w.id, v)}
            />
          ))}
        </div>
      </Section>
      <Section
        id="color-primaries"
        title="Primaries · Adjust"
        checked={pr.enabled}
        onCheck={(on) => setP({ enabled: on })}
        resetDisabled={barNeutral}
        onReset={() => setP({ ...defaultPrimaries(), enabled: pr.enabled, lumMix: pr.lumMix })}
      >
        <GroupLabel>Tone</GroupLabel>
        <SliderRow label="Contrast" value={pr.contrast} min={0} max={2} step={0.001} sliderStep={0.005} digits={3} fillFrom={1} keyframe={false} onChange={(v) => setP({ contrast: round(v, 3) })} testId="cp-contrast" />
        <SliderRow label="Pivot" value={pr.pivot} min={0} max={1} step={0.001} sliderStep={0.005} digits={3} fillFrom={PIVOT_DEFAULT} keyframe={false} onChange={(v) => setP({ pivot: round(v, 3) })} testId="cp-pivot" />
        <SliderRow label="Shadows" value={pr.shadows} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setP({ shadows: Math.round(v) })} testId="cp-shadows" />
        <SliderRow label="Highlights" value={pr.highlights} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setP({ highlights: Math.round(v) })} testId="cp-highlights" />
        <SliderRow label="Midtone detail" value={pr.midDetail} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setP({ midDetail: Math.round(v) })} testId="cp-middetail" />
        <GroupLabel>Colour</GroupLabel>
        <SliderRow
          label="Temp"
          value={pr.temp}
          min={-4000}
          max={4000}
          step={10}
          unit="K"
          fillFrom={0}
          keyframe={false}
          trackBackground="linear-gradient(90deg, #4f8cff, #888 50%, #ffb347)"
          onChange={(v) => setP({ temp: Math.round(v / 10) * 10 })}
          testId="cp-temp"
        />
        <SliderRow
          label="Tint"
          value={pr.tint}
          min={-100}
          max={100}
          fillFrom={0}
          keyframe={false}
          trackBackground="linear-gradient(90deg, #3ddc6a, #888 50%, #e05ce0)"
          onChange={(v) => setP({ tint: Math.round(v) })}
          testId="cp-tint"
        />
        <SliderRow label="Saturation" value={pr.saturation} min={0} max={100} step={0.1} digits={1} fillFrom={50} keyframe={false} onChange={(v) => setP({ saturation: round(v, 1) })} testId="cp-saturation" />
        <SliderRow
          label="Hue"
          value={pr.hue}
          min={0}
          max={100}
          step={0.1}
          digits={1}
          fillFrom={50}
          keyframe={false}
          trackBackground="linear-gradient(90deg, hsl(180 80% 50%), hsl(270 80% 55%), hsl(360 80% 55%), hsl(90 80% 50%), hsl(180 80% 50%))"
          onChange={(v) => setP({ hue: round(v, 1) })}
          testId="cp-hue"
        />
        <SliderRow label="Color boost" value={pr.colorBoost} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setP({ colorBoost: Math.round(v) })} testId="cp-boost" />
        <SliderRow label="Lum mix" value={pr.lumMix} min={0} max={100} keyframe={false} onChange={(v) => setP({ lumMix: Math.round(v) })} testId="cp-lummix" />
        <p className="ihint">Lum mix 100: the wheels' Master sliders change luminance only (saturation kept); 0: they act on R, G and B alike.</p>
      </Section>
    </>
  );
}
