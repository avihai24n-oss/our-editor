# Integration notes — C: Player + Render + Export

Files owned: `src/player/**`, `src/engine/render/**`, `src/export/**`. Nothing outside them was edited.

## Use Mediabunny, not `mp4-muxer` (no new dependency)
- File: package.json
- Need: nothing. The brief asked for `mp4-muxer`; MP4 muxing is done with **Mediabunny 1.61.6**
  (already installed, same author, successor of mp4-muxer), the spike-verified recipe in
  `docs/research/04-export-spike.md` (`src/export/exportMp4.ts`).
- Why: one fewer dependency, and the AAC priming / edit-list fix is verified with it.
- Workaround in place: n/a.

## 3:4 ratio in the Ratio menu — **Applied**
> QA: added to `AspectRatio` and `ASPECTS` (1080×1440).
- File: src/model/types.ts (`AspectRatio`), src/model/catalog.ts (`ASPECTS`)
- Need: add `'3:4'` → `{ id: '3:4', label: '3:4', width: 1080, height: 1440 }`.
- Why: the brief lists 9:16, 16:9, 1:1, 4:5, 3:4 for the player's Ratio menu.
- Workaround in place: the menu renders `ASPECTS`, so 3:4 appears automatically once added.

## favicon 404 breaks the "no console.error on load" smoke rule — **Applied**
> QA: `<link rel="icon" href="data:," />` in index.html.
- File: index.html
- Need: `<link rel="icon" href="data:," />` (or a real icon).
- Why: headless Chromium logs `Failed to load resource: 404 /favicon.ico` as a console error.

## Export frame rates 50 fps
- File: src/model/types.ts (`Fps`)
- Need (optional): `Fps` is `24|25|30|60`. Export offers 24/25/30/50/60 as an export-only option
  (`src/export/settings.ts`), independent of the project fps, so no model change is required.

## New data-testids (please add to e2e-testids.md) — **Applied**
> QA: listed in e2e-testids.md.
| id | element |
|---|---|
| `player-canvas` | the preview `<canvas>` (was a div in the placeholder) |
| `player-selection` | on-canvas selection box of the selected clip |
| `player-ratio`, `player-ratio-menu` | Ratio button / its menu |
| `player-zoom`, `player-fullscreen` | zoom (Fit / %) button, fullscreen button |
| `export-name`, `export-resolution`, `export-fps` | export form fields |
| `export-progress`, `export-cancel` | progress block and Cancel while exporting |

Existing ids honoured: `play-button` (`aria-label` Play/Pause), `timecode` (`current / total`),
`export-dialog`, `export-confirm` (ends in an `<a download>` click).

## Notes for the other builders
- **Timeline (B):** while playing the player writes `setPlayhead` ~30×/s; any other playhead
  change while playing (scrub) re-anchors the clock — no extra API. Space is still B's shortcut;
  the player only handles Escape during an on-canvas drag (cancelTx).
- **Inspector (A):** on-canvas move/scale/rotate write `updateClip(id, { transform })` inside
  `beginTx/commitTx`, so the Transform sliders update live.
- **Known v1 limits:** pitch-preserved speed is preview-only (the export mix changes pitch with
  speed — time-stretch is v2); Highlights/Shadows/Sharpen are approximations (CSS filter), true
  tone curves need the v2 WebGL pass; the WebM fallback is real-time and its file has no
  duration header.
