# Library + Inspector (builder A) — integration notes

Everything below lives in `src/panels/**` and `src/inspector/**`. No frozen file was edited.

## Contracts other builders can use
- **Drag payload** (`src/panels/libraryLogic.ts`): every library drag sets
  `application/x-our-editor` = JSON `{kind:'asset',assetId}` | `{kind:'text',preset?}` |
  `{kind:'transition',type}`, plus `application/x-our-editor-asset` = bare asset id for asset
  drags, plus `text/plain`. `parseDragPayload(raw)` validates a payload for the drop side.
- **Text presets on drop** (timeline B): a text drag carries `preset` (an id from
  `TEXT_PRESETS` in `src/panels/presets.ts`). Call
  `addTextPreset(textPreset(id) ?? TEXT_PRESETS[0], { at, trackId })` from `src/panels/TextTab.tsx`
  to add the styled clip as one undo step; plain `addTextClip({at})` also works (unstyled).
- **Thumbnails**: `getVideoThumb(asset)` / `useAssetThumb(asset)` in `src/panels/thumbnails.ts`
  (poster frame per video asset, cached, one decode at a time). The spec placed this in
  `src/media/thumbnails.ts`; the task limited me to panels/inspector. QA may move it.
- **Inspector controls** (`src/inspector/controls/`): `SliderRow`, `NumberBox`, `Section`,
  `SegmentedTabs`, `Toggle`/`ToggleRow`, `ColorInput`, `KeyframeButton`, `RotationDial`, and the
  undo helpers `startPointerGesture()` (one drag = one undo step, Escape cancels) and
  `beginSession()/endSession()` (typing / colour picker = one undo step).
- `src/ui/controls.tsx` was left unchanged (only `Tabs` is used from it).
- e2e ids added: `media-import-input`, `media-asset` (+ `data-asset-name`, `data-asset-kind`,
  `data-asset-id`), `library-tab-<id>`, `inspector-<project|video|image|audio|text|transition|multi>`,
  `text-preset`, `transition-preset`, `filter-preset`, `adjust-preset`, `section-<id>`, `text-content`,
  `duration-input`, plus a few slider rows (`scale-row`, `opacity-row`, `volume-row`, `speed-row`, …).

## Requests

## Enable flags for the Blend and Adjust sections — **Applied**
> QA: `blendEnabled` / `adjustEnabled` on VisualFields (default true, migrated on load via `migrateProject`); frameState ignores blend+opacity / adjust when false; both sections now have the checkbox.
- File: src/model/types.ts (VisualFields), src/engine/frameState.ts
- Need: `blendEnabled: boolean` and `adjustEnabled: boolean` (default true) on visual clips; the
  renderer ignores blend/opacity or adjust when false.
- Why: CapCut's section checkbox turns a section off without losing its values.
- Workaround in place: Blend and Adjust sections have no checkbox (only ↺ reset). Audio › Basic
  uses its checkbox as `audio.muted`; Filter uses it as `filter !== null`; Stroke / Background /
  Shadow use their `enabled` fields.

## Non-uniform scale — **Applied**
> QA: Deferred to v2 — it touches render geometry, hit-testing and the on-canvas handles; Uniform scale stays on/disabled.
- File: src/model/types.ts (Transform)
- Need: `scaleX` / `scaleY` (or `scaleY` alongside `scale`) for "Uniform scale" off.
- Workaround in place: the Uniform scale switch is shown on and disabled ("coming soon").

## Real audio waveforms — **Applied**
> QA: Audio tiles now draw real peaks from `src/timeline/media/waveform.ts` (shared cache with the timeline), seeded stand-in only while decoding.
- File: new `src/media/waveform.ts` (peaks from `AudioContext.decodeAudioData`, cached per asset)
- Why: media-bin audio tiles and timeline audio clips.
- Workaround in place: audio tiles draw a deterministic pseudo-waveform (`waveformBars(id)`).

## Adjustment layer clip (v2)
- The Adjustment tab currently applies adjust presets to the selected clip(s) (Reset tile clears
  them). A real CapCut adjustment *layer* needs a new track/clip kind — deferred.

## Notes for QA
- SPEC said keyframe diamonds are hidden in v1; the build task asked for a disabled ◇ with the
  tooltip "Keyframes — coming soon", so they are shown disabled.
- SPEC lists Adjustment as "Coming soon"; the task asked for it, so it is live (presets only).
- Text clips also get an **Adjust** tab (filters/adjust are drawn for text ops by frameState).
- Transition preview keyframes (`tp-*`) live in `src/panels/library.css` and are reused by the
  inspector's Transition panel (both stylesheets load with the app shell).
- UI preferences (library tab, grid/list, sort, collapsed sections, inspector tab per clip type) are
  stored in localStorage under `our-editor:ui:*`, all guarded with try/catch.
- No npm packages needed.
