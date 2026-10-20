/**
 * Slots of the clip right-click menu. Feature modules register their item under a slot id
 * (e.g. 'edit'); the menu UI reads `slots` when it opens. Minimal: one item per slot, last wins.
 */
import type { MenuItem } from './types';

export const slots = new Map<string, MenuItem>();

export function registerSlot(id: string, item: MenuItem): void {
  slots.set(id, item);
}
