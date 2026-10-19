# QA report — v1 integration

Date: 2026-10-18 (v1), 2026-10-19 (audits, tabs and their integration — see the last section). Scope: the three parallel builds put together: Library + Inspector, Timeline, and
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
- ~~Uniform scale off is deferred~~ — done 2026-10-19, see "Inspector › Video tab" below.
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
  stay linked. (Since the timeline audit, duplicated / pasted copies get fresh link ids and
  one-sided links are dropped — see [AUDIT-timeline.md](AUDIT-timeline.md).)

**Player**
- When a new clip id appears (right after a split, for example), the preview can be black for one
  frame while that clip's `<video>` element loads its first frame.

**Export**
- ~~Speed changes also change pitch in the export~~ — fixed: pitch-kept speed (standard and
  curves) is rendered with ONE WSOLA time-stretch (`src/export/audioDsp.ts` `stretchMapped`, see
  § Integration), the mix goes through a peak limiter, and the WebM fallback file now has a
  duration ([AUDIT-export.md](AUDIT-export.md)).
- ~~Highlights, Shadows and Sharpen are CSS-filter approximations~~ — done: the WebGL2 colour pass
  (see "Adjust tab") renders every Adjust control in player and export.
- The WebM fallback (browsers without WebCodecs) records in real time and is not frame-exact
  (61 frames for 60, audio ≈15 ms late).
- The AAC track runs up to ~28 ms (1344 samples, silent) past the project end: the encoder's last
  1024-sample frame. The video track is exact.
- A stalled WebCodecs decoder / encoder now fails the export with a message after 20 s instead of
  hanging (§ Integration); the underlying browser stall itself was not reproduced.

**Not built**
- Stickers, Effects, Captions and Templates tabs are placeholders ("Coming soon").
- Speed › Velocity effects are shown disabled. (Speed › Curve, Combo / Loop animations, HSL /
  Curves / Color wheel / Mask and "Save as preset" work since 2026-10-19.)
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

## Timeline tool modes (CapCut cursor tools) — 2026-10-19

Research: `docs/research/07-tool-modes.md`. CapCut desktop's cursor dropdown has four tools —
**Select (A), Split (B), Select leftward (`[`), Select rightward (`]`)** — and no trim / ripple /
slip / hand / zoom tool, so those four are what ships. One table, `src/timeline/tools.ts`, drives the
dropdown, the toolbar icon, the cursors and (through `shortcutDefs.ts`) the keys, panel and tooltips.

- Split: SVG razor cursor (hotspot on the cut line); a thin white cut line over the hovered clip
  only, with a timecode tip, frame-snapped and pulled onto the playhead within 8 px (snapping on);
  a click cuts exactly there (one undo step) and the tool stays armed. No moving / trimming in
  split mode; the ruler still scrubs. ⇧+click split-all is NOT implemented (no CapCut source).
- Select leftward / rightward: own cursors; `[` / `]` select left / right of the playhead and arm
  the tool; a click selects left / right of the click on every unlocked track (a drag from a clip
  moves the selection); hovering shows the line and outlines the clips a click would take.
- A, Esc or the dropdown return to Select. Modifier combos never pick a tool (⌘B, ⌘A, ⇧B…). Keys
  work from any control except text fields (the zoom slider now only keeps its arrow / page keys).
- No toast on switching: CapCut shows none; the toolbar icon + cursor are the indicator.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **360 / 360 pass** (24 files). New `src/timeline/tools.test.ts` (13): tool table order and keys, modifier combos never pick a tool, Hebrew layout, distinct SVG cursors with hotspots, `bladeTime` (frame snap, playhead pull, edge refusal), `clipsOnSide` (left / right / crossing / locked) |
| `npm run build` | passes |
| `e2e/tool-modes.spec.ts` (new) | pass: B → blade cursor on clips and lanes, handles hidden, cut line inside the hovered clip with timecode tip, follows the mouse, snaps to the playhead, click splits (4 clips, one undo step), still armed, a drag in split mode moves nothing, ruler scrubs; A → grab cursor, no line, drag moves a clip again; Esc → Select; ⌘B keeps Select; B works with the zoom slider focused, not in the project-name field; dropdown lists Select A / Split B / Select leftward [ / Select rightward ]; rightward hover line + outlined targets, click selects; `[` selects left of the playhead and arms leftward, click on clip / empty lane re-anchors; Esc / A / menu back to Select |
| `e2e/shortcuts.spec.ts` | pass (now also checks that `[` / `]` arm the side tools and A leaves them) |
| `e2e/smoke`, `timeline-stability`, `file-drop`, `flows`, `memory` | all pass, run one spec at a time (one Chromium, workers=1, own Vite on :5467; peak Chromium RSS 1.47 GB) |

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

## Speed tab (Standard · Curve · Velocity effects) — 2026-10-19

### What CapCut desktop's Speed tab has

Sources: the reference screenshots `docs/capcut-screens/04-inspector-speed-standard.png` and
`05-inspector-speed-curve.png`; CapCut's own guides ([velocity / curve on PC](https://www.capcut.com/resource/how-to-do-velocity-on-capcut),
[speed ramp tool](https://www.capcut.com/tools/speed-ramp), [speed up a video](https://www.capcut.com/resource/how-to-speed-up-a-video));
third-party guides that list the presets ([shotkit](https://shotkit.com/velocity-capcut/)).

| Sub-tab | CapCut | Ours |
|---|---|---|
| **Standard** | Speed slider 0.1x–100x with six evenly spaced ticks (0.1 · 1 · 2 · 5 · 10 · 100, log between ticks), `1.00x` field with a stepper; Duration row `source → new` with an editable field; "Change audio pitch" switch (off = pitch kept); "Smooth slow-mo" (AI frame interpolation, Pro, "Only slow-speed videos are supported."); Reset | Same. Smooth slow-mo is shown exactly in CapCut's disabled state (no AI). Reset = 1x, no curve, original pitch, one undo step |
| **Curve** (Pro in CapCut) | Tiles None · Custom · Montage · Hero · Bullet · Jump cut · Flash in · Flash out (yellow curves on 1x / dashed guides); a graph editor 0.1x (bottom) … 1x (middle) … 10x (top) on a log axis with dashed guides half-way; Custom starts with five 1x beats; split-circle handles, arrow handles at both ends; the white playhead line; Reset and an add / delete beat button; "Duration 2s → 2s" | Same layout and behaviour. Preset shapes measured from the screenshot's thumbnails (pixel trace of the yellow curves): Montage 1x → 3.7x → 0.25x → 1x; Hero 1x → 2.7x plateau → 0.3x → 2.7x plateau → 1x; Bullet 2.7x → 0.27x → 2.7x; Jump cut 0.35x → 3x → 0.35x; Flash in 3x → 1x; Flash out 1x → 3x |
| **Velocity effects** | A gallery of speed-ramp **templates combined with visual effects** (CapCut lists flash, blur shake, fade blur, retro zoom, rainbow). Not AI, but they need an effects engine we do not have | Shown, disabled ("coming soon") |

### How curve speed works

- Model: `speedCurve: { preset, points[{x, v, s?, sl?}] } | null` on video/audio clips
  (`src/model/speedCurve.ts`). `x` is the clip's normalised **output** time, `v` the speed. Between
  points the curve is a cubic Hermite in log10(v) with flat tangents at authored points (CapCut's
  smooth beats). `migrateProject` fills `speedCurve: null` in old projects and repairs malformed
  ones; applying a curve keeps the source span and sets the standard speed to 1x.
- Mapping (one implementation, `src/model/time.ts`): source offset after τ µs =
  `D · F(τ / D)`, `F(x) = ∫₀ˣ v` (Gauss–Legendre table, 16 sub-intervals × 8 nodes per segment);
  `sourceSpan = D · mean`, so `D = span / mean`; `localTimeForSourceOffset` is the inverse
  (safeguarded Newton); `speedAtTime` the instantaneous speed. `getFrameState` (player + export
  frames), the export audio, the filmstrip and waveform, split and trim all use these.
- Split and trim are **exact**: Hermite pieces are closed under re-parametrisation, so cutting a
  curve at any point gives each part its own exact piece (`sliceCurve`); trimming outwards extends
  flat at the end speed (`extendCurve`, with separate arriving / leaving slopes so the extension is
  exactly flat), limited by the source.
- Preview: each video / audio element's `playbackRate` follows the curve every tick plus a bounded
  proportional correction toward the integral (`followRate`, ±25 %), so it stays in sync without
  seeking; `preservesPitch` follows the toggle.
- Export audio: each clip with a speed is rendered at rate 1 through the same mapping —
  "Change audio pitch" on → mapped resampling (pitch follows speed); off → WSOLA time-stretch
  (2048-sample Hann grains, 50 % overlap, ±384-sample similarity search), pitch kept. This also
  fixes the v1 limit "speed changes change pitch in the export".
- Standard ↔ Curve like CapCut: choosing a standard speed (slider, field or duration) removes the
  curve; choosing None returns to 1x. The Speed tab opens on Curve when the clip has a curve. The
  timeline badge shows the preset name.

### Evidence

`e2e/tab-speed.spec.ts` imports the 5 s testsrc2 clip (440 Hz tone), applies each case through the
inspector, exports 720p 30 fps, and checks: the clip's stored duration against `5 s / mean`
computed with an independent Simpson integral of the curve; the timeline clip's width (≤ 1.5 px);
the MP4 and audio-stream durations (ffprobe); 16 output frames matched (MSE over 36×64 gray
thumbnails) against all 150 source frames; and the dominant frequency (zero crossings) in 80 ms
windows where the speed is steady.

| Case | Timeline duration (s) | MP4 (s) | Audio (s) | Source frame correct | Pitch measured (speed → Hz, wanted) |
|---|---|---|---|---|---|
| Standard 2x | 2.500 | 2.537 | 2.537 | 16/16 | 2x → 440 (440) |
| Standard 2x, change pitch | 2.500 | 2.537 | 2.537 | 16/16 | 2x → **880** (880) |
| Standard 0.5x | 10.000 | 10.025 | 10.025 | 16/16 | 0.5x → 440 (440) |
| Curve Custom | 5.000 | 5.033 | 5.033 | 16/16 | 1x → 440 |
| Curve Montage | 3.511 | 3.540 | 3.540 | 16/16 | 1x → 440 |
| Curve Hero | 2.958 | 2.985 | 2.985 | 16/16 | 2.7x → 440 |
| Curve Bullet | 2.439 | 2.473 | 2.473 | 16/16 | 2.7x → 440 |
| Curve Jump cut | 7.524 | 7.551 | 7.551 | 15/16 ¹ | 0.35x → 440 |
| Curve Flash in | 2.602 | 2.633 | 2.623 | 15/16 ¹ | 3x → 440, 1x → 440 |
| Curve Flash out | 2.602 | 2.633 | 2.623 | 16/16 | 1x → 440, 3x → 440 |
| Curve Jump cut, change pitch | 7.524 | 7.551 | 7.551 | 15/16 ¹ | 0.35x → **154** (154) |

¹ The miss is the neighbouring frame when the predicted source time lies exactly on a source-frame
boundary (position 134.000 / 48.000 frames); the spec accepts ±1 only within 0.06 frame of a
boundary and demands the exact frame everywhere else. The MP4s are 0.03 s longer than the
timeline because of AAC priming / the last frame's length (same as before this change).

The spec also drags a Custom point to ~8x in the real graph (duration 5.0 s → 2.5 s, timeline and
"Duration" label follow, **one** undo step, ⌘Z / ⇧⌘Z), Reset, applies Hero and splits at 40 % (the
right part keeps Hero and continues the source within 2 ms), reloads (both curves restored, the
tab opens on Curve with Hero selected), then sets 2x in Standard (curve removed) and checks Smooth
slow-mo is disabled. Screenshots: `e2e/screens/tab-speed-*.png`; raw numbers:
`e2e/test-results/tab-speed-measurements.json`.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **407 / 407 pass** (27 files). New: `src/model/speedCurve.test.ts` (property tests against a Simpson integral and a midpoint integral of `speedAtTime` on 40+ random curves and every preset; F monotone; inverse round-trips; slices exact; flat extension), `src/store/speedCurve.store.test.ts` (apply / None / standard replaces curve / undo / clamping / exact split, trim in and out, delete-left/right, extract audio, migration, frameState ops), `src/export/timeStretch.test.ts` (resample 2x → 880 Hz, 0.5x → 220 Hz; WSOLA keeps 440 Hz at 0.25x–3.7x with full level; curve audio follows / keeps pitch), `src/inspector/SpeedTab.test.tsx`, `followRate` in `player.test.ts`; the store fuzz now applies random curves |
| `npm run build` | passes |
| `e2e/tab-speed.spec.ts` | **12 / 12 pass** |
| `smoke`, `flows`, `shortcuts`, `timeline-stability`, `file-drop`, `memory` | pass (one at a time, through the browser lock) |

**Seen once:** in the first full run the 0.5x export stopped advancing at video frame 125 / 300
(no error, the download never came). It did not reproduce in three later runs. The stall was in the
video phase (`ExportFrameSource` / Mediabunny decode), not in the audio mix. It ran while ten agents
shared the machine. **Integration:** the export can no longer hang silently — a stalled decoder
is restarted once, and a 20 s watchdog fails the export with a message (§ Integration).

**Limits:** speeds above 16x are silent in the preview (browser playbackRate limit; the export
is fine). Velocity effects are not built. CapCut's Pro badge on Curve is not shown.

## Audio tab (CapCut parity, no AI) — 2026-10-19

### What CapCut desktop's Audio tab has

Sub-tabs **Basic | Voice changer** (an audio clip's inspector is **Audio | Speed**; a video clip with
sound adds an **Audio** tab next to Video). Basic, top to bottom (screenshot 03):

| Section | CapCut | Ours |
|---|---|---|
| **Basic** ☑ ↺ ◇ | Volume −60…+20 dB (0.0 dB default, slider position 0.75 = 0 dB matches the screenshot), Fade in / Fade out 0.0 s… clip length | Same ranges and units. Checkbox = clip sound on/off. Reset → 0 dB / 0 s / 0 s. |
| **Normalize loudness** ☑ (Pro) | "Normalize the loudness of the selected clip or clips to a target level." Target −23 LUFS ([capcut.com](https://www.capcut.com/resource/normalize-audio-premiere)) | ITU-R BS.1770-4 integrated loudness of the clip's source span (K-weighting, 400 ms blocks, −70 / −10 LU gates), gain = −23 − measured (±30 dB cap). Readout: "Clip −38.0 LUFS → +15.0 dB". |
| **Enhance voice** (AI, Pro) | AI | Shown disabled, "AI · Coming soon". |
| **Video translator** (AI, Pro) | AI, video clips | Shown disabled on video clips only. |
| **Reduce noise** ☑ (Pro) | AI denoiser | **DSP approximation, labelled "DSP · not AI"**: 80 Hz high-pass + adaptive noise gate (floor = quietest 20 ms block of the last 1.5 s, opens 10 dB above it, clamp −65…−35 dBFS, closes to −30 dB; steady material is never gated). |
| **Isolate voice** (AI) | AI | Shown disabled. |
| **Fill channel** ☑ ↺ ◇ ▾ | Copy one channel to both ([capcut.com](https://www.capcut.com/resource/normalize-audio-premiere): "filling right with left") | Left channel / Right channel → both, mono upmixed first. |

**Voice changer** — CapCut has *Voice filters* (non-AI presets: Chipmunk, High, Low, Deep, Robot,
Megaphone, Echo, Electronic, Distorted, Synth, Vinyl… per
[capcut.com](https://www.capcut.com/resource/voice-changer-for-pc) and
[capcut.com](https://www.capcut.com/resource/how-to-change-your-voice)), *Voice characters* (AI
TTS-style voices) and *Speech to song* (AI). Ours: 11 DSP voice filters with a Strength 0–100
slider (default 50): Chipmunk (+5…+12 st), High (+2…+6 st), Low (−2…−5 st), Deep (−4…−9 st +
low-shelf), Robot (50 Hz ring-mod + comb), Electronic (resonant comb), Echo (250 ms feedback delay),
Megaphone (band-pass + overdrive), Distorted (wave-shaper), Vinyl (band-limit + bit-crush), Big hall
(seeded convolution reverb). Voice characters and Speech to song are disabled "AI · Coming soon".
CapCut's exact filter names/parameters could not be confirmed from an official CapCut help page.
No "Apply to all" exists in CapCut's Audio tab, so none was added.

**Extracted audio:** a video whose sound was extracted (⇧⌘S) shows "This clip's sound was extracted…"
with **Select audio** and **Restore audio** instead of the controls; the extracted clip inherits every
audio setting, splits copy them.

### How it works

One FX chain builder (`src/audio/dsp.ts`) is used by **both** the preview `AudioContext`
(`player/audioEngine.ts`, chain rebuilt when its signature changes) and the export
`OfflineAudioContext` (`export/offlineMix.ts`): input (forced stereo) → fill channel (splitter →
merger) → high-pass + `oe-gate` worklet → `oe-pitch` worklet → voice-filter nodes → output gain
(volume × normalize × fades). The two AudioWorklet processors (`src/audio/worklets.ts`) load from a
Blob URL in either context. Loudness is measured once per (asset, span) by streaming the file with
Mediabunny (`src/audio/measure.ts`); preview, inspector readout and export share the cache.
Export speed: ~~when "Change audio pitch" is off the chain's pitch shifter runs at 1/speed~~ —
since the integration the clip is first rendered at rate 1 by the shared WSOLA stretcher (pitch
kept) or resampled (pitch changed), so the chain's pitch shifter only carries the voice filter
(§ Integration). Effect tails are cut at the clip end in both.

Model: `AudioProps` gained `normalize`, `reduceNoise`, `fillChannel`, `voiceFilter`
(`defaultAudio()` → off); `migrateAudioProps` / `migrateProject` fill them on old projects. Dev hook:
`window.__oeAudio.voices()` lists each live preview voice's gain, target, normalize gain and stages.

### Measured (e2e/tab-audio.spec.ts → 26 s 720p MP4, ffmpeg)

| Check | Result |
|---|---|
| Volume −6 dB | RMS −23.03 → −29.00 dB = **−5.97 dB**; volumedetect max −19.9 → −25.9 dB (**−6.0**) |
| Fade in 1 s (100 ms astats windows vs ideal linear ramp) | −16.33 / −11.98 / −9.08 / −6.92 / −5.16 / −3.72 / −2.48 / −1.39 / −0.43 dB vs ideal −16.32 / −11.98 / −9.09 / −6.92 / −5.18 / −3.73 / −2.49 / −1.41 / −0.44 (all within 0.02 dB); full level after: +0.02 dB |
| Normalize | source −38.0 LUFS → export **−23.0 LUFS** (ebur128); preview normalize gain 5.6205 = +15.0 dB, same as the readout |
| Fill channel (left-only source) | L −23.01 / R −23.01 dB; without fill R = −∞ |
| Reduce noise (beeps over −50 dBFS hiss) | hiss in pauses −51.1 → **−70.5 dB** (−19.4 dB); beeps −9.06 → −9.02 dB (untouched) |
| Chipmunk 100 (+12 st) | zero-crossing rate 0.0417 → 0.0827 (×1.98) |
| Speed 2× keep pitch / change pitch | ZCR 0.0413 (×0.99) / 0.0833 (×2.00) |
| Preview graph | −6 dB voice gain 0.5005 (target 0.5012), stages `input→gain`; fill `input→fill:left→gain`; noise `input→highpass:80→gate→gain`; chipmunk `input→pitch:2.0000→voice:chipmunk:100→gain` |

Also verified: every control set through the inspector, undo/redo (⌘Z / ⇧⌘Z) of a checkbox, all
settings intact after a reload, AI rows disabled. Unit tests: `src/audio/audio.test.ts` (dB maths,
fade points, K-weighting coefficients, EBU Tech 3341 cases 1–2 at 48 / 44.1 kHz, gating, dual-mono,
streaming = one-shot, normalize gain, pitch ratios, signatures, migration),
`src/audio/audioStore.test.ts` (undo/redo per control, split / extract / restore, span, save /
reload) and `src/inspector/AudioTab.test.tsx` (section order, AI rows, checkboxes, reset, voice
filter strength = one undo step, extracted notice). Totals: `npm test` 376 / 376; typecheck and build
clean; e2e smoke, flows, shortcuts, file-drop, memory, timeline-stability and tab-audio all pass
(one at a time).

Limits: Reduce noise is a gate, so hiss *under* speech stays; the pitch shifter delays the clips that use it by ≈ 21 ms
(under one frame, preview and export alike); keyframes on Volume / Fill
channel are shown disabled like everywhere else (v2).

## Inspector › Video tab — 2026-10-19

Shown for video and image clips. Layout follows CapCut desktop (`docs/capcut-screens/02`): sub-tabs
**Basic · Remove BG · Mask**. No AI: CapCut's AI items keep their place but are switched off with an
"AI" badge and "Coming soon".

| Sub-tab | Section | Controls (range, default) | Status |
|---|---|---|---|
| Basic | Transform | Scale 1–400 % (100); **Uniform scale** on/off → Scale width / Scale height 1–400 %; Position X/Y px from centre (0, 0); Rotate ° + dial (0); 6 align buttons; mirror H/V; ↺ | works (video + image + text) |
| Basic | Blend (checkbox) | Mode: Normal, Darken, Screen, Overlay, Multiply, Lighten, Hard light, Soft light, **Linear burn** (new), Color burn, Color dodge; Opacity 0–100 % (100); ↺ | works |
| Basic | Canvas (checkbox, main-track clips) | None / Color (12 swatches + picker) / Blur (4 levels = 12/30/60/100 px) / Image (an imported image, cover-fit); ↺; **Apply to all** (main track) | works |
| Basic | Stabilize*, Enhance quality, Reduce image noise, Optical flow*, AI remove, AI expand, Retouch (*video only) | — | disabled, AI |
| Remove BG | Auto removal, Custom removal | — | disabled, AI |
| Remove BG | Chroma key (checkbox) | Colour (picker + eyedropper "Pick"), Intensity 0–100 (50), Shadow 0–100 (0); ↺ | works |
| Mask | Shape tiles | None, Linear, Mirror, Circle, Rectangle, Heart, Star | works |
| Mask | Mask | Invert; Position X/Y px; Rotate ° + dial; Size W/H px (Mirror: H only, Linear: none); Feather 0–100 (0); Round corners 0–100 (Rectangle); ↺; on-canvas handles: move (dot), size (square), rotate (round), feather (arrow) | works |

**One engine.** Everything is resolved in `getFrameState` and drawn by `renderFrame`, which both the
player and the exporter call: per-axis scale (`ResolvedTransform.scaleX/scaleY`), masks on the
clip's scratch layer (`destination-in` / `destination-out`, feather = gaussian blur for closed
shapes, exact linear gradients for Linear / Mirror; `src/engine/render/mask.ts`), chroma key on a
per-frame copy of the source (Cb/Cr distance, `src/engine/render/chroma.ts`), linear burn as
difference → lighter → difference passes, and the canvas background as an extra op drawn before a
main-track clip (`role: 'background'`, not hit-testable; fill op for colours).

**Model.** `Transform.uniformScale / scaleX / scaleY` (all visual clips); `mask`, `chroma`, `canvas` on
video and image clips; `BlendMode` gains `'linear-burn'`; `ClipPatch` merges `mask / chroma / canvas`
and `ops.updateClip` clamps them. `migrateProject` → `migrateVideoTabFields` fills them in older
projects (scaleX/Y start from the saved scale). All edits are store actions → undoable and autosaved.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **378 / 378 pass** (25 files). New: `src/engine/render/videoTab.test.ts` (defaults, clamping + undo, migration, per-axis frame state, canvas background ops, linear burn op, mask geometry for all six shapes incl. feather / invert / rotation / round corners, star & heart polygons, chroma key alpha + despill, non-uniform corner drag, compositor calls for masks / blur / linear burn) and `src/inspector/VideoTab.test.tsx` (uniform switch, picture box, default mask sizes, on-canvas mask maths incl. flipped / rotated clips, the tab UI: AI rows disabled, image vs video, overlay has no Canvas, Canvas + Apply to all + undo, chroma, mask tiles / invert / size) |
| `npm run build` | passes |
| `e2e/tab-video.spec.ts` (new) | pass. Drives the real UI and samples the player canvas with `getImageData` (numbers below), then reloads and exports a 1080p MP4 and reads its frame at 1 s with ffmpeg (`-ss 1 -frames:v 1` → PNG → rgb24) |
| `smoke`, `flows`, `shortcuts`, `file-drop`, `timeline-stability`, `memory` | pass (one at a time through the browser lock) |

Pixel evidence (preview canvas, RGB; white 1080×1920 video on the main track, black canvas):

| Setting | Samples (x, y as fractions) |
|---|---|
| baseline | (0.5,0.5) 255 · corner 255 |
| Scale 50 % | (0.1,0.1) **0,0,0** · (0.3,0.3) 255 · ⌘Z → corner 255 again |
| Uniform off, width 50 % | (0.1,0.5) **0** · (0.5,0.05) 255 · (0.5,0.95) 255 |
| Position X 540 | (0.25,0.5) **0** · (0.75,0.5) 255 |
| Rotate 90° | (0.5,0.1) **0** · centre 255 |
| Opacity 50 % | centre **128,128,128** (luma halved) |
| #4080c0 image overlay over that 50 % grey: Multiply / Screen / Linear burn / Darken / Lighten | 31,64,96 · 159,191,224 · 0,0,65 · 62,127,128 · 128,128,192 (expected 32,64,96 · 160,191,223 · 0,1,65 · 64,128,128 · 128,128,192) |
| Mask Circle | centre 255 · (0.7,0.5) 255 · (0.8,0.5) **0** · corner **0** |
| Circle, Feather 100 | edge (0.75,0.5) **116** (soft) · centre 255 |
| Circle, Invert | centre **0** · corner 255 |
| Circle dragged 100 px right on canvas | (0.8,0.5) 255 · (0.3,0.5) 0; ⌘Z restores |
| Linear / Mirror / Rectangle | top 255, bottom 0 / band 255, (0.5,0.25) 0 / (0.25,0.5) 255, (0.5,0.25) 0 |
| Heart / Star | centre 255, above + side 0 / centre + top arm 255, between arms (0.639,0.402) **0** |
| Chroma key (image overlay, left half #00ff00, right #ff0000) | before 0,255,0 → after **255,255,255** (the white clip shows through); red half stays 252,0,0; Intensity 0 → green again |
| Canvas Blur (clip at 50 %) | (0.5,0.15) 0 → **255** (blurred copy) |
| Canvas Color #e94b3c | (0.5,0.15) and corner **233,75,60** |

Final composition (canvas colour + clip at 50 % + keyed, circle-masked image overlay):

| Point | Preview | After reload | Exported MP4 @ 1 s |
|---|---|---|---|
| (0.05,0.05) canvas | 233,75,60 | 233,75,60 | 231,74,59 |
| (0.5,0.2) canvas | 233,75,60 | 233,75,60 | 231,74,59 |
| (0.5,0.3) clip outside mask | 255,255,255 | 255,255,255 | 255,255,255 |
| (0.42,0.5) keyed half | 255,255,255 | 255,255,255 | 255,255,255 |
| (0.6,0.5) red half in mask | 252,0,0 | 252,0,0 | 251,0,0 |

Limits: masks have no keyframes yet (the ◇ buttons stay disabled like everywhere else); the Pen /
custom mask and Remove BG's AI cut-outs are not built; the Canvas "Image" choice lists images
already in the Media pool; feathering a closed shape is a gaussian blur (CapCut's edge falloff
may differ slightly); a non-uniformly scaled clip shears a rotated mask, as in the math of any 2D
transform. Crop stays on the timeline toolbar (CapCut has no crop control in this tab).

## Adjust tab — CapCut parity on a GPU colour pipeline — 2026-10-19

**What CapCut's Adjust tab has** (screenshot `docs/capcut-screens/07-inspector-adjust-basic.png`
plus CapCut / third-party guides; slider ranges are not published, so CapCut's −50…50 / 0…100
convention from the screenshot is kept):

| Sub-tab | CapCut | Ours |
|---|---|---|
| Basic | Auto adjust ✦, Color match ✦, Color correction ✦ (AI) | shown disabled, "AI · Coming soon" |
| Basic | LUT: Name (None / imported .cube), Intensity 0–100, Protect skin tone | works: .cube 3D (2–129³) and 1D files, DOMAIN_MIN/MAX, trilinear on a 3D texture, intensity, skin-tone key (non-AI hue/sat key) |
| Basic | Adjust: Color (Temp, Tint, Saturation), Lightness (Exposure, Brightness, Contrast, Highlights, Shadows, Whites, Blacks, Brilliance), Effects (Sharpen, Clarity, Particles, Fade, Vignette) | all 16 work (Particles = film grain) |
| HSL | 8 colour ranges × Hue / Saturation / Lightness | works, −100…100 |
| Curves | Luma + Red / Green / Blue curves with draggable points | works: click to add, drag, double-click or drag out to remove; monotone cubic (Fritsch–Carlson) baked into a 256-entry texture |
| Color wheel | Lift / Gamma / Gain / Offset wheels with a luminance slider each | works (the "Log" wheel set is not built) |
| Mask | Limit the adjustment to a shape | works: Linear, Mirror, Circle, Rectangle; position, rotation, size, feather, roundness, invert (inspector controls; no on-canvas handles yet) |
| Footer | Apply to all, Save as preset | both work; presets persist in localStorage and show in Library › Adjustment › My presets |

Sources: capcut.com/resource/capcut-color-grading, capcut.com/tools/color-wheel,
capcut.com/tools/hsl-color, filmora.wondershare.com/advanced-video-editing/how-to-color-grade-video-in-capcut.html.

**Pipeline** (`src/engine/color/`): one WebGL2 fragment shader per clip, used by the player and the
export through the shared compositor (`renderFrame` → `opts.grader`). Media are graded in source
space (cropped, at the size they are drawn), then drawn with their transform, so blend, opacity,
animations and transitions are unchanged. Order: LUT → look (grayscale/sepia of the Filters
library) → white balance + exposure in linear light → brightness (mid-tone gamma) → contrast →
tone (shadows/highlights/whites/blacks/brilliance) → HSL → saturation → curves → wheels → fade →
clarity + sharpen → vignette → grain → mask. `math.ts` is the same pipeline in TypeScript: the
CPU fallback when WebGL2 is missing, the unit-test reference and the Library tile previews. The
Filters looks run through the same pass (their tiles are rendered by it too).

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **392 / 392** (new: `engine/color/color.test.ts` 33 colour-maths tests against reference values — temp/tint/sat/contrast/exposure/brightness/tone/fade, HSL weights, curve monotonicity on 50 random point sets, `.cube` identity/affine/1D/errors, wheels, mask shapes; `model/grade.test.ts` defaults, migration, undo; `inspector/AdjustTab.test.tsx` 8 UI tests) |
| `npm run build` | passes |
| `e2e/tab-adjust.spec.ts` | pass (pixel evidence below) |
| all e2e specs, one at a time through the browser lock | smoke 1, flows 1, shortcuts 2, file-drop 2, memory 2, timeline-stability 7, tab-adjust 2 — all pass |

**Pixel evidence** (SMPTE bars, 16:9 project, t = 1 s, 5×5 averages at the centre of each top bar):

| State | grey | yellow | cyan | green | magenta | red | blue |
|---|---|---|---|---|---|---|---|
| baseline (preview) | 191,191,191 | 195,181,2 | 0,172,190 | 0,161,0 | 205,30,191 | 208,19,1 | 0,11,190 |
| Saturation −50 | 191,191,191 | 171,171,171 | 137,137,137 | 115,115,115 | 79,79,79 | 58,58,58 | 22,22,22 |
| Temp +50 | 211,188,160 | 212,175,1 | 0,175,164 | 0,161,0 | 216,27,152 | 209,16,1 | 0,15,188 |
| identity .cube | = baseline (0 difference) | | | | | | |
| R↔B swap .cube | 191,191,191 | 2,181,195 | 190,172,0 | 0,161,0 | 191,30,205 | 1,19,208 | 190,11,0 |
| inverting curve (dragged) | 64,64,64 | 60,74,253 | 255,83,65 | 255,94,255 | 50,225,64 | 47,236,254 | 255,244,65 |

- Undo after Saturation restores the baseline exactly; the curve drags are one undo step each.
- After a reload the graded preview is identical (max difference 0).
- **GPU vs CPU:** the shader and `math.ts` agree on a 64×32 test card for nine settings groups:
  max difference 0 (1 for HSL and mask), mean 0.00.
- **Export:** the graded MP4 equals the CPU reference applied to the *ungraded* MP4's pixels within
  3 levels — the export runs the same pass. The export differs from the *preview* by up to 29 on
  saturated bars, but the ungraded export already differs from the ungraded preview by 30 (red
  bar 190,0,0 in the export vs 208,19,1 in the player): the `<video>` element and Mediabunny decode
  this BT.601-tagged clip with different matrices. That is a pre-existing player/export
  difference, not the colour pass; the grey bar (no chroma) matches within 1.

**Model** (`src/model/types.ts`): `Adjust` gains `whites, blacks, brilliance, clarity, grain`;
every visual clip gains `grade: { lut, hsl, curves, wheels, mask }` (each section with its own
`enabled`). `migrateProject` fills both for old projects (SCHEMA_VERSION unchanged, additive).
`updateClip({ grade: { hsl } })` replaces one section and deep-clones it.

**Limits:** LUT files live in this browser's IndexedDB (`our-editor-luts`), not in the project; a
project opened elsewhere shows "LUT (missing)" and renders without it. Text clips are graded as a
whole canvas layer (vignette and mask are relative to the canvas, not the text box). No keyframes,
no on-canvas mask handles, no Log wheels. Vignette keeps the v1 range 0…100 (darken only).

## Animation tab (CapCut parity) — 2026-10-19

**What CapCut has (research):** sub-tabs `In | Out | Combo` for video/image and `In | Out | Loop`
for text. A search box ("People are searching …"), category chips (★ favourites, Trending, Basic,
Light, Glitch, Mask, 3D, Vibration…), and a grid whose first tile is **None**. Tiles carry ☆
favourite and ⤓ download overlays and a Pro diamond. Hovering a tile plays its preview, a click
applies it and plays it in the player, and the applied tile gets a cyan outline. A **Duration**
slider appears under the grid. Applied animations show as ramps on the clip. Combo runs over the
clip and replaces In/Out. Loop runs for the text's whole duration, and older versions show a
"Fast ↔ Slow" speed slider. Sources: `docs/capcut-screens/06-animation-in-library.png`,
`docs/research/01-ui-ux.md` §2.2/§4.5,
autoae.online/blog/how-to-do-text-animation-in-capcut-pc and capcutguide.com/capcut-text-animation.
CapCut does not publish exact defaults. Ours are 0.5 s for In/Out (minimum 0.1 s), the whole clip
for Combo, and 1 s per Loop cycle (0.1–5 s).

**What we built**
- **One catalogue,** `src/engine/animations.ts`: **53 In, 53 Out, 18 Combo and 15 text Loop**
  animations. Each one is a pure function of progress that returns an `AnimFrame`
  (offset, scale, sx/sy, skew + pivot, rotation, alpha, blur, brightness, hue, glow, RGB split,
  slices, masks, text reveal), with named easings.
  - In and Out are written once. Out is the time-reverse of In, mirrored, so "Slide Left" enters
    from the right and exits to the left.
  - The v1 ids are kept, so old projects still play.
- **Rendering:** `getFrameState` folds the frames into the op transform plus `op.fx`.
  `renderFrame` applies skew/scale around the pivot, the masks (clip-box fractions), the light
  filters, the glitch passes on a scratch layer, and the typewriter reveal.
  - The player, the export and the tile thumbnails all draw through this one path.
- **UI:**
  - Live canvas thumbnails, animated on hover.
  - Clicking a tile applies it as one undo step and plays its window once in the player.
  - ☆ favourites persist in localStorage (`our-editor:ui:animation-favorites`).
  - Search across categories, None, a check badge on the applied tile and a dot on the sub-tab.
  - A Duration slider (Speed for Loop).
  - Timeline: In/Out ramps, a Combo ramp, a ∞ badge for Loop and `data-animations` on the clip.
- **Model:**
  - New `animationCombo` and `animationLoop` fields (default `null`); `migrateProject` fills them
    on old projects.
  - `AnimationType` is now a string id.
  - The store has `setAnimation(clip, 'in'|'out'|'combo'|'loop', id|null, dur?)` and
    `setAnimationDuration`.
- **CapCut rules:** In + Out never exceed the clip, and the slot you edited last wins (the other
  one shrinks). Combo removes In/Out and the reverse. On a split the Combo stays on the left part
  and the Loop is kept on both parts.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **947 / 947 pass**. New: `src/engine/animations.test.ts`, 573 tests, every animation checked for its rest state at the right end (In p=1, Out p=0, Combo/Loop both ends), no NaN/∞ on [−0.01, 1.01] or NaN input, actually moves, continuity at 4000 steps (glitches: bounded envelope instead); `src/engine/animationState.test.ts` (clamping, Combo/Loop, undo, split, migration, frame state, renderer: pivot matrix, mask rect, brightness/glow filter, 12 glitch slices, typewriter); `src/inspector/AnimationTab.test.tsx` (sub-tabs per clip type, chips, apply + preview + None + undo, slider clamping, Combo, search, favourites persisted, text Loop) |
| `npm run build` | passes |
| `e2e/tab-animation.spec.ts` | pass, details below |
| other e2e specs (smoke, flows, shortcuts, file-drop, memory, timeline-stability) | all pass, run one at a time through the browser lock |

**e2e evidence** (two white 1080×1920 images on black: A = Fade In 1 s + Slide Left out 1 s,
B = Wipe Right in 1 s). Values are luma at 7 columns across the middle row, normalised 0 = black
frame, 1 = white frame:

| time | expected | preview canvas | exported MP4 (720p, ffmpeg frame n = t·30) |
|---|---|---|---|
| 0.2 s fade 20 % | 0.20 everywhere | 0.202 × 7 | 0.202 × 7 |
| 2.8 s slide-left out 80 % | white until 0.488 W | 1 1 1 0 0 0 0 | 1 1 1 0 0 0 0 |
| 3.5 s wipe-right in 50 % | white until 0.875 W | 1 1 1 1 1 1 0 | 1 1 1 1 1 1 0 |

The spec also checks:
- Hovering a tile changes its thumbnail.
- A click previews the animation once, and playback stops on its own.
- The animations survive a reload.
- The timeline indicator is shown.
- There are no console errors.

**Limits**
- No ⤓ download button: every animation is built in.
- "3D" is a 2D skew/scale approximation.
- Loop and Combo are whole-clip effects, not per-character effects.
- The preview-once has a wall-clock safety stop because headless Chromium's audio clock can stall.

## Integration of the nine agent branches — 2026-10-19

`integration` = `main` (tool modes) + `agent/qa-timeline`, `qa-library`, `qa-render`, `qa-export`
(audits, merged first) + `tab-speed`, `tab-audio`, `tab-video`, `tab-adjust`, `tab-animation`
(features), one `--no-ff` merge each, typecheck + `npm test` green after every merge. Audit details:
[AUDIT-timeline.md](AUDIT-timeline.md), [AUDIT-library.md](AUDIT-library.md),
[AUDIT-render.md](AUDIT-render.md), [AUDIT-export.md](AUDIT-export.md).

**How the overlaps were unified**

- **Undo / bin (qa-timeline × qa-library).** qa-timeline's magnet-on-undo symmetry
  (`magnetFor` / `magnetAt` / `pushPast`) and qa-library's `patchAllDocs` both kept; `withAssets`
  dropped (removing an asset is an undo step now; imports patch every snapshot). `patchAllDocs`
  carries the magnet record across patched snapshots. Locked main track: qa-timeline's rule wins
  (new media goes to a free overlay track — qa-library's "refuse" branch had become unreachable);
  its unit and e2e tests follow.
- **Time-stretch: one implementation.** Three existed: tab-audio's delay-line pitch shifter at
  1/speed, tab-speed's WSOLA `stretchMapped`, qa-export's WSOLA `stretchPreservePitch`. Kept
  **qa-export's WSOLA** (±512-sample search refined to 1 sample), generalised to tab-speed's
  source-map interface so it renders standard speed *and* speed curves:
  `src/export/audioDsp.ts` `stretchMapped` (`stretchPreservePitch` is its constant-rate case).
  Measured on a 440 Hz sine, 0.5×–3×: sine-fit SNR **56–78 dB** vs 45–57 dB for tab-speed's
  variant, same pitch (440.00 Hz) and envelope ripple; ~2× slower (≤ 70 ms per 4 s of audio).
  The delay-line shifter now only carries the voice filters (no speed compensation).
- **Mix order** (`offlineMix.ts`, mirrored by `audioEngine.ts`): per-clip speed mapping / stretch
  → FX chain (fill channel, reduce noise, voice filter) → gain (volume × normalize × fades) →
  bus → peak limiter. Normalize measures the curve-aware source span (same key as the preview).
- **Draw path** (`renderFrame.ts`): grade (source space, per-axis scale) → chroma key on the
  graded source → transform incl. the animation's skew / non-uniform scale and animation masks
  → Video › Mask on the clip layer → animation light filter → glitch → blend (normal or the
  linear-burn passes). The Adjust mask only limits the grade (inside the grade params); both
  masks coexist (`MASK_SHAPES` vs `ADJUST_MASK_SHAPES`).
- **Preview sync** (`sync.ts`, `mediaPool.ts`): speed curves follow `followRate`; standard speed
  keeps qa-render's nudge; frame lookups use `FRAME_LOOKUP_EPS_US`; qa-export's colour re-wrap
  reads the registered Blob (no fetch copy).
- **Store ops**: trim / split / setSpeed keep both the curve slicing (tab-speed) and the
  media-length flooring (qa-timeline); `fitToMedia` uses the curve's mean speed.
- **Migrations**: `migrateProject` runs one pipeline of per-feature clip migrations
  (checkboxes, speed curve, audio FX, video-tab fields, grade, animation slots).
  `src/model/migrate.fixtures.test.ts` loads projects saved by **c339bf3 and by every branch**
  (fixtures written by each build's own store) plus the integration build.
- **e2e helpers**: `e2e/audit-helpers.ts` is one module re-exporting `e2e/audit/{library,render,
  export}.ts`; colliding names are namespaced (`RENDER_AM` / `ensureRenderMedia`, `EXPORT_AM` /
  `ensureExportMedia`).

**Bugs fixed during integration**

- **Export could hang silently** (the 0.5× stall at frame 125 / 300). Every await in the frame
  loop could wait forever if WebCodecs stopped answering. Now: a decoder read silent for 8 s is
  abandoned and the stream reopened once (`SequentialReader`); every frame step, the start and the
  finalize are guarded by a 20 s watchdog that fails the export with "Export stopped responding
  at video frame N / M … (decoding "x" at s)"; cleanup is bounded. Unit: `watchdog.test.ts`;
  e2e: `export-watchdog.spec.ts` (an injected hang is reported in 3.5 s, the next export works).
- **Colour-matrix fix × WebGL grader agree**: graded smptebars (BT.601-tagged HD and untagged SD),
  preview vs export, max 2 levels per bar (audit-export "the colour-matrix fix and the WebGL grade
  agree").
- `inspector.css` lost two closing braces in the merge (every rule after the Speed section was
  ignored — the Video tab's Canvas swatches had no size); restored and checked against every
  branch's rule blocks.
- `NumberBox`: the select-all on focus could land after the first typed key and swallow it (flaky
  transition duration edit).
- Audit specs updated to the merged behaviour: `[` / `]` arm the side tools, Shift+B opens the real
  Curve panel, Look tiles are graded JPEGs with a sample scene, Adjust / animation expectations come
  from the shared colour pipeline and the animation catalogue, the export audit resets projects
  without freeing the imported media.

**Combined scenario** (`e2e/combined.spec.ts`): one clip with a speed curve + In animation +
Adjust grade and colour wheel + circle mask with non-uniform scale + Robot voice filter + a mix
transition. 9 undo steps all undone with ⌘Z (back to the empty timeline) and redone with ⌘⇧Z
(byte-identical document); preview voice chain `input → voice:robot:70 → gain`; exported MP4
(H.264 720×1280 + AAC) vs the paused preview at 5 times (animation, fast part of the curve, both
sides of the cut, next clip): MAD 0.8–2.2 / 255, and every preview frame matches its own export
frame better than frames n ± 1, 2; after a reload the document is identical and the frame is
pixel-identical (MAD 0).
