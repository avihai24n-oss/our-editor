# e2e test-id contract

Builders: put these `data-testid` attributes on the elements below. The e2e suite (`e2e/`) finds
the app through them; renaming one breaks QA. Ids are kebab-case and stable — do not localise or
generate them. Add new ids here before you use them in a test.

## Required now (smoke test fails without them)

| data-testid | Element |
|---|---|
| `left-panel` | the left media/library panel (root element of the panel) |
| `player` | the preview/player region (root element) |
| `inspector` | the right-hand inspector/properties panel (root element) |
| `timeline` | the timeline region (root element, includes tracks) |
| `export-button` | the top-bar **Export** button that opens the export flow |

## Required for the QA flows

| data-testid | Extra attributes | Element |
|---|---|---|
| `media-import-input` | — | the `<input type="file" multiple>` that imports media (may be visually hidden, must stay in the DOM) |
| `media-asset` | `data-asset-name="<original file name>"`, `data-asset-kind="video\|audio\|image"` | one tile in the media library; must be the draggable element |
| `timeline-track` | `data-track-index="<0-based, top to bottom as rendered>"`, `data-track-kind="video\|audio\|text\|..."` | one track row / drop zone |
| `timeline-clip` | `data-clip-id`, `data-clip-name="<asset name>"`, `data-selected="true\|false"` | one clip on the timeline |
| `play-button` | `aria-label="Play"` / `"Pause"` | player play/pause toggle |
| `timecode` | — | current-time readout; text `HH:MM:SS:FF` (or `current / total`) |
| `playhead` | — | the timeline playhead |
| `export-dialog` | — | the export modal |
| `export-confirm` | — | the final Export button inside the modal (triggers the browser download) |

## Extra ids (added by the builders, applied by QA)

| Area | data-testid | Element |
|---|---|---|
| Library | `library-tab-<id>` | a library tab (`media`, `audio`, `text`, `transitions`, `filters`, `adjustment`, …) |
| Library | `text-preset`, `transition-preset`, `filter-preset`, `adjust-preset` | one preset tile |
| Inspector | `inspector-<project\|video\|image\|audio\|text\|transition\|multi>` | the inspector body for that selection |
| Inspector | `section-<id>` | one collapsible section (`blend`, `adjust`, `filter`, …) |
| Inspector | `text-content`, `duration-input`, `scale-row`, `opacity-row`, `volume-row`, `speed-row`, `filter-intensity`, `adjust-<key>` | fields / slider rows |
| Player | `player-canvas` | the preview `<canvas>` |
| Player | `player-selection` | on-canvas selection box |
| Player | `player-ratio`, `player-ratio-menu`, `player-zoom`, `player-fullscreen` | header controls |
| Export | `export-name`, `export-resolution`, `export-fps`, `export-progress`, `export-cancel` | export form / progress |
| Timeline | `timeline-ruler`, `timeline-marker`, `timeline-transition` (`data-transition-id`) | ruler, a marker, a transition on a cut |
| Timeline | `timeline-tool-menu`, `timeline-undo`, `timeline-redo`, `timeline-split`, `timeline-delete`, `timeline-magnet`, `timeline-snapping`, `timeline-zoom`, `timeline-fit` | toolbar buttons |
| Timeline | `track-lock`, `track-hide`, `track-mute` | track header toggles |

`timeline-track` also carries `data-track-role="main|overlay|audio|text"` and `data-track-id`;
`data-track-kind` is `video` for both main and overlay tracks. `timeline-clip` also carries
`data-clip-type`.

## Rules

- `media-import-input` fallback: if absent, tests use the first `input[type=file]` inside `left-panel`.
- Drag and drop: either native HTML5 DnD or pointer events work — the helper tries both.
- Export must end in a real browser download: a blob URL on an `<a download>` click. A
  `showSaveFilePicker` (File System Access API) save is invisible to Playwright, so if it is offered
  it must not be the only path.
- No `console.error` and no uncaught exceptions on a clean load — the smoke test asserts it.
