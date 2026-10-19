# Functional audit — Library (left panel), media pipeline, persistence

Date: 2026-10-19. Branch `agent/qa-library`.

The question was whether each control **does** what it shows, not only whether it is drawn. Every
row below is checked by an automated test that reads the real effect:

- **store**: `window.__oe` (the dev-only Zustand handle), assets, clips, tracks, transitions, history;
- **IndexedDB**: the `blobs` store of the `our-editor` database (keys listed, one deleted on purpose);
- **timeline DOM**: `timeline-track[data-track-role]` / `timeline-clip` / `timeline-transition`;
- **pixels**: the player canvas read with `getImageData`, as a 16 × 16 grid of mean RGB values
  (768 numbers). "Changes the picture" means a mean absolute difference above a threshold, and
  every look is compared with every other look;
- **reload**: wait for the autosave, `page.reload()`, then check again.

Tests: `e2e/audit-library.spec.ts` (14 tests) with helpers in `e2e/audit-helpers.ts`, plus unit
tests in `src/store/assetLifecycle.test.ts` and `src/media/dropFiles.test.ts`. Run them with
`cd e2e && E2E_PORT=5150 npx playwright test audit-library.spec.ts --workers=1`.

Fixtures: `test-media/` plus three generated at test time in the OS temp folder: a 1080×1920
`testsrc2` PNG (a textured second picture for transitions and looks), a 64 KB garbage file named
`broken.mp4`, and `notes.txt`. The 60 s 1080×1920 clip `test-media/v-long-60s.mp4` already existed.
The helper regenerates it with ffmpeg if it is missing.

## Result

| | |
|---|---|
| Controls audited | 75 rows below |
| Pass as built | 66 (one of them hardened) |
| **Fixed** (bug found → root fix → regression test) | 9 rows, 8 distinct bugs |
| Still broken | 0. Two behaviours are noted at the end: they are by design or out of scope. |
| `e2e/audit-library.spec.ts` on the **old** code | 4 of 14 tests fail (locked main track; delete + undo; relink; the same file twice). With the Delete-key change also reverted, a 5th check fails. |
| `e2e/audit-library.spec.ts` on the new code | 14 / 14 pass |

## Bugs found and fixed

| # | What the user would see | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | **Delete a used asset, then ⌘Z: the clip came back with no media.** It was an orphan clip whose `assetId` pointed at nothing. The tile did not return, the blob had already been deleted from IndexedDB and the object URL revoked, so the media was gone for good. ⇧⌘Z then could not remove it again. | `removeAsset` removed the clips as an undo step, but it removed the asset *outside* history: it was stripped from every past/future snapshot and its blob and URL were freed at once. `undo()` also merged the current asset map into the restored snapshot (`withAssets`), so redo could never remove an asset. | Removing an asset is now **one undo step** that removes the asset and its clips together. ⌘Z brings both back with working media, and ⇧⌘Z removes both again. Imports and "Media lost" flags, which are not undo steps, are written into every snapshot instead (`patchAllDocs`), so `withAssets` is gone. The URL and blob are freed only when **no document or undo/redo snapshot** can reach the asset any more (`onAssetRemoved` now fires from a store subscription, `collectLiveAssets`). Thumbnails, posters and peaks are still freed as soon as the asset leaves the document. | e2e `Media: delete an asset…` (pixels after undo equal the pixels before the delete, no orphan clips, reload keeps both). Unit: `assetLifecycle.test.ts` › removeAsset is one undo step |
| 2 | Deleting an asset whose clip sat on a **locked** track left that clip behind with no media. | `ops.deleteClips` skips locked tracks. | New `ops.removeAssetClips`: a clip never outlives its media, so it is removed on locked tracks too, with its transitions. | Unit: `removes clips on a locked track too` |
| 3 | A deleted asset's blob stayed in IndexedDB forever when the tab was closed while ⌘Z could still reach it. This is a consequence of fix 1, so it is fixed here too. | No sweep. | `sweepOrphanBlobs()` runs at boot. It deletes blobs that no saved project and no live asset references, and skips blobs an import is still writing. | e2e: after reload, the blob keys equal the assets' keys. Unit: `sweepOrphanBlobs` |
| 4 | **Hover "+" (or double-click / Enter) with the main track locked still put the clip ON the locked track.** The "target track is locked" message in the UI never appeared. | `addClipFromAsset` → `insertOnMain` never checked `locked`. | `addClipFromAsset` returns `null` when the main track is locked. The Media tab already shows "Could not add — the target track is locked". The timeline drop uses the same op. | e2e `Media: hover "+"…` (last step). Unit: `locked main track` |
| 5 | **Importing the same file twice made two identical tiles.** Both pointed at one blob, so "Added" showed on only one of them and deleting either one was confusing. | No duplicate check (only the blob write was deduplicated). | `importFiles` recognises a file already in the bin by name + size. It does not import it again: the message says "*name* is already in the Media pool" and its tile is highlighted. A drop on the timeline still places the existing asset. Duplicates inside one batch are handled the same way. | e2e `Media: the same file twice…` (1 asset, 1 tile, 1 blob). Unit: `a file already in the bin is not imported again`, `importSummary` |
| 6 | **"Media lost" could not be repaired.** Re-importing the file added a second, healthy tile, and every clip stayed "Media lost". | No relink path. | Importing a file whose name and size match a lost asset **relinks** it: the file is stored under the asset's blob key and its URL registered, the flag is cleared in every snapshot, and every clip plays again. A file of the wrong kind is refused. The relink survives a reload. | e2e `Media: missing media…` (pixels after relink equal the original). Unit: relink + wrong kind + "a relinked asset stays found after undo" |
| 7 | A relinked or re-found asset showed "Media lost" again after ⌘Z. This is latent; it would have appeared with fix 6. | `setAssetsMissing` patched only the current document. | It patches every snapshot (`patchAllDocs`). | Unit: `a relinked asset stays found after undo` |
| 8 | **Delete / Backspace with a media tile focused deleted the selected TIMELINE clip**, not the media. | The tile did not handle the key, so the window shortcut ran. | The focused tile handles Delete / Backspace (remove from the project, with the same confirmation when it is used) and Enter (add), and calls `preventDefault()` so the timeline shortcut does not also run. | e2e `Media: delete…` (last step: the beeps asset goes, the selected video clip stays) |

## Audit table

Legend: **pass** = worked as built and is now covered by a test. **fixed** = see the bug table.

### Media tab

| Control | Expected effect | Result | Evidence (test → assertion) |
|---|---|---|---|
| Empty state | "Import videos, images or audio…" and an Import button | pass | `Import button…` → `.lib-empty` text |
| **Import** button | opens the OS file chooser | pass | `Import button…` → `filechooser` event from `.lib__import` |
| Multi-file import (6 files: 3 video, 1 image, 2 audio) | 6 assets in insertion order; flash "Imported 6 files" | pass | store names in order; `.lib-flash` |
| Probe | kind, duration (±0.1 s), width/height, `hasAudio` (the silent mp4 → false) | pass | store fields per asset |
| Duration badge | `00:05` / `00:06`; no badge on images | pass | `.atile__dur` |
| Thumbnails | every video tile shows a decoded poster, and the image tile shows its picture | pass | `img.atile__img` `naturalWidth > 0` |
| Audio waveform | real decoded peaks, not the seeded stand-in | pass | the constant tone's bars are all > 0.85; the beeps have ≥ 2 bars ≤ 0.1 (silences) and one > 0.95 |
| Stored blobs | one IndexedDB blob per file | pass | `blobKeys().length === 6` |
| Reload | the same assets in the same order, none lost, posters and real waveforms again | pass | after `reload()` |
| Search | case-insensitive substring ("LAND", ".png"); "Results for “…”"; "No matching media"; Esc clears and closes | pass | `Media: search…` → tile names |
| Sort | Name (A→Z), Duration (longest first), Type (video, image, audio), Date added | pass | tile order for each |
| Categories | All / Videos / Images / Audio filter the grid; "Library" disabled | pass | tile names; `toBeDisabled` |
| Grid / list toggle | `.lib-grid` ↔ `.lib-list`; list rows show the kind and duration ("—" for images) | pass | DOM |
| View prefs | list view + Name sort survive a reload | pass | after reload |
| "Added" badge | only on assets used on the timeline; disappears when its last clip is deleted | pass | `.atile__added` counts 1 → 5 → 4 |
| Hover "+" video | main track, at the playhead's nearest cut | pass | clip `trackKind: main`, `start: 0`; DOM row `main` |
| Hover "+" audio | an audio track, starting exactly at the playhead (2 s) | pass | `trackKind: audio`, `start: 2 000 000` |
| Hover "+" image, playhead past the clip's middle | main track, after the clip (nearest-cut rule) | pass | `start = previous clip's end` |
| Double-click / Enter on a tile | adds like "+" | pass | clip counts |
| Enter on a focused tile | adds, and does not also run a window shortcut | pass (hardened) | no toast. The old code did not show one either; `preventDefault` was added anyway |
| "+" with the main track locked | nothing added, "…target track is locked" | **fixed** (#4) | clip count unchanged; `.lib-flash` |
| Drag tile → audio track | lands on that audio track | pass | `dragTo` audio row → `trackKind: audio` |
| Drag audio tile → main track | never lands on the main track (goes to an audio track) | pass | no audio clip on main |
| Drag video tile → main track | lands on the main track | pass | main-track count +1 |
| OS drop on the Media panel | imported, nothing placed on the timeline, drop default-prevented | pass | `Media: drag-and-drop…` → tile, 0 clips, 1 blob |
| OS drop anywhere on the window / timeline | import (and place on the timeline) | pass | existing `e2e/file-drop.spec.ts` (player, inspector, top bar, tab bar, timeline) |
| Right-click → Delete, unused asset | removed at once, no confirmation | pass | tile gone, 0 dialogs |
| Delete a used asset → Cancel | nothing changes | pass | tile and 2 clips stay |
| Delete a used asset → OK | asset and its clips removed; the main track closes the gap; the preview no longer shows it | pass | store, DOM, pixels change |
| ⌘Z after deleting a used asset | the asset **and** its clip return, with media | **fixed** (#1) | tile visible, 0 orphan clips, poster loads, pixels = before the delete (diff < 2) |
| ⇧⌘Z | removes both again | **fixed** (#1) | tile gone, 1 clip |
| Reload after delete + undo | both still there, nothing lost | **fixed** (#1) | after reload |
| Reload after a saved delete | the blob is gone from IndexedDB | **fixed** (#3) | blob keys = live assets' keys only |
| Delete a used asset that has a clip on a locked track | no clip left without media | **fixed** (#2) | unit test |
| Delete / Backspace on a focused tile | deletes that media, not the timeline selection | **fixed** (#8) | beeps tile gone, selected video clip kept |
| Missing media (blob deleted, then reload) | asset `missing`; tile "Media lost", not draggable, no "+"; clip "Media lost"; Inspector notice; preview draws the red placeholder (as the export does); double-click does nothing | pass | store, DOM, `countPixels(red) > 1000` |
| Re-import the lost file | relinks the same asset: no duplicate, clip plays (pixels = original), survives a reload | **fixed** (#6, #7) | `Media: missing media…` |
| The same file twice | one asset, one tile, one blob; "…is already in the Media pool" | **fixed** (#5) | `Media: the same file twice…` |
| Unsupported type (`notes.txt`) through Import | refused with an error naming the file; nothing stored | pass | `.lib-flash--error`, asset and blob counts |
| Corrupt `broken.mp4` | refused ("Cannot read broken.mp4"); nothing stored | pass | same |
| Mixed batch (txt + mp3 + broken) | the mp3 is imported; "2 files could not be imported…" | pass | assets = vertical + tone |
| 60 s 1080×1920 file | probed 60 s, 1080×1920, with audio; badge `01:00`; poster; clip 60 s; the frame at 45 s decodes and differs from 5 s; survives a reload | pass | `Media: a 60 s…` |

### Audio tab

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| List | only the audio assets of the bin | pass | tile names = tone, beeps |
| Import filter | `accept="audio/*"` | pass | attribute |
| Waveforms | real peaks | pass | same bar checks as Media |
| "+" | audio clip on an audio track; "Added" | pass | store + badge |
| Non-audio file picked anyway | goes to the Media pool, not this list | pass | 4 assets, the list still shows 2 |
| Sound effects | "Sound effects" coming-soon card; Music disabled | pass | `.lib-soon`, `toBeDisabled` |

### Text tab

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| 10 presets (Default, Title, Subtitle, Outline, Caption, Shadow, Neon, Label, Serif, Typewriter) | click adds ONE text clip on a text track, with the preset's content and style, as one undo step | pass | store `text` matches the preset (font, size, colours, stroke / background / shadow); `past.length + 1`; DOM text row |
| Each preset renders | pixels appear over the blank frame; each preset looks different from every other | pass | `sigDiff > 0.1` vs blank, > 0.2 between every pair (45 pairs); bright pixels > 100 |
| Style in pixels | Caption yellow, Neon cyan, Label's white box | pass | `countPixels` per colour; Label white > 2 × Default's |
| "+" | adds at the playhead (2 s) | pass | `start = 2 000 000`, colour `#7df9ff` |
| Drag a preset to the timeline | lands with its style | pass | 2 Neon clips |
| Templates / Effects sidebar | disabled | pass | `toBeDisabled` |

### Transitions tab

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| 11 transitions listed | Mix, Black Fade, White Flash, Blur, Zoom, Slide ×4, Wipe ×2 | pass | labels |
| Target: first clip selected | the cut after it (A→B) | pass | `fromClipId A, toClipId B` for all 11 |
| Target: last clip selected | the cut before it (B→C) | pass | store |
| Target: nothing selected | the main-track cut nearest the playhead | pass | store |
| Each transition renders | the mid-transition frame differs from clip A, from clip B and from every other transition | pass | `sigDiff > 2` vs A and B, `> 1` for every pair (55 pairs) |
| Feedback | the Transition inspector opens; the cut marker is drawn | pass | `inspector-transition`, `timeline-transition` |
| A selected transition + another tile | changes the type in place (same id) | pass | store |
| Drag a tile onto a cut | that cut gets it | pass | Slide Up on B→C |
| No cut | "Select a clip that touches another clip…" | pass | `.lib-flash` |

### Filters tab

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| No selection | "Select a video, image or text clip first"; nothing changes | pass | flash, `filter: null` |
| Tile previews | show the selected clip's own picture | pass | `.look img[src^=blob:]` with a selection, none without |
| 10 filters | set `clip.filter`, highlight the tile, change the pixels; all different | pass | store, `.is-active`, `sigDiff > 1` vs base, `> 0.5` for every pair |
| B&W | really greyscale | pass | < 50 pixels with R≠G≠B |
| None | clears it and the original pixels return | pass | `sigDiff < 0.5` vs base |
| Reload | the filter and its pixels survive | pass | Sepia after reload = before |

### Adjustment tab

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| 11 presets | set `clip.adjust` to the preset, highlight it, change the pixels | pass | store values, `.is-active`, `sigDiff > 0.5` |
| Direction | Brighten raises the mean, Darken lowers it, Vignette darkens the corners | pass | `sigMean`, corner cell |
| Reset | all values 0, the original pixels | pass | store, `sigDiff < 0.5` |
| "Adjustment layer" | disabled | pass | `toBeDisabled` |

### Coming soon and tab state

| Control | Expected effect | Result | Evidence |
|---|---|---|---|
| Stickers / Effects / Captions / Templates | a centred card (icon, title, "…coming in a later version"); no grid or tiles; tooltip "— coming soon"; no edit, no console error | pass | `.lib-soon__title`, zero tiles, `past.length === 0`; screenshot `audit-03-coming-soon` |
| Active tab | remembered across a reload | pass | Templates still selected |

## Noted, not changed

- **Duplicates are recognised by file name + size.** Two different files with the same name and the
  same size in bytes would be treated as one. This is very unlikely for real footage. The browser
  gives no path or hash cheaply; hashing a 1.5 GB file at import would cost more than it saves.
- **Importing a video from the Audio tab** puts it in the Media pool. The Audio tab only lists audio,
  so the flash "Imported 1 file" is shown with no new tile there. This is correct but could be
  clearer; the message could say "(in Media)".
- **Deleting a used asset** asks with the browser's `window.confirm`. It works, but it is not
  CapCut-styled.

## Files

- `src/store/index.ts`: `patchAllDocs`; undoable `removeAsset`; `importFiles` handles duplicates
  and relinks (new `ImportResult`); `setAssetsMissing` patches history; `withAssets` removed;
  `liveAssets()` + `onAssetRemoved` fire when nothing can reach the asset.
- `src/store/ops.ts`: `removeAssetClips`; `addClipFromAsset` refuses a locked main track.
- `src/store/persistence.ts`: `listBlobKeys`, `referencedBlobKeys`.
- `src/store/autosave.ts`: `sweepOrphanBlobs()` at boot.
- `src/media/import.ts`: `relinkMedia`, `blobsBeingWritten`.
- `src/media/cleanup.ts`: caches freed when the asset leaves the document; URL + blob when it
  leaves history.
- `src/media/dropFiles.ts`, `src/media/dropImport.ts`, `src/panels/MediaTab.tsx`: the
  `importSummary` messages (imported / already in the pool / relinked) and the highlight of
  existing tiles.
- `src/panels/AssetTile.tsx`: Enter / Delete / Backspace handled by the focused tile.
- Tests: `e2e/audit-library.spec.ts`, `e2e/audit-helpers.ts`, `src/store/assetLifecycle.test.ts`,
  `src/media/dropFiles.test.ts` (+ `importSummary`), `src/store/integration.test.ts` (the
  `onAssetRemoved` contract updated).
