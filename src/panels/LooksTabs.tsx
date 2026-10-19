/**
 * Filters tab and Adjustment tab — both apply a "look" to the selected visual clip(s).
 * Tiles preview the look on the selected clip's thumbnail (or a sample scene).
 *  - Filters: sets clip.filter = {id, intensity 1}; "None" clears it. Intensity lives in the
 *    inspector (Adjust tab).
 *  - Adjustment: sets clip.adjust to a preset (neutral + preset values); "Reset" clears it.
 *    "My presets" lists the user's presets saved from inspector › Adjust › Save as preset.
 * Tile previews go through the real colour pipeline (./gradePreview.tsx), so a tile shows
 * exactly the look the player and the export render.
 */
import { useShallow } from 'zustand/react/shallow';
import { FILTERS } from '../model/catalog';
import { defaultAdjust } from '../model/defaults';
import { findClip } from '../model/project';
import type { FilterId } from '../model/types';
import { useEditor } from '../store';
import { GridLabel, LibraryBody, PresetTile, useFlash, type SidebarItem } from './LibraryLayout';
import { adjustOps, filterOps, GradedLook } from './gradePreview';
import { selectedVisualIds } from './libraryLogic';
import { presetPatch, useAdjustPresets } from '../store/adjustPresets';
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
            <PresetTile label="None" active={!!first && current === null} preview={<GradedLook ops={filterOps(null)} src={src} none />} onApply={() => apply(null)} />
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
                    preview={<GradedLook ops={filterOps(fid)} src={src} />}
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
  { id: 'mine', label: 'My presets' },
  { id: 'layer', label: 'Adjustment layer', disabled: true },
];

export function AdjustmentTab() {
  const [cat, setCat] = usePref('lib.adjustment.cat', 'presets');
  const { ids, first } = useTargets();
  const src = useSelectionThumb();
  const updateClips = useEditor((s) => s.updateClips);
  const [flash, showFlash] = useFlash();
  const mine = useAdjustPresets((s) => s.presets);
  const removePreset = useAdjustPresets((s) => s.remove);

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
        {cat !== 'mine' && (
          <>
            <GridLabel>Presets</GridLabel>
            <div className="lib-grid">
              <PresetTile label="Reset" active={isNeutral} preview={<GradedLook ops={adjustOps({})} src={src} none />} onApply={() => apply(defaultAdjust())} />
              {ADJUST_PRESETS.map((p) => (
                <PresetTile
                  key={p.id}
                  label={p.label}
                  active={activeId === p.id}
                  title={`${p.label} — sets Adjust › Basic on the selected clip`}
                  testId="adjust-preset"
                  preview={<GradedLook ops={adjustOps(p.adjust)} src={src} />}
                  onApply={() => apply({ ...defaultAdjust(), ...p.adjust })}
                />
              ))}
            </div>
          </>
        )}
        {(cat === 'mine' || mine.length > 0) && (
          <>
            <GridLabel>My presets</GridLabel>
            {mine.length === 0 ? (
              <p className="lib__hint" data-testid="my-presets-empty">
                No presets yet. Set up a look in the inspector › Adjust and press “Save as preset”.
              </p>
            ) : (
              <div className="lib-grid" data-testid="my-presets">
                {mine.map((p) => {
                  const f = p.filter ? filterOps(p.filter.id) : null;
                  return (
                    <div key={p.id} className="lib-mine">
                      <PresetTile
                        label={p.name}
                        title={`${p.name} — applies the saved adjustments to the selected clip`}
                        testId="user-preset"
                        preview={<GradedLook ops={adjustOps(p.adjust, p.grade, { grayscale: (f?.grayscale ?? 0) * (p.filter?.intensity ?? 0), sepia: (f?.sepia ?? 0) * (p.filter?.intensity ?? 0) })} src={src} />}
                        onApply={() => {
                          if (!ids.length) {
                            showFlash('Select a video, image or text clip first');
                            return;
                          }
                          updateClips(ids, presetPatch(p));
                        }}
                      />
                      <button className="lib-mine__del" title={`Delete ${p.name}`} aria-label={`Delete preset ${p.name}`} onClick={() => removePreset(p.id)}>
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        <p className="lib__hint">Fine-tune every value in the inspector › Adjust.</p>
      </div>
      {flash}
    </LibraryBody>
  );
}
