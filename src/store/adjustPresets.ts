/**
 * User adjustment presets ("Save as preset" in inspector › Adjust). They live in localStorage
 * (per browser, like CapCut's "My presets") and show in Library › Adjustment › My presets.
 * A preset carries Basic › Adjust, the Filter, LUT, HSL, Curves and Color wheel — not the Mask,
 * which belongs to one clip's framing.
 */
import { create } from 'zustand';
import { defaultAdjust, defaultGrade, newId } from '../model/defaults';
import type { Adjust, ColorGrade, FilterRef, VisualClip } from '../model/types';

export interface UserAdjustPreset {
  id: string;
  name: string;
  createdAt: number;
  adjust: Adjust;
  adjustEnabled: boolean;
  filter: FilterRef | null;
  grade: Omit<ColorGrade, 'mask'>;
}

export const PRESETS_KEY = 'our-editor:adjust-presets';

function load(): UserAdjustPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((p): p is UserAdjustPreset => !!p && typeof p === 'object' && typeof (p as UserAdjustPreset).id === 'string')
      .map((p) => {
        const g = defaultGrade();
        return {
          ...p,
          name: String(p.name ?? 'Preset'),
          adjust: { ...defaultAdjust(), ...(p.adjust ?? {}) },
          adjustEnabled: p.adjustEnabled !== false,
          filter: p.filter ?? null,
          grade: {
            lut: { ...g.lut, ...(p.grade?.lut ?? {}) },
            hsl: { ...g.hsl, ...(p.grade?.hsl ?? {}), bands: { ...g.hsl.bands, ...(p.grade?.hsl?.bands ?? {}) } },
            curves: { ...g.curves, ...(p.grade?.curves ?? {}) },
            wheels: { ...g.wheels, ...(p.grade?.wheels ?? {}) },
          },
        };
      });
  } catch {
    return [];
  }
}

function save(list: UserAdjustPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable: the preset stays for this session */
  }
}

interface PresetState {
  presets: UserAdjustPreset[];
  add: (name: string, clip: VisualClip) => UserAdjustPreset;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  /** Re-read localStorage (another tab, tests). */
  reload: () => void;
}

export const useAdjustPresets = create<PresetState>((set, get) => ({
  presets: load(),
  add: (name, clip) => {
    const { mask: _mask, ...grade } = JSON.parse(JSON.stringify(clip.grade)) as ColorGrade;
    const p: UserAdjustPreset = {
      id: newId('aps'),
      name: name.trim() || 'Preset',
      createdAt: Date.now(),
      adjust: { ...clip.adjust },
      adjustEnabled: clip.adjustEnabled !== false,
      filter: clip.filter ? { ...clip.filter } : null,
      grade,
    };
    const presets = [...get().presets, p];
    save(presets);
    set({ presets });
    return p;
  },
  remove: (id) => {
    const presets = get().presets.filter((p) => p.id !== id);
    save(presets);
    set({ presets });
  },
  rename: (id, name) => {
    const presets = get().presets.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p));
    save(presets);
    set({ presets });
  },
  reload: () => set({ presets: load() }),
}));

/** The clip patch that applies a preset (one undo step via updateClips). */
export function presetPatch(p: UserAdjustPreset) {
  return {
    adjust: { ...defaultAdjust(), ...p.adjust },
    adjustEnabled: p.adjustEnabled,
    filter: p.filter ? { ...p.filter } : null,
    grade: JSON.parse(JSON.stringify(p.grade)) as Omit<ColorGrade, 'mask'>,
  };
}

/** Default name for the next preset ("Preset 3"). */
export function nextPresetName(list: UserAdjustPreset[]): string {
  let n = list.length + 1;
  while (list.some((p) => p.name === `Preset ${n}`)) n++;
  return `Preset ${n}`;
}
