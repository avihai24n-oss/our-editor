# Clip context menu — integration contract

Right-click (or ⌃-click on a Mac) on a timeline clip opens CapCut's clip menu
(`src/timeline/contextMenu/`). An unselected clip becomes the selection first; a clip inside a
multi-selection keeps it. Branch `agent/ctx-menu`.

## Files

| File | What |
|---|---|
| `src/timeline/contextMenu/types.ts` | `MenuCtx`, `MenuItem` — the contract below |
| `src/timeline/contextMenu/registry.ts` | `slots`, `registerSlot`, `PLACEHOLDERS`, `resetSlots` |
| `src/timeline/contextMenu/clipMenu.ts` | `buildClipMenu(ctx)`: CapCut's list, in order, as groups (a separator between groups) |
| `src/timeline/contextMenu/ContextMenu.tsx` | the menu component (portal, fixed, viewport-clamped, hover/keyboard submenus) |
| `src/timeline/contextMenu/menuModel.ts` | pure placement + keyboard navigation |
| `src/actions/index.ts` | imports the slot modules (commented out until merged) |

## The types

```ts
export interface MenuCtx { clipIds: string[]; primaryId: string; trackId: string; time: number }

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;              // a name from ICONS in contextMenu/icons.tsx, or any kebab name in src/ui/Icon.tsx
  shortcut?: string;          // command id from src/timeline/shortcutDefs.ts (display only)
  disabled?: (ctx: MenuCtx) => boolean;
  hidden?: (ctx: MenuCtx) => boolean;
  tag?: 'Soon' | 'Free' | 'Pro';
  run?: (ctx: MenuCtx) => void;
  submenu?: (ctx: MenuCtx) => MenuItem[];
  separatorBefore?: boolean;  // extra: a line above this row inside a submenu
}
```

- `ctx.clipIds` is the selection after the right-click (never empty); `primaryId` is the clip
  under the pointer, `trackId` its track, `time` the timeline time under the pointer (µs).
- The menu calls `run(ctx)` after it closes. A row with `submenu` opens it on hover / → / Enter
  and is never `run`. `disabled` rows are skipped by the keyboard and ignore clicks.
- The menu is built when it opens, so a label can depend on the model (see "Restore audio").
- The key shown for `shortcut` is the command's `menu: true` combo if it has one, else its primary
  combo — so define the key in `shortcutDefs.ts`, not in the menu.

## Slots

```ts
import { registerSlot } from '../timeline/contextMenu/registry';
registerSlot('attributes', { id: 'attributes', label: 'Copy/paste attributes', icon: 'attributes', submenu: (ctx) => [...] });
```

| Slot | Row in the menu | Module | Owner |
|---|---|---|---|
| `attributes` | Copy/paste attributes › (after Cut) | `src/actions/attributes.ts` | attributes agent |
| `edit` | Edit › (after Delete) | `src/actions/editMenu.ts` | edit-menu agent |
| `isolateVoice` | Isolate voice › (after Generate captions) | `src/actions/isolateVoice.ts` | isolate-voice agent |
| `compound` | Create compound clip (subproject) ⌥G (after Group) | `src/actions/compound.ts` | compound agent |

- Each slot starts as a disabled "Soon" placeholder (`PLACEHOLDERS`). Calling `registerSlot` at
  module import time replaces it; `null` hides the row; the last registration wins.
- Keep the CapCut label. For `compound` keep `shortcut: 'compound'` (the ⌥G row in the table).
- Each module only calls `registerSlot`; it does not touch `clipMenu.ts`.
- **Integrator:** un-comment the module's line in `src/actions/index.ts`. `clipMenu.ts` imports
  `src/actions`, so the slots are registered before the first menu is built.
- Tests: `resetSlots()` restores the placeholders. In dev builds `window.__oeMenu` is the registry
  module (e2e can register a slot, see `e2e/context-menu.spec.ts`).

## What works in this round

Copy ⌘C, Cut ⌘X, Delete ⌫, Extract audio ⇧⌃S (label "Restore audio" when the clip's audio is
already extracted), Deactivate clip V ("Activate clip" when all the clips are disabled). They select
`ctx.clipIds` and run the same `runCommand` as the shortcuts. Every other row is disabled; the AI /
later ones carry "Soon"; Group is disabled without a tag, as in CapCut.

⇧⌃S: `extractAudio` gained a Mac-only `{ control: true, shift: true, menu: true }` combo
(`Combo.control` = the Control key alone, without ⌘). ⇧⌘S still works.
