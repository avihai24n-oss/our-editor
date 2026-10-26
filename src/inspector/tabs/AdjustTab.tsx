/**
 * Inspector › Adjust (CapCut): sub-tabs Basic | HSL | Curves | Color wheel | Mask, footer
 * "Apply to all" (every adjustment to every clip on tracks of this kind) and "Save as preset"
 * (Library › Adjustment › My presets). Every control is undoable (one step per gesture) and
 * every section has its own reset. The AI rows (Auto adjust, Color match, Color correction)
 * show CapCut's disabled "coming soon" state.
 */
import { useState } from 'react';
import type { VisualClip } from '../../model/types';
import { nextPresetName, useAdjustPresets } from '../../store/adjustPresets';
import { useEditor } from '../../store';
import { usePref } from '../../panels/prefs';
import { SegmentedTabs } from '../controls';
import { applyAllTargets } from '../inspectorLogic';
import { BasicPanel } from './adjust/BasicPanel';
import { CurvesPanel } from './adjust/CurvesPanel';
import { HslPanel } from './adjust/HslPanel';
import { MaskPanel } from './adjust/MaskPanel';
import { WheelsPanel } from './adjust/WheelsPanel';
import { ColorPanel } from './color/ColorPanel';
import './adjust/adjust.css';

export type AdjustSub = 'basic' | 'hsl' | 'curves' | 'wheel' | 'mask' | 'color';

const SUBS: { id: AdjustSub; label: string; title?: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'hsl', label: 'HSL' },
  { id: 'curves', label: 'Curves' },
  { id: 'wheel', label: 'Color wheel' },
  { id: 'mask', label: 'Mask' },
  { id: 'color', label: 'Color', title: 'Color page (DaVinci-style primaries, log wheels, HSL curves, qualifier, gallery)' },
];

export function AdjustTab({ clip }: { clip: VisualClip }) {
  const [sub, setSub] = usePref<AdjustSub>('insp.adjust.sub', 'basic');
  const updateClips = useEditor((s) => s.updateClips);
  const addPreset = useAdjustPresets((s) => s.add);
  const presets = useAdjustPresets((s) => s.presets);
  const [naming, setNaming] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const showFlash = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash((m) => (m === msg ? null : m)), 2200);
  };

  const applyAll = () => {
    const ids = applyAllTargets(useEditor.getState().project, clip.id);
    if (!ids.length) return;
    updateClips(ids, {
      adjust: { ...clip.adjust },
      adjustEnabled: clip.adjustEnabled !== false,
      filter: clip.filter ? { ...clip.filter } : null,
      grade: clip.grade,
    });
    showFlash(`Applied to ${ids.length} clip${ids.length === 1 ? '' : 's'}`);
  };

  const savePreset = () => {
    if (naming === null) return;
    const p = addPreset(naming, clip);
    setNaming(null);
    showFlash(`Saved “${p.name}” to Adjustment › My presets`);
  };

  const current = SUBS.some((s) => s.id === sub) ? sub : 'basic';

  return (
    <>
      <SegmentedTabs items={SUBS} value={current} onChange={setSub} label="Adjust" />
      <div className="iadj" data-testid={`adjust-sub-${current}`}>
        {current === 'basic' && <BasicPanel clip={clip} />}
        {current === 'hsl' && <HslPanel clip={clip} />}
        {current === 'curves' && <CurvesPanel clip={clip} />}
        {current === 'wheel' && <WheelsPanel clip={clip} />}
        {current === 'mask' && <MaskPanel clip={clip} />}
        {current === 'color' && <ColorPanel clip={clip} />}
      </div>
      <div className="iadj-dock">
        {naming !== null && (
          <form
            className="ipreset"
            onSubmit={(e) => {
              e.preventDefault();
              savePreset();
            }}
          >
            <input
              autoFocus
              aria-label="Preset name"
              data-testid="preset-name"
              value={naming}
              maxLength={40}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setNaming(null);
                }
              }}
            />
            <button type="button" className="btn" onClick={() => setNaming(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" data-testid="preset-save">
              Save
            </button>
          </form>
        )}
        {flash && (
          <div className="iadj-flash" role="status">
            {flash}
          </div>
        )}
        <div className="ifoot">
          <span className="ifoot__spacer" />
          <button
            className="btn"
            onClick={applyAll}
            title="Apply every adjustment of this clip to all clips on this kind of track"
            data-testid="adjust-apply-all"
          >
            Apply to all
          </button>
          <button
            className="btn btn--primary"
            onClick={() => setNaming(nextPresetName(presets))}
            title="Save these adjustments as a preset (Library › Adjustment › My presets)"
            data-testid="adjust-save-preset"
          >
            Save as preset
          </button>
        </div>
      </div>
    </>
  );
}
