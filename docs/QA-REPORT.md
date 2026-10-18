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
