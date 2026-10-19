/**
 * Adjust › HSL: eight colour ranges (red … magenta), each with Hue / Saturation / Lightness
 * −100…100. Pick a range with the colour dots; a dot with a change shows a ring.
 */
import { HSL_RANGES } from '../../../model/catalog';
import { defaultHsl, defaultHslBand } from '../../../model/defaults';
import type { HslBand, HslColor, VisualClip } from '../../../model/types';
import { useEditor } from '../../../store';
import { usePref } from '../../../panels/prefs';
import { Section, SliderRow } from '../../controls';

const isNeutralBand = (b: HslBand) => !b.hue && !b.saturation && !b.lightness;

export function HslPanel({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const hsl = clip.grade.hsl;
  const [sel, setSel] = usePref<HslColor>('insp.adjust.hsl', 'red');
  const range = HSL_RANGES.find((r) => r.id === sel) ?? HSL_RANGES[0]!;
  const band = hsl.bands[range.id] ?? defaultHslBand();
  const setBand = (patch: Partial<HslBand>) =>
    updateClip(clip.id, { grade: { hsl: { ...hsl, bands: { ...hsl.bands, [range.id]: { ...band, ...patch } } } } });
  const allNeutral = HSL_RANGES.every((r) => isNeutralBand(hsl.bands[r.id] ?? defaultHslBand()));
  const h = range.hue;

  return (
    <Section
      id="hsl"
      title="HSL"
      checked={hsl.enabled}
      onCheck={(on) => updateClip(clip.id, { grade: { hsl: { ...hsl, enabled: on } } })}
      resetDisabled={allNeutral}
      onReset={() => updateClip(clip.id, { grade: { hsl: defaultHsl() } })}
    >
      <div className="ihsl" role="radiogroup" aria-label="Colour range">
        {HSL_RANGES.map((r) => {
          const changed = !isNeutralBand(hsl.bands[r.id] ?? defaultHslBand());
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={r.id === range.id}
              aria-label={r.label}
              title={r.label}
              data-testid={`hsl-${r.id}`}
              className={`ihsl__dot${r.id === range.id ? ' is-active' : ''}${changed ? ' is-changed' : ''}`}
              style={{ background: r.swatch }}
              onClick={() => setSel(r.id)}
            />
          );
        })}
      </div>
      <div className="ihsl__head">
        <span>{range.label}</span>
        <button type="button" className="link-btn" disabled={isNeutralBand(band)} onClick={() => setBand(defaultHslBand())} data-testid="hsl-reset-range">
          Reset {range.label.toLowerCase()}
        </button>
      </div>
      <SliderRow
        label="Hue"
        value={band.hue}
        min={-100}
        max={100}
        trackBackground={`linear-gradient(90deg, hsl(${h - 30} 90% 55%), hsl(${h} 90% 55%) 50%, hsl(${h + 30} 90% 55%))`}
        onChange={(v) => setBand({ hue: Math.round(v) })}
        testId="hsl-hue"
      />
      <SliderRow
        label="Saturation"
        value={band.saturation}
        min={-100}
        max={100}
        trackBackground={`linear-gradient(90deg, hsl(${h} 0% 50%), hsl(${h} 100% 50%))`}
        onChange={(v) => setBand({ saturation: Math.round(v) })}
        testId="hsl-saturation"
      />
      <SliderRow
        label="Lightness"
        value={band.lightness}
        min={-100}
        max={100}
        trackBackground={`linear-gradient(90deg, hsl(${h} 90% 8%), hsl(${h} 90% 50%) 50%, hsl(${h} 90% 92%))`}
        onChange={(v) => setBand({ lightness: Math.round(v) })}
        testId="hsl-lightness"
      />
    </Section>
  );
}
