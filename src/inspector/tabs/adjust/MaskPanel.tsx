/**
 * Adjust › Mask: limits the whole colour adjustment (LUT, Adjust, HSL, Curves, Color wheel and
 * the Filter look) to a shape on the clip: None, Linear, Mirror, Circle, Rectangle. Position,
 * rotation, size, feather, roundness (rectangle) and invert. Values are clip-relative, so the
 * mask follows the clip's transform.
 */
import { ADJUST_MASK_SHAPES } from '../../../model/catalog';
import { defaultAdjustMask } from '../../../model/defaults';
import type { AdjustMask, AdjustMaskShape, VisualClip } from '../../../model/types';
import { useEditor } from '../../../store';
import { Section, SliderRow, ToggleRow } from '../../controls';

function ShapeIcon({ shape }: { shape: AdjustMaskShape }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 };
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden>
      {shape === 'none' && (
        <>
          <circle cx={12} cy={12} r={8} {...common} />
          <line x1={6.5} y1={17.5} x2={17.5} y2={6.5} {...common} />
        </>
      )}
      {shape === 'linear' && (
        <>
          <rect x={4} y={4} width={16} height={16} rx={2} {...common} opacity={0.4} />
          <line x1={3} y1={12} x2={21} y2={12} {...common} />
        </>
      )}
      {shape === 'mirror' && (
        <>
          <rect x={4} y={4} width={16} height={16} rx={2} {...common} opacity={0.4} />
          <line x1={3} y1={9} x2={21} y2={9} {...common} />
          <line x1={3} y1={15} x2={21} y2={15} {...common} />
        </>
      )}
      {shape === 'circle' && <circle cx={12} cy={12} r={8} {...common} />}
      {shape === 'rectangle' && <rect x={4} y={6} width={16} height={12} rx={1.5} {...common} />}
    </svg>
  );
}

export function MaskPanel({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const m = clip.grade.mask;
  const set = (patch: Partial<AdjustMask>) => updateClip(clip.id, { grade: { mask: { ...m, ...patch } } });
  const def = defaultAdjustMask();
  const isDefault = (Object.keys(def) as (keyof AdjustMask)[]).every((k) => m[k] === def[k]);
  const on = m.shape !== 'none';
  return (
    <Section id="adjust-mask" title="Mask" onReset={() => updateClip(clip.id, { grade: { mask: defaultAdjustMask() } })} resetDisabled={isDefault}>
      <div className="imask" role="radiogroup" aria-label="Mask shape">
        {ADJUST_MASK_SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={m.shape === s.id}
            className={`imask__shape${m.shape === s.id ? ' is-active' : ''}`}
            onClick={() => set({ shape: s.id })}
            data-testid={`mask-${s.id}`}
            title={s.label}
          >
            <ShapeIcon shape={s.id} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      <p className="ihint">{on ? 'The adjustments apply inside the shape only.' : 'Pick a shape to limit the adjustments to part of the clip.'}</p>
      {on && (
        <>
          <SliderRow label="Position X" value={Math.round(m.x * 100)} min={-100} max={100} fillFrom={0} unit="%" onChange={(v) => set({ x: v / 100 })} testId="mask-x" />
          <SliderRow label="Position Y" value={Math.round(m.y * 100)} min={-100} max={100} fillFrom={0} unit="%" onChange={(v) => set({ y: v / 100 })} testId="mask-y" />
          <SliderRow label="Rotate" value={Math.round(m.rotation)} min={-180} max={180} fillFrom={0} unit="°" onChange={(v) => set({ rotation: v })} testId="mask-rotation" />
          {(m.shape === 'circle' || m.shape === 'rectangle') && (
            <SliderRow label="Width" value={Math.round(m.width * 100)} min={1} max={200} unit="%" onChange={(v) => set({ width: v / 100 })} testId="mask-width" />
          )}
          {m.shape !== 'linear' && (
            <SliderRow label="Height" value={Math.round(m.height * 100)} min={1} max={200} unit="%" onChange={(v) => set({ height: v / 100 })} testId="mask-height" />
          )}
          <SliderRow label="Feather" value={Math.round(m.feather)} min={0} max={100} onChange={(v) => set({ feather: v })} testId="mask-feather" />
          {m.shape === 'rectangle' && (
            <SliderRow label="Round corners" value={Math.round(m.roundness)} min={0} max={100} onChange={(v) => set({ roundness: v })} testId="mask-roundness" />
          )}
          <ToggleRow label="Invert" hint="Apply the adjustments outside the shape instead." on={m.invert} onChange={(invert) => set({ invert })} />
        </>
      )}
    </Section>
  );
}
