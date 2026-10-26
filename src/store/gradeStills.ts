/**
 * Adjust › Color: the grade clipboard (Copy grade / Paste grade, also onto several selected
 * clips) and the Gallery of stills (a grade saved with a thumbnail of the frame, per browser in
 * localStorage — like Resolve's gallery stills / CapCut's "My presets").
 *
 * A "grade" here is every colour setting of a clip: Basic › Adjust (+ its checkbox), the Filter
 * and the whole `grade` (LUT, HSL, Curves, wheels, Adjust mask, Color page). Applying one is a
 * single undoable updateClips call.
 */
import { create } from 'zustand';
import { normalizeColorPage } from '../model/colorPage';
import { defaultAdjust, defaultGrade, newId } from '../model/defaults';
import { findClip } from '../model/project';
import type { Adjust, ClipPatch, ColorGrade, FilterRef, Id, VisualClip } from '../model/types';
import { useEditor } from './index';

export interface GradeLook {
  adjust: Adjust;
  adjustEnabled: boolean;
  filter: FilterRef | null;
  grade: ColorGrade;
}

export interface GradeStill {
  id: string;
  name: string;
  createdAt: number;
  /** Small JPEG data URL of the frame when the still was grabbed ('' = none). */
  thumb: string;
  look: GradeLook;
}

export const STILLS_KEY = 'our-editor:grade-stills';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function lookOf(clip: VisualClip): GradeLook {
  return clone({ adjust: clip.adjust, adjustEnabled: clip.adjustEnabled !== false, filter: clip.filter, grade: clip.grade });
}

/** A complete look from anything stored (missing parts get neutral defaults). */
export function normalizeLook(raw: unknown): GradeLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<GradeLook>;
  const d = defaultGrade();
  const g = (r.grade ?? {}) as Partial<ColorGrade>;
  return {
    adjust: { ...defaultAdjust(), ...(r.adjust ?? {}) },
    adjustEnabled: r.adjustEnabled !== false,
    filter: r.filter ?? null,
    grade: {
      lut: { ...d.lut, ...(g.lut ?? {}) },
      hsl: { ...d.hsl, ...(g.hsl ?? {}), bands: { ...d.hsl.bands, ...(g.hsl?.bands ?? {}) } },
      curves: { ...d.curves, ...(g.curves ?? {}) },
      wheels: { ...d.wheels, ...(g.wheels ?? {}) },
      mask: { ...d.mask, ...(g.mask ?? {}) },
      color: normalizeColorPage(g.color),
    },
  };
}

/** The clip patch that applies a look. */
export function lookPatch(l: GradeLook): ClipPatch {
  const c = clone(l);
  return { adjust: c.adjust, adjustEnabled: c.adjustEnabled, filter: c.filter, grade: c.grade };
}

/** Applies a look to every (unlocked, visual) clip of `ids` as ONE undo step. Returns the ids changed. */
export function applyLook(ids: readonly Id[], look: GradeLook): Id[] {
  const st = useEditor.getState();
  const targets = ids.filter((id) => {
    const f = findClip(st.project, id);
    return !!f && !f.track.locked && f.clip.type !== 'audio';
  });
  if (targets.length) st.updateClips([...targets], lookPatch(look));
  return targets;
}

function load(): GradeStill[] {
  try {
    const raw = localStorage.getItem(STILLS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((s): s is GradeStill => !!s && typeof s === 'object' && typeof (s as GradeStill).id === 'string')
      .map((s) => ({ id: s.id, name: String(s.name ?? 'Still'), createdAt: Number(s.createdAt) || 0, thumb: typeof s.thumb === 'string' ? s.thumb : '', look: normalizeLook(s.look) }));
  } catch {
    return [];
  }
}

function save(list: GradeStill[]): void {
  try {
    localStorage.setItem(STILLS_KEY, JSON.stringify(list));
  } catch {
    /* storage full: the still stays for this session */
  }
}

interface StillsState {
  stills: GradeStill[];
  /** Copied grade (session only). */
  clipboard: GradeLook | null;
  copy: (clip: VisualClip) => void;
  addStill: (clip: VisualClip, thumb: string, name?: string) => GradeStill;
  removeStill: (id: string) => void;
  renameStill: (id: string, name: string) => void;
  reload: () => void;
}

export const useGradeStills = create<StillsState>((set, get) => ({
  stills: load(),
  clipboard: null,
  copy: (clip) => set({ clipboard: lookOf(clip) }),
  addStill: (clip, thumb, name) => {
    const n = get().stills.length + 1;
    const s: GradeStill = { id: newId('still'), name: (name ?? '').trim() || `Still ${n}`, createdAt: Date.now(), thumb, look: lookOf(clip) };
    const stills = [...get().stills, s];
    save(stills);
    set({ stills });
    return s;
  },
  removeStill: (id) => {
    const stills = get().stills.filter((s) => s.id !== id);
    save(stills);
    set({ stills });
  },
  renameStill: (id, name) => {
    const stills = get().stills.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s));
    save(stills);
    set({ stills });
  },
  reload: () => set({ stills: load() }),
}));

/** Thumbnail (≤ 160 px wide JPEG) of the player's current frame, '' when unavailable. */
export function grabPlayerThumb(): string {
  try {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="player-canvas"]');
    if (!c || !c.width || !c.height) return '';
    const k = Math.min(1, 160 / c.width);
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(c.width * k));
    t.height = Math.max(1, Math.round(c.height * k));
    t.getContext('2d')?.drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.72);
  } catch {
    return '';
  }
}
