/**
 * The clip context menu's extension contract (docs/integration-notes/context-menu.md).
 * Pure types: no React, no store.
 */

/** What the menu was opened on. */
export interface MenuCtx {
  /** The clips the menu acts on (the selection after the right-click; never empty). */
  clipIds: string[];
  /** The clip that was right-clicked. */
  primaryId: string;
  /** Its track. */
  trackId: string;
  /** Timeline time under the pointer, µs. */
  time: number;
}

export interface MenuItem {
  id: string;
  label: string;
  /** Icon name: see ICONS in ./icons.tsx, or any kebab name from src/ui/Icon.tsx. */
  icon?: string;
  /** A command id from src/timeline/shortcutDefs.ts; the menu shows its key (display only). */
  shortcut?: string;
  disabled?: (ctx: MenuCtx) => boolean;
  hidden?: (ctx: MenuCtx) => boolean;
  tag?: 'Soon' | 'Free' | 'Pro';
  run?: (ctx: MenuCtx) => void;
  /** Items of a › submenu (opens on hover or →). */
  submenu?: (ctx: MenuCtx) => MenuItem[];
  /** Draw a separator line above this item (inside a submenu; the main menu is built in groups). */
  separatorBefore?: boolean;
}
