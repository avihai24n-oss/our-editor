/**
 * Slot registry of the clip right-click menu (minimal version: the menu UI looks items up by slot
 * id). A module registers its item once, at import time; registering a slot again replaces it.
 */
import type { MenuItem } from './types';

const slots = new Map<string, MenuItem>();

export function registerSlot(slot: string, item: MenuItem): void {
  slots.set(slot, item);
}

export function getSlot(slot: string): MenuItem | undefined {
  return slots.get(slot);
}

export function registeredSlots(): string[] {
  return [...slots.keys()];
}
