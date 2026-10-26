/**
 * Adjust › Color › Qualifier (DaVinci Resolve secondary): an HSL key (hue window that wraps
 * around 360°, saturation and luminance bands, each with a soft edge and its own switch), matte
 * finesse (clean black / white), invert, a power window (the Adjust › Mask shapes) and the
 * correction applied inside the matte. The eyedropper picks the colour from the player; Show
 * matte displays the key (white = selected). Engine: colorStage.ts step 9.
 */
import { ADJUST_MASK_SHAPES } from '../../../model/catalog';
import { defaultCorrection, defaultQualifier, defaultQualifierWindow, type QualifierSettings, type QualRange, type SecondaryCorrection } from '../../../model/colorPage';
import type { AdjustMask, AdjustMaskShape, VisualClip } from '../../../model/types';
import { useColorView } from '../../../player/color/colorView';
import { FieldRow, GroupLabel, Section, SliderRow, Toggle } from '../../controls';
import { round, useSetColorPage } from './common';

const HUE_TRACK = `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => `hsl(${i * 30} 85% 50%) ${(i / 12) * 100}%`).join(', ')})`;

/** The hue strip with the selected window drawn on it (wraps around). */
function HueRange({ center, width, soft, on }: { center: number; width: number; soft: number; on: boolean }) {
  const seg = (a: number, b: number, cls: string) => {
    const out: JSX.Element[] = [];
    let lo = a;
    let hi = b;
    if (hi - lo >= 360) {
      lo = 0;
      hi = 360;
    }
    const norm = (v: number) => ((v % 360) + 360) % 360;
    const s = norm(lo);
    const e = s + (hi - lo);
    const push = (x0: number, x1: number, k: string) => out.push(<span key={k} className={cls} style={{ left: `${(x0 / 360) * 100}%`, width: `${((x1 - x0) / 360) * 100}%` }} />);
    if (e <= 360) push(s, e, `${cls}a`);
    else {
      push(s, 360, `${cls}a`);
      push(0, e - 360, `${cls}b`);
    }
    return out;
  };
  return (
    <div className={`icolor-huerange${on ? '' : ' is-off'}`} style={{ backgroundImage: HUE_TRACK }} aria-hidden>
      {seg(center - width / 2 - soft, center + width / 2 + soft, 'icolor-huerange__soft')}
      {seg(center - width / 2, center + width / 2, 'icolor-huerange__core')}
    </div>
  );
}

function RangeRows({ label, r, onChange, testId }: { label: string; r: QualRange; onChange: (r: QualRange) => void; testId: string }) {
  return (
    <>
      <div className="icolor-qhead">
        <GroupLabel>{label}</GroupLabel>
        <Toggle on={r.on} onChange={(on) => onChange({ ...r, on })} label={`${label} key`} />
      </div>
      <SliderRow label="Low" value={r.low} min={0} max={100} step={0.1} digits={1} disabled={!r.on} keyframe={false} onChange={(v) => onChange({ ...r, low: round(Math.min(v, r.high), 1) })} testId={`${testId}-low`} />
      <SliderRow label="High" value={r.high} min={0} max={100} step={0.1} digits={1} disabled={!r.on} keyframe={false} onChange={(v) => onChange({ ...r, high: round(Math.max(v, r.low), 1) })} testId={`${testId}-high`} />
      <SliderRow label="Soft" value={r.soft} min={0} max={100} step={0.1} digits={1} disabled={!r.on} keyframe={false} onChange={(v) => onChange({ ...r, soft: round(v, 1) })} testId={`${testId}-soft`} />
    </>
  );
}

export function QualifierSection({ clip }: { clip: VisualClip }) {
  const set = useSetColorPage(clip);
  const q = clip.grade.color.qualifier;
  const pick = useColorView((s) => s.pickClipId === clip.id);
  const setPick = useColorView((s) => s.setPick);
  const setQ = (patch: Partial<QualifierSettings>) => set({ qualifier: { ...q, ...patch } });
  const setW = (patch: Partial<AdjustMask>) => setQ({ window: { ...q.window, ...patch } });
  const setC = (patch: Partial<SecondaryCorrection>) => setQ({ correction: { ...q.correction, ...patch } });
  const c = q.correction;
  const w = q.window;
  const isDefault = JSON.stringify(q) === JSON.stringify({ ...defaultQualifier(), enabled: q.enabled });
  return (
    <Section id="color-qualifier" title="Qualifier" note="secondary" checked={q.enabled} onCheck={(on) => setQ({ enabled: on })} resetDisabled={isDefault} onReset={() => setQ({ ...defaultQualifier(), enabled: q.enabled })}>
      <div className="icolor-qbar">
        <button
          type="button"
          className={`btn${pick ? ' btn--primary' : ''}`}
          onClick={() => setPick(pick ? null : clip.id)}
          title="Pick the colour to qualify from the player (Shift-click adds to the range)"
          data-testid="qual-pick"
        >
          {pick ? 'Click the player…' : 'Pick colour'}
        </button>
        <label className="icolor-check">
          <input type="checkbox" className="checkbox" checked={q.showMatte} onChange={(e) => setQ({ showMatte: e.target.checked, enabled: q.enabled || e.target.checked })} data-testid="qual-show-matte" />
          Show matte
        </label>
        <label className="icolor-check">
          <input type="checkbox" className="checkbox" checked={q.invert} onChange={(e) => setQ({ invert: e.target.checked })} data-testid="qual-invert" />
          Invert
        </label>
      </div>

      <div className="icolor-qhead">
        <GroupLabel>Hue</GroupLabel>
        <Toggle on={q.hue.on} onChange={(on) => setQ({ hue: { ...q.hue, on } })} label="Hue key" />
      </div>
      <HueRange center={q.hue.center} width={q.hue.width} soft={q.hue.soft} on={q.hue.on} />
      <SliderRow label="Center" value={q.hue.center} min={0} max={360} step={0.5} digits={1} unit="°" disabled={!q.hue.on} keyframe={false} trackBackground={HUE_TRACK} onChange={(v) => setQ({ hue: { ...q.hue, center: round(v, 1) } })} testId="qual-hue-center" />
      <SliderRow label="Width" value={q.hue.width} min={0} max={360} step={0.5} digits={1} unit="°" disabled={!q.hue.on} keyframe={false} onChange={(v) => setQ({ hue: { ...q.hue, width: round(v, 1) } })} testId="qual-hue-width" />
      <SliderRow label="Soft" value={q.hue.soft} min={0} max={180} step={0.5} digits={1} unit="°" disabled={!q.hue.on} keyframe={false} onChange={(v) => setQ({ hue: { ...q.hue, soft: round(v, 1) } })} testId="qual-hue-soft" />
      <RangeRows label="Saturation" r={q.sat} onChange={(sat) => setQ({ sat })} testId="qual-sat" />
      <RangeRows label="Luminance" r={q.lum} onChange={(lum) => setQ({ lum })} testId="qual-lum" />

      <GroupLabel>Matte finesse</GroupLabel>
      <SliderRow label="Clean black" value={q.cleanBlack} min={0} max={50} step={0.5} digits={1} keyframe={false} onChange={(v) => setQ({ cleanBlack: round(v, 1) })} testId="qual-clean-black" />
      <SliderRow label="Clean white" value={q.cleanWhite} min={0} max={50} step={0.5} digits={1} keyframe={false} onChange={(v) => setQ({ cleanWhite: round(v, 1) })} testId="qual-clean-white" />

      <div className="icolor-qhead">
        <GroupLabel>Power window</GroupLabel>
        <button type="button" className="link-btn" disabled={w.shape === 'none'} onClick={() => setQ({ window: defaultQualifierWindow() })}>
          Reset
        </button>
      </div>
      <FieldRow label="Shape">
        <select className="select" value={w.shape} onChange={(e) => setW({ shape: e.target.value as AdjustMaskShape })} data-testid="qual-window-shape" aria-label="Window shape">
          {ADJUST_MASK_SHAPES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </FieldRow>
      {w.shape !== 'none' && (
        <>
          <SliderRow label="Position X" value={round(w.x * 100)} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setW({ x: v / 100 })} testId="qual-win-x" />
          <SliderRow label="Position Y" value={round(w.y * 100)} min={-100} max={100} fillFrom={0} keyframe={false} onChange={(v) => setW({ y: v / 100 })} testId="qual-win-y" />
          {w.shape !== 'linear' && (
            <SliderRow label="Width" value={round(w.width * 100)} min={1} max={200} keyframe={false} onChange={(v) => setW({ width: v / 100 })} testId="qual-win-w" />
          )}
          {w.shape !== 'linear' && (
            <SliderRow label="Height" value={round(w.height * 100)} min={1} max={200} keyframe={false} onChange={(v) => setW({ height: v / 100 })} testId="qual-win-h" />
          )}
          <SliderRow label="Rotation" value={w.rotation} min={-180} max={180} unit="°" fillFrom={0} keyframe={false} onChange={(v) => setW({ rotation: Math.round(v) })} testId="qual-win-rot" />
          <SliderRow label="Feather" value={w.feather} min={0} max={100} keyframe={false} onChange={(v) => setW({ feather: Math.round(v) })} testId="qual-win-feather" />
          {w.shape === 'rectangle' && <SliderRow label="Round corners" value={w.roundness} min={0} max={100} keyframe={false} onChange={(v) => setW({ roundness: Math.round(v) })} />}
          <label className="icolor-check">
            <input type="checkbox" className="checkbox" checked={w.invert} onChange={(e) => setW({ invert: e.target.checked })} />
            Outside the window
          </label>
        </>
      )}

      <div className="icolor-qhead">
        <GroupLabel>Correction inside the matte</GroupLabel>
        <button type="button" className="link-btn" disabled={JSON.stringify(c) === JSON.stringify(defaultCorrection())} onClick={() => setQ({ correction: defaultCorrection() })}>
          Reset
        </button>
      </div>
      <SliderRow label="Exposure" value={c.exposure} min={-3} max={3} step={0.01} digits={2} unit=" EV" fillFrom={0} keyframe={false} onChange={(v) => setC({ exposure: round(v, 2) })} testId="qual-c-exposure" />
      <SliderRow label="Contrast" value={c.contrast} min={0} max={2} step={0.001} sliderStep={0.005} digits={3} fillFrom={1} keyframe={false} onChange={(v) => setC({ contrast: round(v, 3) })} testId="qual-c-contrast" />
      <SliderRow label="Saturation" value={c.saturation} min={0} max={200} unit="%" fillFrom={100} keyframe={false} onChange={(v) => setC({ saturation: Math.round(v) })} testId="qual-c-saturation" />
      <SliderRow label="Hue" value={c.hue} min={-180} max={180} unit="°" fillFrom={0} keyframe={false} onChange={(v) => setC({ hue: Math.round(v) })} testId="qual-c-hue" />
      <SliderRow label="Temp" value={c.temp} min={-4000} max={4000} step={10} unit="K" fillFrom={0} keyframe={false} trackBackground="linear-gradient(90deg, #4f8cff, #888 50%, #ffb347)" onChange={(v) => setC({ temp: Math.round(v / 10) * 10 })} testId="qual-c-temp" />
      <SliderRow label="Tint" value={c.tint} min={-100} max={100} fillFrom={0} keyframe={false} trackBackground="linear-gradient(90deg, #3ddc6a, #888 50%, #e05ce0)" onChange={(v) => setC({ tint: Math.round(v) })} testId="qual-c-tint" />
    </Section>
  );
}
