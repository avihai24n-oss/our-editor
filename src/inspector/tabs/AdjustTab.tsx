/**
 * Adjust › Basic: Filter (look + intensity) and Adjust (Color / Lightness / Effects sliders),
 * footer "Apply to all" (same values to every clip on tracks of this kind) and "Reset".
 */
import { ADJUST_RANGES, FILTERS } from '../../model/catalog';
import { defaultAdjust } from '../../model/defaults';
import type { Adjust, FilterId, VisualClip } from '../../model/types';
import { useEditor } from '../../store';
import { FieldRow, GroupLabel, SegmentedTabs, Section, SliderRow, fromPct, toPct } from '../controls';
import { applyAllTargets } from '../inspectorLogic';

const TRACKS: Partial<Record<keyof Adjust, string>> = {
  temperature: 'linear-gradient(90deg, #3b4cff, #7a7a8a 50%, #ffe100)',
  tint: 'linear-gradient(90deg, #1fa52a, #7a7a8a 50%, #f01fff)',
  saturation: 'linear-gradient(90deg, #3a3a3a, #7a5a5a 50%, #ff2a2a)',
};

const GROUPS = ['Color', 'Lightness', 'Effects'] as const;

export function AdjustTab({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const updateClips = useEditor((s) => s.updateClips);
  const adj = clip.adjust;
  const neutral = Object.values(adj).every((v) => v === 0);

  const applyAll = () => {
    const ids = applyAllTargets(useEditor.getState().project, clip.id);
    if (ids.length) updateClips(ids, { adjust: { ...adj }, adjustEnabled: clip.adjustEnabled !== false, filter: clip.filter ? { ...clip.filter } : null });
  };

  return (
    <>
      <SegmentedTabs
        items={[
          { id: 'basic', label: 'Basic' },
          { id: 'hsl', label: 'HSL', disabled: true },
          { id: 'curves', label: 'Curves', disabled: true },
        ]}
        value="basic"
        onChange={() => undefined}
      />
      <Section
        id="filter"
        title="Filter"
        checked={!!clip.filter}
        onCheck={(on) => updateClip(clip.id, { filter: on ? { id: FILTERS[0]!.id, intensity: 1 } : null })}
        resetDisabled={!clip.filter}
        onReset={() => updateClip(clip.id, { filter: null })}
      >
        <FieldRow label="Name">
          <select
            aria-label="Filter"
            value={clip.filter?.id ?? ''}
            onChange={(e) => {
              const id = e.target.value as FilterId | '';
              updateClip(clip.id, { filter: id ? { id, intensity: clip.filter?.intensity ?? 1 } : null });
            }}
          >
            <option value="">None</option>
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </FieldRow>
        <SliderRow
          label="Intensity"
          value={toPct(clip.filter?.intensity ?? 1)}
          min={0}
          max={100}
          disabled={!clip.filter}
          onChange={(v) => clip.filter && updateClip(clip.id, { filter: { id: clip.filter.id, intensity: fromPct(v) } })}
          testId="filter-intensity"
        />
      </Section>
      <Section
        id="adjust"
        title="Adjust"
        keyframe
        checked={clip.adjustEnabled !== false}
        onCheck={(on) => updateClip(clip.id, { adjustEnabled: on })}
        resetDisabled={neutral} onReset={() => updateClip(clip.id, { adjust: defaultAdjust() })}>
        {GROUPS.map((g) => (
          <div key={g} className="igroup-block">
            <GroupLabel>{g}</GroupLabel>
            {ADJUST_RANGES.filter((r) => r.group === g).map((r) => (
              <SliderRow
                key={r.key}
                label={r.label}
                value={adj[r.key]}
                min={r.min}
                max={r.max}
                fillFrom={r.min < 0 ? 0 : undefined}
                trackBackground={TRACKS[r.key]}
                onChange={(v) => updateClip(clip.id, { adjust: { [r.key]: Math.round(v) } })}
                testId={`adjust-${r.key}`}
              />
            ))}
          </div>
        ))}
      </Section>
      <div className="ifoot">
        <span className="ifoot__spacer" />
        <button className="btn" onClick={applyAll} title="Apply these values to every clip on this kind of track">
          Apply to all
        </button>
        <button className="btn btn--primary" disabled title="Save as preset — coming soon">
          Save as preset
        </button>
      </div>
    </>
  );
}
