/**
 * Filters tab and Adjustment tab — both apply a "look" to the selected visual clip(s).
 * Tiles preview the look on the selected clip's thumbnail (or a sample scene).
 *  - Filters: sets clip.filter = {id, intensity 1}; "None" clears it. Intensity lives in the
 *    inspector (Adjust tab).
 *  - Adjustment: sets clip.adjust to a preset (neutral + preset values); "Reset" clears it.
 */
import { useShallow } from 'zustand/react/shallow';
import { FILTERS } from '../model/catalog';
import { defaultAdjust } from '../model/defaults';
import { findClip } from '../model/project';
import type { FilterId } from '../model/types';
import { useEditor } from '../store';
import { GridLabel, LibraryBody, PresetTile, useFlash, type SidebarItem } from './LibraryLayout';
import { adjustToCssFilter, filterCss, selectedVisualIds } from './libraryLogic';
import { ADJUST_PRESETS, FILTER_GROUPS } from './presets';
import { usePref } from './prefs';
import { useAssetThumb } from './thumbnails';

/** Thumbnail of the (first) selected visual clip, used as the preview picture. */
function useSelectionThumb() {
  const asset = useEditor((s) => {
    const id = s.selection.clipIds[0];
    const f = id ? findClip(s.project, id) : undefined;
    if (!f || (f.clip.type !== 'video' && f.clip.type !== 'image')) return undefined;
    return s.project.assets[f.clip.assetId];
  });
  return useAssetThumb(asset);
}

function LookPreview({ css, src, none }: { css: string; src?: string; none?: boolean }) {
  return (
    <div className="look">
      {src ? <img src={src} alt="" draggable={false} style={{ filter: css }} /> : <div className="look__scene" style={{ filter: css }} />}
      {none && (
        <div className="look__none" aria-hidden>
          ⊘
        </div>
      )}
    </div>
  );
}

function useTargets() {
  const ids = useEditor(useShallow((s) => selectedVisualIds(s.project, s.selection.clipIds)));
  const first = useEditor((s) => (ids[0] ? findClip(s.project, ids[0])?.clip : undefined));
  return { ids, first: first && first.type !== 'audio' ? first : undefined };
}

const FILTER_SIDEBAR: SidebarItem[] = [{ id: 'all', label: 'All' }, ...FILTER_GROUPS.map((g) => ({ id: g.id, label: g.label }))];

export function FiltersTab() {
  const [cat, setCat] = usePref('lib.filters.cat', 'all');
  const { ids, first } = useTargets();
  const src = useSelectionThumb();
  const updateClips = useEditor((s) => s.updateClips);
  const [flash, showFlash] = useFlash();
  const current = first?.filter?.id ?? null;

  const apply = (id: FilterId | null) => {
    if (!ids.length) {
      showFlash('Select a video, image or text clip first');
      return;
    }
    updateClips(ids, { filter: id ? { id, intensity: first?.filter?.id === id ? first.filter.intensity : 1 } : null });
  };
  const groups = cat === 'all' ? FILTER_GROUPS : FILTER_GROUPS.filter((g) => g.id === cat);

  return (
    <LibraryBody sidebar={FILTER_SIDEBAR} value={cat} onChange={setCat}>
      <div className="lib__scroll">
        {cat === 'all' && (
          <div className="lib-grid">
            <PresetTile label="None" active={!!first && current === null} preview={<LookPreview css="none" src={src} none />} onApply={() => apply(null)} />
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id}>
            <GridLabel>{g.label}</GridLabel>
            <div className="lib-grid">
              {g.ids.map((fid) => {
                const def = FILTERS.find((f) => f.id === fid);
                if (!def) return null;
                return (
                  <PresetTile
                    key={fid}
                    label={def.label}
                    active={current === fid}
                    title={`${def.label} — applies to the selected clip`}
                    testId="filter-preset"
                    preview={<LookPreview css={filterCss(fid)} src={src} />}
                    onApply={() => apply(fid)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {flash}
    </LibraryBody>
  );
}

const ADJ_SIDEBAR: SidebarItem[] = [
  { id: 'presets', label: 'Presets' },
  { id: 'layer', label: 'Adjustment layer', disabled: true },
];

export function AdjustmentTab() {
  const [cat, setCat] = usePref('lib.adjustment.cat', 'presets');
  const { ids, first } = useTargets();
  const src = useSelectionThumb();
  const updateClips = useEditor((s) => s.updateClips);
  const [flash, showFlash] = useFlash();

  const isNeutral = !!first && Object.values(first.adjust).every((v) => v === 0);
  const activeId =
    first &&
    ADJUST_PRESETS.find((p) => {
      const want = { ...defaultAdjust(), ...p.adjust };
      return (Object.keys(want) as (keyof typeof want)[]).every((k) => first.adjust[k] === want[k]);
    })?.id;

  const apply = (adjust: ReturnType<typeof defaultAdjust>) => {
    if (!ids.length) {
      showFlash('Select a video, image or text clip first');
      return;
    }
    updateClips(ids, { adjust });
  };

  return (
    <LibraryBody sidebar={ADJ_SIDEBAR} value={cat} onChange={setCat}>
      <div className="lib__scroll">
        <GridLabel>Presets</GridLabel>
        <div className="lib-grid">
          <PresetTile label="Reset" active={isNeutral} preview={<LookPreview css="none" src={src} none />} onApply={() => apply(defaultAdjust())} />
          {ADJUST_PRESETS.map((p) => (
            <PresetTile
              key={p.id}
              label={p.label}
              active={activeId === p.id}
              title={`${p.label} — sets Adjust › Basic on the selected clip`}
              testId="adjust-preset"
              preview={<LookPreview css={adjustToCssFilter(p.adjust)} src={src} />}
              onApply={() => apply({ ...defaultAdjust(), ...p.adjust })}
            />
          ))}
        </div>
        <p className="lib__hint">Fine-tune every value in the inspector › Adjust.</p>
      </div>
      {flash}
    </LibraryBody>
  );
}
