# QA report — v1 integration

Date: 2026-10-18. Scope: the three parallel builds put together: Library + Inspector, Timeline, and
Player + Render + Export.

## Result

| Check | Result |
|---|---|
| `npm run typecheck` (strict) | clean |
| `npm test` (Vitest) | **211 / 211 pass** (16 files; 10 new integration tests in `src/store/integration.test.ts`) |
| `npm run build` | passes; the dev-only `window.__oe` handle is not in `dist/` |
| `e2e/smoke.spec.ts` | pass: four regions, Export button, WebCodecs available, no console errors |
| `e2e/flows.spec.ts` | pass: the full editing walk-through below, **no console errors** |
| Exported MP4 (ffprobe) | H.264 1080×1920 30 fps + AAC; duration 7.57 s = project duration (±0.2 s) |

Run: `cd e2e && E2E_PORT=5391 npx playwright test`. Screenshots of every step are in `e2e/screens/`.

## Keyboard shortcuts (CapCut parity) — 2026-10-18

Every binding from `docs/research/01-ui-ux.md` §6 that a browser allows now lives in ONE table,
`src/timeline/shortcutDefs.ts`. The keydown handler, the Keyboard shortcuts panel (keyboard icon
next to Export) and the toolbar / player / import tooltips are all generated from it.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **310 / 310 pass** (18 files). New: every row of the table resolves to its own command on Mac and Windows, no two rows share a combo, look-alike keys (B / ⌘B / ⇧B / ⇧⌘B, V / ⌘V, A / ⌘A, ⌘X / ⇧X / ⌥X, I / ⌘I, S / ⇧⌘S, ⇧Z / ⇧⌘Z / ⌥⇧Z) do not collide, Hebrew layout incl. mirrored brackets, Mac ⌥ characters, glyph / word formatting; store actions `splitAllAtPlayhead`, `selectSide`, `nudgeVolume`, `toggleExtractAudio` (span, mute, link, split, undo); in/out area; panel, toast, library-tab cycle and Speed › Curve components |
| `npm run build` | passes |
| `e2e/shortcuts.spec.ts` | pass: ⇧⌘B vs ⌘B, `[` `]`, I / O / ⌥X / ⇧X / Esc, typing guard, ⌘. ⌘, with undo, ⇧⌘S extract + restore, ⌘R (no reload) and ⇧B, the toast-only keys, ~, Tab / ⇧Tab, ⌘I file chooser, ⌥⇧Z, ⇧⌘F and ⌃⌘F full screen, synthetic Hebrew-layout keys, ⌘E, modal guard, the panel's five groups and the tooltips |
| `e2e/flows.spec.ts`, `e2e/smoke.spec.ts` | still pass |

Browser limits: ⌘N (new project) and ⌘Q (quit) are kept by the browser and are listed in the panel
as "Not in a browser". ⌃⌘F is also macOS's own window full-screen key. It passes in headless
Chromium; in a real macOS browser window the browser may take it first, so ⇧⌘F is the reliable one. Esc out of full screen is the browser's own.
The toast-only keys (group, compound, match cut, keyframes, split caption) are tagged "Coming soon"
in the panel.

## Timeline jumps / shaking, hover line, OS file drop — 2026-10-19

Measured in real Chromium (Playwright, workers = 1, real 8 px scrollbars turned back on with
`ignoreDefaultArgs: ['--hide-scrollbars']`), sampling every animation frame: scrollLeft / scrollTop,
scrollbar sizes, scroll and client sizes, timeline height, main-track Y, playhead / hover / blade x,
every clip's position. Each fix has a regression test that fails on the old code.

| # | What the user saw | When | Root cause | Fix |
|---|---|---|---|---|
| 1 | **The playhead follows / jumps with the mouse** | After a press on the ruler, the playhead head or a clip whose button was released outside the window (or over browser UI): no `pointerup` arrives | The gesture stayed open; every later `pointermove` kept scrubbing (or moving / trimming) with no button held. Measured: playhead 0 → 5.03 s on a bare mouse move | `pointermove` with `buttons === 0` ends the gesture as a release (`Timeline.tsx`) |
| 2 | No separate hover line; the player could show a stale frame | Hovering, then scrubbing | Preview axis was off by default and drawn as a grey dashed line over the tracks only. With it on, a scrub kept the old hover frame in the player (`previewTime` was not cleared when a gesture began) | CapCut model: amber line (`--hover-axis`) over ruler + tracks, on by default (S toggles); hovering only sets `hoverTime`, never the playhead; the player shows the hover frame while paused, the playhead frame when the pointer leaves; any gesture clears the hover; playback clears `previewTime` and hover never overrides it |
| 3 | **Timeline shakes while playing** | Scrolling sideways (trackpad / wheel) during playback | Auto-scroll ran on every playhead write and snapped the view back to the playhead each frame. Measured scrollLeft 150 → 0 → 150 → 0 … | A sideways scroll by the user while playing suspends following until the playhead is on screen again; programmatic scroll writes are told apart from the user's |
| 4 | **Timeline jumps a whole screen while playing** | Playback at any zoom where the edit is wider than the lane | `autoScroll` paged: at the right edge it jumped ~90 % of the lane (measured 0 → 1278 → 2570 px at 600 px/s) | `followScroll`: once the playhead passes 75 % of the lane the view glides with it (max step measured < 60 px per frame at 600 px/s, no reversals) |
| 5 | **Timeline slides away while trimming / after deleting the last clip** | Scrolled to the end, then trimming the last clip's right edge or deleting it | The lane width follows the edit length, so the browser clamped scrollLeft: a 400 px trim scrolled the view 400 px and the edge ended 400 px from the mouse; a delete jumped 800 px | `stableContentWidth`: the lane never shrinks under what is on screen; the spare room goes when the user scrolls back |
| 6 | **Tracks jump up / down** | Adding an audio track (main track moved up 26 px) or an overlay track (down 22 px) — also when a drop creates a track | The free space was re-split 55/45 between the bands on every change | `bandHeights`: the main track keeps its place; new tracks take room from their own band; the stack moves up only when it would otherwise not fit |
| 7 | One-frame flicker while zooming | ⌘ + scroll, slider, ⌘= / ⌘− | The anchored scrollLeft was written in a layout effect but the virtualisation window (`view`) caught up a frame later | Every programmatic scroll write syncs `view` in the same layout pass; hover / blade lines re-resolve on scroll |

**"Shakes after a click or after B":** with B active, the mouse still for 2 s, then a slow move
(3 px / 50 ms), then a blade click, at seven window sizes (1000×900 … 1920×1080), empty and with
clips, 3 and 6 tracks, real scrollbars: no value oscillated — no scrollbar toggling, no
ResizeObserver loop, no hover ↔ previewTime feedback, the blade line moves monotonically. The
oscillations that did exist are #1 (after a click whose release was lost, the playhead kept
following the mouse) and #3 (playback vs. a manual scroll). `e2e/timeline-stability.spec.ts` now
asserts zero changes / zero reversals for those 2 s.

Checked and not a problem: clicks on the ruler / clips / empty space do not scroll; zoom keeps the
anchor (mouse or playhead); autosave, selection and inspector changes do not change the timeline
height or scroll; undo restores without a jump; thumbnails do not reflow clips.

**OS file drop anywhere** (`src/ui/FileDropOverlay.tsx`, `src/media/dropFiles.ts`,
`src/media/dropImport.ts`): window listeners in the capture phase `preventDefault` every OS-file
`dragover` / `drop` (no navigation to the file, wherever it lands); a full-window dim with "Drop
files to import" appears only for drags whose types include `Files` and none of our internal MIME
types; a depth counter + `relatedTarget === null` + a 450 ms dragover watchdog keep it from
flickering or sticking. Drop on the timeline: unchanged (import + place at the drop point, the
overlay says so). Anywhere else: import to the Media pool through the store's `importFiles` (the
Import button's path), switch to the Media tab, highlight the new tiles for 1.6 s. Unsupported files
→ toast "Skipped N unsupported files: …". The Media tab's own drop handler and overlay were removed
so there is one import path.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **347 / 347 pass** (23 files). New: `followScroll`, `stableContentWidth`, `bandHeights` (geometry.test.ts); type filter, partition, internal-drag detection, skipped message (dropFiles.test.ts) |
| `npm run build` | passes |
| `e2e/timeline-stability.spec.ts` (new) | 6 / 6 pass; 5 of them fail on the previous code |
| `e2e/file-drop.spec.ts` (new) | 2 / 2 pass: DataTransfer drops on the player canvas (2 files), the inspector (+ 2 unsupported → toast), the top bar, the library tab bar, the timeline (import + place, once); overlay shown / hidden; internal drag shows no overlay; reload keeps the media |
| `smoke`, `flows`, `shortcuts`, `memory` | pass (run one at a time; peak Chromium RSS 1.6 GB) |

Screenshots: `e2e/screens/stability-before-*.png` / `stability-after-*.png` (hover and lost
pointerup, old vs new code), `stability-01…03`, `file-drop-01…03`.

## Flows verified in real Chromium (Playwright)

The test media in `test-media/` is:
- a 5 s 1080×1920 testsrc2 video with a 440 Hz tone;
- a 4 s 1920×1080 SMPTE-bars video with an 880 Hz tone;
- a PNG image;
- a 6 s MP3.

1. **Import** four files through the Import input. They appear as tiles with thumbnails and
   durations, and the audio tile shows its real waveform.
2. **Add clips:**
   - dragging the vertical video onto the main track;
   - the hover "+" on the landscape video, which inserts it at the playhead;
   - the "+" on the MP3, which puts it on a new audio track.
3. **Play/Pause** with the button. The playhead advances more than 0.6 s in 1.2 s. **Space** toggles
   exactly once, even while the Play button has focus.
4. **Scrub:** a click on the ruler at 2 s puts the timecode at `00:00:02:xx`.
5. **Split** with ⌘B on the selected clip turns it into two clips.
6. **Trim:** dragging the right edge of the landscape clip shortens it by about 1 s.
7. **Move:** dragging the audio clip moves it about 1.5 s to the right.
8. **Delete:** Delete removes a clip, ⌘Z brings it back, ⇧⌘Z removes it again, and the toolbar
   Undo restores it.
9. **Text:** the Text tab preset adds a text clip and opens the Text inspector. Editing the content
   updates the clip.
10. **Inspector:**
    - Video › Scale 150 % gives scale 1.5.
    - Audio › Volume −6 dB.
    - Speed › 2.0× halves the clip duration.
11. **Transition:** the Transitions tab applies Mix on the cut after the selected clip. The cut
    marker appears and the Transition inspector opens.
12. **Filter:** the Filters tab applies a look to the selected clip.
13. **Ratio:** the Player Ratio menu switches 16:9 (1920×1080) and back to 9:16 (1080×1920).
14. **Autosave + reload:**
    - The status shows "Auto saved".
    - After a reload, every clip, the transition and the text content come back.
    - Every asset is restored, none shows "Media lost", and the filmstrip thumbnails come back.
15. **Export:**
    - The project is cut down to one video clip plus the audio, exported at 1080p, and downloaded
      with `<a download>`.
    - ffprobe: 1080×1920, h264 + aac, duration within 0.2 s of the project.

**Layout compared with the CapCut reference screenshots (`docs/capcut-screens/01…09`):**
- The top bar has auto-save on the left, the project name in the centre and a cyan Export button on
  the right.
- The left panel has a 10-tab icon bar, a category sidebar and a tile grid.
- The player has its header, a letterboxed canvas, the cyan current timecode / total, a centred
  Play button, and Ratio / full screen.
- The inspector uses tabs by selection with collapsible sections, a ↺ reset and disabled ◇
  keyframe buttons.
- The timeline toolbar has the edit tools on the left and the magnet, snap and zoom controls on the
  right.
- Track headers have lock, eye and mute plus the Cover tile. Text and overlay tracks sit above the
  main track and audio below it, with clip colours like CapCut's.

## Integration requests applied

These came from `docs/integration-notes/*.md`, where each one is marked **Applied**.

**Model**
- Added the `'3:4'` aspect ratio (1080×1440).
- Added `blendEnabled` / `adjustEnabled` to visual clips, honoured by `getFrameState`. The Blend and
  Adjust sections now have CapCut's on/off checkbox. `migrateProject()` fills the new fields in
  projects saved before this change.

**Store**
- `previewTime` / `setPreviewTime` (the preview axis), and the player follows it while paused.
- `moveClips` (dragging a multi-selection).
- `insertClips` (the clipboard now holds clip snapshots, and ⌘X is bound).
- `moveClip({ newTrack: 'above' | 'below' })`.
- An `onAssetRemoved` hook. `src/media/cleanup.ts` uses it to free thumbnails, peaks, the object
  URL and the stored blob.

**Timeline**
- A Text preset dropped on the timeline is now added with its style, in one undo step.
- `--clip-ghost-*` theme tokens for the drag ghost.

**Library**
- Audio tiles draw real decoded peaks instead of a placeholder.

**Infrastructure**
- `index.html` gets a `data:` favicon, so there is no 404 console error.
- `e2e-testids.md` lists every extra test id.

## Bugs found and fixed

| # | Bug | Fix |
|---|---|---|
| 1 | After a reload, Chromium logged `Failed to load resource: net::ERR_FILE_NOT_FOUND` for a `blob:` URL. React StrictMode ran `bootProject()` twice; the second run re-registered every asset URL and revoked the first ones while `<video>` elements were still loading them. | `bootProject()` now runs only once (`src/store/autosave.ts`). |
| 2 | The preview went **black while scrubbing**. Chrome drops `readyState` below `HAVE_CURRENT_DATA` during a seek, so the media pool returned no source until `seeked`. | The video entry remembers that it has decoded a frame and keeps drawing the element during a seek, the way CapCut holds the last frame (`src/player/mediaPool.ts`). |
| 3 | A favicon 404 broke the "no console errors" rule. | Added a `data:` favicon. |
| 4 | Removing an asset leaked its hidden thumbnail `<video>`, cached JPEG URLs, waveform peaks, object URL and IndexedDB blob. | Added the `onAssetRemoved` hook and `src/media/cleanup.ts`. |
| 5 | ⌘V after the source clips were deleted pasted nothing, because the clipboard held ids. | The clipboard now holds snapshots and pastes through `insertClips`. |
| 6 | A styled Text preset dragged to the timeline arrived as plain "Default text". | The drop now uses the preset id from the drag payload. |

## Known remaining issues and limits (v1)

**Editing**
- **Uniform scale off** (`scaleX` / `scaleY`) is deferred. It changes render geometry, hit-testing
  and the canvas handles. The switch is shown on and disabled.
- **Inserting a track between two existing tracks:** the store supports it (`newTrack`), but the
  timeline has no drop zone between rows yet. Only the empty space above or below the stack
  creates a track.
- **Multi-clip drag** moves the whole selection, but the ghost shows only the clip under the
  pointer.
- **No right-click menu on the timeline** yet. Also missing: keyframes, the Cover picker, the track
  ⋯ menu, and auto-scroll while dragging near the edge.
- **In / out area** (I / O / ⇧X) is drawn on the ruler but nothing uses it yet (export range,
  ripple-delete of the area are later).
- **Extract audio** links the video and the audio clip by a shared `audioLink` id; split pieces
  stay linked. Duplicating or pasting a linked video copies the link, so "restore" on the copy
  also restores the original.

**Player**
- When a new clip id appears (right after a split, for example), the preview can be black for one
  frame while that clip's `<video>` element loads its first frame.

**Export**
- Speed changes also change pitch in the export; the preview keeps the pitch. Time-stretch is v2.
- Highlights, Shadows and Sharpen are CSS-filter approximations. The WebGL colour pass is v2.
- The WebM fallback (browsers without WebCodecs) records in real time, is not frame-exact, and its
  file has no duration header.

**Not built**
- Stickers, Effects, Captions and Templates tabs are placeholders ("Coming soon").
- Speed Curve, Combo animations, HSL / Curves and "Save as preset" are shown disabled.
- **No AI features**, as requested.

**Persistence**
- One project at a time (the last one opened). There is no project list or home screen yet.

## Memory — 2026-10-19

**Incident.** On 18 Oct the Mac (24 GB) ran out of swap and froze. Activity Monitor showed Google
Chrome at ~8 GB, with the editor open in a tab that was not being used (a few clips imported
earlier). After the reboot Chrome wrote 2.1 GB to disk in ~4.5 min.

**How it was measured.** A probe drove one Playwright Chromium at a time against its own Vite on a
private port. Every 5 s it sampled the JS heap (CDP `Performance.getMetrics` after a forced GC), the
DOM counters, the RSS and the **phys_footprint** of the browser's process tree (`top` MEM, the
number Activity Monitor shows), counters for rAF / timers / object URLs / `<video>` / canvas /
`toBlob` / `fetch` / `decodeAudioData` calls, and every IndexedDB `put` (wrapped by an init script)
with the profile's IndexedDB folder size. A kill switch stopped the run above 3 GB or below 20 %
free system memory; none came close. Media was `test-media/` plus a 60 s 1080×1920 clip
(`v-long-60s.mp4`, 30 MB). The runs were repeated in Chromium with the Metal GPU (like real Chrome)
and in the headless shell (software decode and raster).

### What made the tab big

1. **Nothing grew on its own in JavaScript.** In every scenario the idle tab made **0 rAF calls, 0
   IndexedDB writes and 0 extra object URLs**. The JS heap stayed at 5.6 MB (empty) and 8–12 MB
   (with media) for 3 minutes. That held with the tab hidden, after playback, and with Vite HMR
   reloading the page every 5 s. There was no autosave loop and no store → save → store loop.
2. **The memory was media decoders that the app never released while it was idle.** Each live
   `<video>` holds a demuxer, a decoder and its frame pool: **~30 MB per 1080×1920 element in GPU
   Chromium** (renderer + GPU) and ~70 MB in the software path. 4K phone footage is 4× the pixels.
   - **Timeline filmstrip:** one hidden `<video preload=auto>` per asset, kept for the whole
     session. Removing an asset only dropped `src` without `load()`, so the element kept its
     resource.
   - **Preview pool:** one `<video>` per *clip* (not per asset), capped at 12. Elements were only
     freed inside a render, so a paused, idle editor never freed anything. After scrubbing 8 clips,
     8–9 decoders stayed alive indefinitely, and elements of deleted clips stayed in the DOM.
   - **Preview audio:** one `<audio>` per audible clip, with no cap. They were only freed during
     playback, so after a pause they all stayed. The AudioContext also kept running while paused.
   - Result: after 60 s of playback 8 media elements stayed alive. After 6 delete/re-import cycles
     15 stayed alive, and that count never came back down.
3. **Waveforms read the whole file into memory.** `fetch(url).arrayBuffer()` followed by
   `decodeAudioData` on the entire file. For the 30 MB clip that was a +30 MB JS-heap peak and
   **+154 MB** in the renderer, and the cost grows with file size (a 1.5 GB phone clip means a
   1.5 GB ArrayBuffer plus the decode). It ran again after every reload for every audio clip,
   including audio extracted from video clips.
4. **Blob writes.** Every import writes the whole file to IndexedDB: 41 MB of media meant 41 MB
   written, and importing a file that was already in the bin wrote it a second time. While idle the
   app wrote **0 bytes** (no `put` at all, and the profile's IndexedDB folder size stayed flat), and
   a project save is a few KB. So the 2.1 GB of post-reboot writes did not come from an autosave
   loop. Importing large phone clips does write their full size, once per import.

Our test files are small, so we could not reproduce 8 GB exactly. The mechanism is the count of
live decoders multiplied by their size, plus whole-file waveform decodes. Neither came back down
while the tab sat idle, and both scale with real 4K footage.

**Not an app leak, for the record.** In the headless shell, every `drawImage` of a freshly seeked
frame left ~6 MB of renderer memory behind (100 draws = +600 MB). A `critical` memory-pressure
notification did not release it. The same test in GPU Chromium (ANGLE/Metal, which is what Chrome
uses) retained nothing (+61 MB for 100 draws, about the same as 100 `VideoFrame.copyTo`). So the
headless RSS numbers below include that artefact. The phys_footprint table from GPU Chromium is the
one to trust.

### Fixes

| Area | Before | Now |
|---|---|---|
| Preview `<video>` pool | 12 per clip, freed only during a render | **≤ 6**, LRU. Off-screen elements are freed 3 s later by **one one-shot timer**, also while paused. Release = pause, drop `src`, `load()`, detach. Images are capped at 12 and swept the same way. |
| Preview `<audio>` voices | unbounded, freed only while playing | **≤ 8**, LRU. All are freed 3 s after a pause. The AudioContext is suspended. |
| Hidden tab | everything stayed alive | `visibilitychange` → pause, release every decoder and voice, no renders. Visible again → exactly one frame is drawn. |
| Filmstrip grabber `<video>` | one per asset, kept forever | lives only while it has work, freed 2 s after its queue drains (with `load()`), recreated on demand |
| Filmstrip thumbnails | 1500 entries, no byte limit | `ByteLRU` with a **150 MB** budget (JPEG + decoded tile) and 4000 entries. Evicted object URLs are revoked. Each grab canvas is zeroed after `toBlob`. |
| Library posters | unbounded `Map` of data URLs | `ByteLRU` with a **24 MB** budget, dropped when the asset is removed |
| Waveform peaks | whole file → `arrayBuffer` → `decodeAudioData` | **streamed** with Mediabunny (`BlobSource` reads in chunks, `AudioSampleSink` decodes chunk by chunk). Each chunk is reduced into a `PeakAccumulator` and closed. Only the envelope is kept (200 floats/s, ≈ 2.9 MB per hour), in a `ByteLRU` with a **32 MB** budget. One decode at a time. The Web Audio fallback only runs for files ≤ 64 MB, and its buffer is dropped. |
| Object URLs | revoked on asset removal | still revoked. The registry also keeps the Blob, so readers stream it instead of fetching a copy. |
| IndexedDB blobs | written on every import, even when the same file was already in the bin | written **once**. Importing a file that is still stored (same name, size and mtime) reuses the stored blob. A blob deleted with its asset is written again on the next import. |
| Autosave | 0.8 s debounce on every project change | 0.8 s debounce, **≥ 2 s between writes**, and **skipped when the JSON (minus `updatedAt`) is unchanged**. JSON only, never Blobs. A save only touches `saveStatus`, so it cannot schedule another save. |
| Undo history | 200 snapshots | 200 steps **and** ≈ 64 MB of estimated JSON (measured once per snapshot in a WeakMap). Snapshots are JSON-only (tested). |
| Watchdog | none | Every 30 s it reads `measureUserAgentSpecificMemory` (when cross-origin isolated) or `performance.memory`. Above **1.5 GB** of heap it flushes every registered cache (filmstrip, posters, peaks, off-screen decoders) and shows the toast **"Memory high — caches cleared"**. It stops while the tab is hidden. |
| Debug readout | none | `?debug=1`: heap / soft limit, thumbnail entries and MB, peaks MB, live preview videos / images / audio + grabbers, object URLs, undo steps and project writes. Refreshes every 2 s, only while visible. |

All limits live in `src/media/memory.ts` (`MEMORY_LIMITS`).

### Before vs after

GPU Chromium (ANGLE / Metal), phys_footprint of the whole browser in MB. Media = 5 files incl.
the 60 s 1080×1920 clip, all on the timeline. "Live media" is the number of `<video>`/`<audio>`
elements still holding a source at the end of the idle period.

| Scenario | Footprint at idle start (before → after) | Footprint at idle end (before → after) | Live media at end (before → after) | Idle rAF / IDB writes (before → after) |
|---|---|---|---|---|
| b. media on timeline, idle 90 s | 679 → 677 | 557 → **488** | 4 → **1** | 0 / 0 → 0 / 0 |
| c. same, tab hidden 60 s | 745 → 673 | 585 → **504** | 4 → **0** | 0 / 0 → 0 / 0 |
| d. 60 s playback, then idle 60 s | 688 → 703 | 586 → 593 | 8 → **1** | 0 / 0 → 0 / 0 |
| e. 6 × (scrub 40 positions, zoom, delete all, re-import), idle 45 s | 1158 → **883** | 843 → **643** | 13 → **1** | 0 / 0 → 0 / 0 |
| 8 × 60 s clips, scrub 60 positions, idle 60 s | 919 → **772** | 747 → **570** | 9 → **1** | 0 / 0 → 0 / 0 |

Headless shell (software decode), RSS of the whole browser in MB, idle 3 min unless noted:

| Scenario | Peak (before → after) | Idle end (before → after) | JS heap idle start → end (after) |
|---|---|---|---|
| a. empty project, 170 s | 360 → 363 | 359 → 362 | 5.7 → 5.7 MB |
| b. media on timeline, 170 s | 1076 → 1023 | 1040 → **449** | 8.5 → 8.5 MB |
| d. playback then idle 120 s | 1603 → **1424** | 1510 → **1309** | 9.6 → 9.6 MB |
| e. cycles, idle 60 s | 2053 → **1606** | 998 → 1460 ¹ | 11.9 → 11.8 MB |
| 8 clips scrubbed, idle 90 s | 1808 → **1386** | 994 → 1276 ¹ | 9.2 → 9.2 MB |

¹ Between 40 and 90 s into the idle period, Chromium's own idle-player suspension released the
(still alive) old elements in the before runs. The after runs had already released them, but the
headless shell's drawImage artefact above keeps their memory in RSS. The footprint table is the one
that reflects real Chrome.

### Regression tests

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **334 / 334 pass** (22 files). New: `src/media/memory.test.ts` covers the LRU (budget, count cap, oversize reject, replace and evict, `deleteWhere`/`clear`, `close()` of VideoFrame-like values), the cache registry, and the watchdog decision plus its interval stopping while hidden and leaving no timer behind. `src/player/pool.test.ts` (jsdom) checks the ≤ 6 video cap, the release while paused with the timer disarming afterwards, `releaseAll`, the audio voice cap, release after a pause and resume cancelling it, and that `PreviewEngine` runs no rAF while paused, pauses and frees everything when hidden, and draws exactly one frame when visible again. `src/store/autosave.test.ts` checks there is no write in 10 idle minutes, that a save never schedules a save, debounce plus the minimum gap, the skip when unchanged, and that only JSON is written. `src/store/history.test.ts` checks the count and byte caps and that snapshots are JSON-only. `peaks.test.ts` checks that the streamed envelope equals `computePeaks` and stays at 200 floats/s. |
| `npm run build` | passes |
| `e2e/memory.spec.ts` | pass. It imports 5 files onto the timeline and idles 75 s. The JS heap is 9.01 → 9.02 MB, browser RSS 929 → 905 MB (samples 928 → 905, never rising), and **0 IndexedDB writes and 0 rAF calls** while idle. Live: 1 preview video, 0 voices, 0 grabbers. Hidden: 0 elements and no rAF. Visible again: 1 video. A second test checks that after playback every off-screen decoder is released while paused. |
| `e2e/smoke.spec.ts`, `flows.spec.ts`, `shortcuts.spec.ts` | pass (run one at a time, `--workers=1`) |

## Library functional audit — 2026-10-19

Every Library control was audited against its real effect: the store, IndexedDB, the timeline DOM,
player-canvas pixels read with `getImageData`, and the state after a reload. The full table is in
**[AUDIT-library.md](AUDIT-library.md)**. `e2e/audit-library.spec.ts` has 14 tests; 4 of them fail
on the previous code. Fixed:

- delete + ⌘Z left orphan clips and destroyed the media (removing an asset is now one undo step,
  and media is freed only when no history step can reach it);
- clips on locked tracks survived the deletion of their asset;
- "+" added clips to a locked main track;
- the same file imported twice made duplicate tiles;
- "Media lost" could not be relinked;
- Delete on a focused tile deleted the timeline selection;
- orphan blobs are swept at boot.

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | clean / passes |
| `npm test` | 358 / 358 pass (24 files; new `src/store/assetLifecycle.test.ts`) |
| e2e, one spec at a time, workers = 1 | smoke 1, flows 1, file-drop 2, shortcuts 2, timeline-stability 7, memory 2, audit-library 14: all pass |
