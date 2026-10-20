/**
 * Slots other modules plug into the clip context menu. Each slot starts as a disabled "Soon"
 * placeholder; a module (src/actions/*.ts) replaces it at import time with `registerSlot`.
 * See docs/integration-notes/context-menu.md.
 */
import type { MenuItem } from './types';

export type SlotName = 'attributes' | 'edit' | 'isolateVoice' | 'compound';

const off = () => true;

/** The placeholders, also used to reset the slots in tests. */
export const PLACEHOLDERS: Record<SlotName, MenuItem> = {
  attributes: { id: 'attributes', label: 'Copy/paste attributes', icon: 'attributes', tag: 'Soon', disabled: off, submenu: () => [] },
  edit: { id: 'edit', label: 'Edit', icon: 'edit', tag: 'Soon', disabled: off, submenu: () => [] },
  isolateVoice: { id: 'isolateVoice', label: 'Isolate voice', icon: 'voice', tag: 'Soon', disabled: off, submenu: () => [] },
  compound: { id: 'compound', label: 'Create compound clip (subproject)', icon: 'compound', shortcut: 'compound', tag: 'Soon', disabled: off },
};

export const slots: Record<SlotName, MenuItem | null> = { ...PLACEHOLDERS };

/** Puts `item` in the menu at `name`'s place (null hides the row). Last registration wins. */
export function registerSlot(name: SlotName, item: MenuItem | null): void {
  slots[name] = item;
}

/** Test helper: back to the placeholders. */
export function resetSlots(): void {
  Object.assign(slots, PLACEHOLDERS);
}
