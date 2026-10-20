/**
 * Minimal slot registry for the clip right-click menu: action modules register the item they own
 * under a slot name; the menu UI reads `slots` to place them. (The menu UI branch owns the full one.)
 */
import type { MenuItem } from './types';

export const slots = new Map<string, MenuItem>();

export function registerSlot(name: string, item: MenuItem): void {
  slots.set(name, item);
}
