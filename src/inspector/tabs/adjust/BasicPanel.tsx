/**
 * Adjust › Basic: Auto adjust / Color match / Color correction (AI — disabled, coming soon),
 * Filter (look + intensity), LUT (.cube import, intensity, protect skin tone) and Adjust
 * (Color / Lightness / Effects sliders).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cachedLutList, importCubeFile, listLuts, onLutsChange, type LutMeta } from '../../../engine/color/lutLibrary';
import { ADJUST_RANGES, FILTERS } from '../../../model/catalog';
import { defaultAdjust, defaultLut } from '../../../model/defaults';
import type { Adjust, FilterId, LutSettings, VisualClip } from '../../../model/types';
import { useEditor } from '../../../store';
import { FieldRow, GroupLabel, Section, SliderRow, ToggleRow, fromPct, toPct } from '../../controls';

const TRACKS: Partial<Record<keyof Adjust, string>> = {
  temperature: 'linear-gradient(90deg, #3b4cff, #7a7a8a 50%, #ffe100)',
  tint: 'linear-gradient(90deg, #1fa52a, #7a7a8a 50%, #f01fff)',
  saturation: 'linear-gradient(90deg, #3a3a3a, #7a5a5a 50%, #ff2a2a)',
};

const GROUPS = ['Color', 'Lightness', 'Effects'] as const;

const AI_ROWS = [
  { id: 'auto-adjust', title: 'Auto adjust' },
  { id: 'color-match', title: 'Color match' },
  { id: 'color-correction', title: 'Color correction' },
];

/** CapCut's AI rows: unchecked, dimmed, not clickable. */
function AiRow({ id, title }: { id: string; title: string }) {
  return (
    <section className="isec is-off is-ai" data-testid={`adjust-ai-${id}`} title={`${title} uses AI — coming soon`}>
      <header className="isec__head">
        <input type="checkbox" className="checkbox" checked={false} disabled aria-label={`Enable ${title}`} onChange={() => undefined} />
        <span className="isec__title isec__title--static">{title}</span>
        <span className="iai-badge">AI</span>
        <span className="isec__note">Coming soon</span>
      </header>
    </section>
  );
}

/** Library list, kept fresh across imports. */
export function useLutList(): LutMeta[] {
  const list = useSyncExternalStore(onLutsChange, cachedLutList, cachedLutList);
  useEffect(() => {
    if (!cachedLutList()) void listLuts().then(() => undefined);
  }, []);
  return list ?? [];
}

export function BasicPanel({ clip }: { clip: VisualClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const adj = clip.adjust;
  const neutral = Object.values(adj).every((v) => v === 0);
  const lut = clip.grade.lut;
  const luts = useLutList();
  const fileRef = useRef<HTMLInputElement>(null);
  const [lutError, setLutError] = useState<string | null>(null);
  const setLut = (patch: Partial<LutSettings>) => updateClip(clip.id, { grade: { lut: { ...lut, ...patch } } });
  const lutMissing = !!lut.lutId && !luts.some((l) => l.id === lut.lutId);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setLutError(null);
    try {
      const meta = await importCubeFile(file);
      setLut({ lutId: meta.id, name: meta.name, enabled: true });
    } catch (e) {
      setLutError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {AI_ROWS.map((r) => (
        <AiRow key={r.id} {...r} />
      ))}
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
        id="lut"
        title="LUT"
        checked={lut.enabled}
        onCheck={(on) => setLut({ enabled: on })}
        resetDisabled={!lut.lutId && lut.intensity === 1 && !lut.protectSkin}
        onReset={() => updateClip(clip.id, { grade: { lut: defaultLut() } })}
      >
        <FieldRow label="Name">
          <div className="ilut">
            <select
              aria-label="LUT"
              data-testid="lut-select"
              value={lut.lutId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__import') {
                  fileRef.current?.click();
                  return;
                }
                const meta = luts.find((l) => l.id === v);
                setLut(meta ? { lutId: meta.id, name: meta.name, enabled: true } : { lutId: null, name: '' });
              }}
            >
              <option value="">None</option>
              {luts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name.replace(/\.cube$/i, '')}
                </option>
              ))}
              {lutMissing && <option value={lut.lutId!}>{`${lut.name || 'LUT'} (missing)`}</option>}
              <option value="__import">Import .cube…</option>
            </select>
            <button type="button" className="btn ilut__import" onClick={() => fileRef.current?.click()} title="Import a .cube LUT file">
              Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".cube,.CUBE"
              hidden
              data-testid="lut-import-input"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </FieldRow>
        {lutError && <div className="ierror" role="alert">{lutError}</div>}
        {lutMissing && <div className="ierror">This LUT is not in this browser. Import it again to use it.</div>}
        <SliderRow
          label="Intensity"
          value={toPct(lut.intensity)}
          min={0}
          max={100}
          disabled={!lut.lutId}
          onChange={(v) => setLut({ intensity: fromPct(v) })}
          testId="lut-intensity"
        />
        <ToggleRow
          label="Protect skin tone"
          hint="Turn it on to make skin tones more natural."
          on={lut.protectSkin}
          disabled={!lut.lutId}
          onChange={(on) => setLut({ protectSkin: on })}
        />
      </Section>
      <Section
        id="adjust"
        title="Adjust"
        checked={clip.adjustEnabled !== false}
        onCheck={(on) => updateClip(clip.id, { adjustEnabled: on })}
        resetDisabled={neutral}
        onReset={() => updateClip(clip.id, { adjust: defaultAdjust() })}
      >
        {GROUPS.map((g) => (
          <div key={g} className="igroup-block">
            <GroupLabel>{g}</GroupLabel>
            {ADJUST_RANGES.filter((r) => r.group === g).map((r) => (
              <SliderRow
                key={r.key}
                label={r.label}
                value={adj[r.key] ?? 0}
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
    </>
  );
}
