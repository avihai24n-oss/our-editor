/**
 * Minimal slot registry for the clip right-click menu: feature modules register the item that
 * fills a named slot; the menu UI reads `getSlot(name)` when it builds the menu.
 */
import type { MenuItem } from './types';

const slots = new Map<string, MenuItem>();

export function registerSlot(name: string, item: MenuItem): void {
  slots.set(name, item);
}

export function getSlot(name: string): MenuItem | undefined {
  return slots.get(name);
}

export function listSlots(): ReadonlyMap<string, MenuItem> {
  return slots;
}
