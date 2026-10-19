/**
 * Tiny UI state shared by the inspector and the player: while the Video › Mask sub-tab is open
 * the player draws the selected clip's mask outline with move / size / rotate / feather handles.
 * Not part of the project (not saved, not undoable).
 */
import { create } from 'zustand';

interface MaskEditState {
  active: boolean;
  setActive: (on: boolean) => void;
}

export const useMaskEdit = create<MaskEditState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
