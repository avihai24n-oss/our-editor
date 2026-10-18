# 05 — UI kit (`src/ui/`): icons and primitives

Use these. Don't draw your own SVGs or style your own icon buttons. If an icon is missing, add it
to `src/ui/icons.tsx` (and the kebab-case entry in `src/ui/Icon.tsx`) instead of putting it inline in your feature.

## Files

| File | What it is |
|---|---|
| `src/ui/icons.tsx` | 75+ inline-SVG line icons in CapCut's style. `Icons` map (PascalCase), `IconName` type, `<Icon name>` component, `iconNames` list |
| `src/ui/Icon.tsx` | Kebab-case adapter over the same icons: `<Icon name="chevron-down" />`, `IconName` = `'chevron-down' \| 'reset' \| …`. Used by `src/ui/controls.tsx` |
| `src/ui/primitives.tsx` + `primitives.css` | `IconButton`, `Button` (primary/secondary/ghost), `Toolbar`, `ToolbarDivider`. The CSS is imported by the module, so you only import the TSX |
| `src/ui/Gallery.tsx` | Dev-only page that shows every icon with its name at 18 and 24px, plus a mock timeline toolbar, track header and all button states. Mount `<Gallery />` temporarily to check them |
| `src/ui/controls.tsx` | Builder A's controls (Section, Slider…), not part of this kit. It uses `./Icon` and `theme.css` classes (`.btn`, `.icon-btn`) |

## Icons

```tsx
import { Icons, Icon, type IconName } from '../ui/icons';

<Icons.Split />                       // 18px, 1.5px stroke, currentColor
<Icons.Play size={24} />
<Icons.Keyframe size={12} weight={1.25} />
<Icon name="Trash" />                 // by typed name
<Icons.Search title="Search" />       // title = accessible label; without it the icon is aria-hidden
```

- 24×24 grid, round caps and joins, `fill="none"`, `stroke="currentColor"`. **Colour comes from CSS `color`**, so active (cyan) and disabled (grey) are set on the parent.
- `weight` is the stroke in *screen* px (default 1.5) and is corrected for size, so a 12px icon is not hairline-thin and a 32px one is not heavy.
- Any other SVG prop (`className`, `style`, `onClick`) passes through. Every icon has class `oe-icon` (`display:block`).

### Names

| Group | Names |
|---|---|
| Library tabs | `Media` `Audio` `Text` `Stickers` `Effects` `Transitions` `Captions` `Filters` `Adjustment` `Templates` |
| Timeline toolbar | `Select` (alias `Pointer`) `Undo` `Redo` `Split` `DeleteLeft` `DeleteRight` `Trash` (alias `Delete`) `Marker` `Crop` `Mirror` `Rotate` `Freeze` |
| Timeline right side | `Mic` `Magnet` (alias `Snap`) `Link` `Unlink` `PreviewAxis` `ZoomOut` `ZoomIn` `ZoomFit` |
| Track headers | `VideoTrack` `AudioTrack` `TextTrack` `Lock` `Unlock` `Eye` `EyeOff` `Volume` `VolumeMute` `More` |
| Player | `Play` `Pause` (both filled) `SkipBack` `SkipForward` `Fullscreen` `ExitFullscreen` `Ratio` `Fit` |
| Inspector / generic | `Reset` `Keyframe` `KeyframeFilled` `ChevronLeft/Right/Up/Down` `CaretDown` `CaretUp` (small filled ▾ for section headers) `Plus` `Minus` `Close` `Search` `Grid` `List` `Sort` `Filter` `Import` `Export` `Check` `Settings` `Record` `Menu` `Image` `Speed` |

Kebab-case equivalents (`Icon.tsx`): `delete-left`, `zoom-fit`, `keyframe-filled`, `chevron-down`, `video-track`… plus `x` → Close.

## IconButton

```tsx
import { IconButton, Toolbar, ToolbarDivider } from '../ui/primitives';

<Toolbar label="Timeline tools">
  <IconButton icon={Icons.Split} label="Split (Ctrl+B)" onClick={split} disabled={!canSplit} />
  <ToolbarDivider />
  <IconButton icon={Icons.Magnet} label="Snap (N)" active={snapOn} onClick={toggleSnap} />
  <IconButton icon={Icons.Select} label="Select (A)" caret />   // ▾ corner mark = has a dropdown
  <IconButton icon={Icons.Plus} label="Add" dot />              // cyan badge dot
</Toolbar>
```

- `label` is required: it becomes the tooltip (native `title`) and `aria-label`. Put the shortcut in it.
- `active` makes it cyan and sets `aria-pressed`. `disabled` greys it out.
- `box`: `'sm'` 24px (track headers, use `size={16}`), `'md'` 28px (toolbars, default), `'lg'` 36px (player transport).
- Forwards `ref` and every `<button>` attribute; `type="button"` by default.

## Button

```tsx
import { Button } from '../ui/primitives';

<Button variant="primary" icon={Icons.Export} onClick={openExport}>Export</Button>   // cyan, like CapCut
<Button variant="secondary" icon={Icons.Import}>Import</Button>                      // raised grey (default)
<Button variant="ghost" size="sm">Apply to all</Button>                              // text only
```

`size`: `sm` 24px, `md` 28px (default), `lg` 34px. `block` = full width.

## Theme variables used

All from `src/theme.css`, each with a matching fallback: `--accent` `--accent-hover` `--accent-dim`
`--text` `--text-dim` `--text-faint` `--text-on-accent` `--bg-window` `--bg-panel` `--bg-raised`
`--bg-hover` `--bg-active` `--border-strong` `--font`.

Note: `theme.css` also has its own `.btn` / `.icon-btn` classes (used by `controls.tsx`). The kit's
classes are prefixed `oe-` so the two do not collide; they look the same.

## Checked

`tsc --strict --noUnusedLocals --noUnusedParameters --noUncheckedIndexedAccess --isolatedModules` on `src/ui/*.tsx` passes (including `controls.tsx`).
