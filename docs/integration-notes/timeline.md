# Timeline (builder B) — integration notes

Everything lives in `src/timeline/**`. The public entry is still `<Timeline />` (no props), mounted by
App inside the `timeline` section. It mounts the global keyboard shortcuts.

## Contracts other areas rely on

### Library → timeline drag (HTML5 DnD)
The whole timeline (toolbar, ruler, headers and tracks) is a drop target. Accepted:

| dataTransfer type | data | result |
|---|---|---|
| `application/x-our-editor` (SPEC) | `{"kind":"asset","assetId":"…"}` | `addClip(assetId, …)` at the drop time on the hovered track if it accepts the asset, else the default track (video/image → main, audio → free audio track). The empty band **above** the top track → new overlay track. |
| `application/x-our-editor` | `{"kind":"text"}` | `addTextClip({at, trackId})` (hovered text track, else a free text track) |
| `application/x-our-editor` | `{"kind":"transition","type":"mix"}` | `addTransition` on the nearest cut (≤ 40 px) of the hovered visual track, else of the main track |
| `application/x-our-editor-asset` | the bare asset id (or the same JSON) | same as `kind:'asset'` |
| `Files` (OS drag) | files | `importFiles`, then each new asset placed one after another from the drop time |

The drop time snaps to playhead / clip edges / markers (8 px) unless Alt is held. A drop over the
track-header column lands at 0. Parsing lives in `src/timeline/dnd.ts` (`DND_MIME`, `DND_ASSET_MIME`, `readPayload`).

### Keyboard (global, owned here — `src/timeline/shortcuts.ts`)
Space play/pause · ⌘/Ctrl+B split · Q / W delete left/right · ⌫/Delete delete · ⌘Z / ⇧⌘Z (and ⌘Y) undo/redo ·
⌘C / ⌘V copy / paste at playhead · ⌘D duplicate · ⌘A select all · ←/→ frame (⇧ = 10 frames) · ↑/↓ prev/next edit ·
Home/End · ⌘= / ⌘− and plain + / − zoom · ⇧Z fit · M marker · A select tool · B split (blade) tool · P magnet ·
N snapping · S preview axis · V enable/disable clip · Esc cancels a drag/trim, then leaves split mode, then clears the selection.
Ignored while typing in text/number fields. Letters match the physical key (`event.code`), so they work with
the Hebrew layout too. ⌘E stays in App.
**Player (C): do not bind Space yourself** — it would toggle twice.

### e2e test ids added by the timeline
Required ones: `timeline-track` (`data-track-index`, `data-track-kind` = `video` for main/overlay, `audio`, `text`;
plus `data-track-role` = `main|overlay|audio|text` and `data-track-id`), `timeline-clip` (`data-clip-id`,
`data-clip-name`, `data-clip-type`, `data-selected`), `playhead` (the draggable head on the ruler).
Extra: `timeline-ruler`, `timeline-marker`, `timeline-transition` (`data-transition-id`), `timeline-tool-menu`,
`timeline-undo`, `timeline-redo`, `timeline-split`, `timeline-delete`, `timeline-magnet`, `timeline-snapping`,
`timeline-zoom` (range input), `timeline-fit`, `track-lock`, `track-hide`, `track-mute`.
QA: please add the extra ones to `e2e-testids.md` if tests start using them.

### Media helpers (generic, reusable by the library)
- `src/timeline/media/thumbnails.ts` — `getThumb(assetId, url, timeSec, heightPx)` → object URL of a JPEG frame
  (one hidden `<video>` per asset, LIFO queue, LRU 1500 frames), `peekThumb`, `forgetThumbs(assetId)`.
- `src/timeline/media/waveform.ts` — `getPeaks(assetId, url)` → `{data, pps, duration}` (decoded once per asset
  via OfflineAudioContext at 8 kHz, 200 peaks/s), `peaksReady`, `forgetPeaks(assetId)`.
- `src/timeline/media/peaks.ts` — pure maths (`computePeaks`, `peakAt`, `normGain`, `thumbStep`, `quantizeTime`, `tileRange`).
- `src/timeline/media/useAssetUrl.ts` — hook over `media/registry.ts`.

## Requests for the frozen files

## Preview axis needs a store field — **Applied**
> QA: `previewTime` + `setPreviewTime`; `uiStore.setHoverTime` forwards; PreviewEngine renders `previewTime ?? playhead` while paused.
- File: src/store/index.ts
- Need: `previewTime: Us | null` (not undoable/persisted) + `setPreviewTime(t: Us | null)`. The player shows
  that frame instead of the playhead frame while it is non-null.
- Why: CapCut "Preview axis" (S): hovering the timeline previews that frame without moving the playhead.
- Workaround in place: the hover time lives in `useTimelineUi().hoverTime` (`src/timeline/uiStore.ts`); the
  timeline draws the dashed hover line + time label, but the player does not follow it yet. Once the field
  exists, `uiStore.setHoverTime` will forward to it (one line).

## Multi-clip drag — **Applied**
> QA: `moveClips(ids, deltaUs, trackDelta)`; a drag of a clip inside a multi-selection moves the whole selection (ghost still shows only the grabbed clip).
- File: src/store/index.ts / ops.ts
- Need: `moveClips(ids: Id[], deltaUs: Us, trackDelta?: number): boolean` — moves a selection together
  (same placement rules per track).
- Why: dragging a multi-selection (CapCut moves all selected clips).
- Workaround in place: a drag moves only the clip under the pointer; the selection is kept.

## Cut / paste after delete — **Applied**
> QA: `insertClips(clips, at)`; the clipboard now holds clip snapshots; ⌘X bound.
- File: src/store/index.ts
- Need: `insertClips(clips: Clip[], at: Us)` (re-id'd copies of clip snapshots, placed like `addClip`).
- Why: ⌘X then ⌘V, and ⌘V after the source clips were deleted or the project changed.
- Workaround in place: the clipboard holds ids; ⌘V = duplicate + move to the playhead (one tx). ⌘X not bound.

## New track next to the drop row — **Applied**
> QA: store side done: `moveClip(id, {start, trackId, newTrack:'above'|'below'})`. The timeline UI has no between-rows drop zone yet (v2).
- File: src/store/ops.ts (`moveClip`)
- Need: optional `to.newTrack: 'above' | 'below'` relative to `to.trackId`, so a clip dragged into the gap
  between two tracks gets a new track exactly there.
- Why: CapCut inserts a track between existing ones.
- Workaround in place: only the empty bands above the top track / below the bottom track create tracks
  (`addTrack(kind)` then `moveClip`, inside one tx).

## Forget cached frames when an asset is removed — **Applied**
> QA: `onAssetRemoved` hook in the store; `src/media/cleanup.ts` frees thumbs, peaks, the object URL and the blob.
- File: src/store/index.ts (`removeAsset`) or the library (A)
- Need: call `forgetThumbs(assetId)` and `forgetPeaks(assetId)` from `src/timeline/media/*` when an asset is removed.
- Why: frees the hidden `<video>` and cached JPEG URLs.

## Optional token — **Applied**
> QA: `--clip-ghost-{video,image,audio,text}` in theme.css, used by timeline.css.
- File: src/theme.css
- Need: `--clip-ghost-alpha` or ghost colours. Workaround: rgba literals in `src/timeline/timeline.css`.

No npm packages needed.

## Not in v1 (deliberately left out)
Right-click context menu, select-left/right `[`/`]`, split all tracks ⇧⌘B (⌘B already splits every clip under the
playhead when nothing is selected), keyframe diamonds, Cover picker (tile shown, disabled), track ⋯ menu,
volume line on audio clips, video-clip waveform strip, auto-scroll while dragging near the edge, linkage behaviour
(toggle only — no linked items exist in v1), Ctrl/Cmd hold to bypass snapping (Alt bypasses).
