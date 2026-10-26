# Our Editor — SPEC v1

A browser video editor modelled on the **CapCut desktop** app. v1 = the basics, done well. No AI.
UI text in English, dark CapCut theme, cyan accent. Default canvas **9:16 (1080×1920, 30 fps)**,
switchable to 16:9 / 1:1 / 4:5. Media never leaves the machine.

Stack (fixed): Vite + React 18 + TypeScript strict + Zustand (+ immer) + Vitest, plain CSS
variables, no backend. Export: WebCodecs via Mediabunny (installed). Target: desktop Chrome/Edge.

Sources: `docs/research/01-ui-ux.md`, `02-features.md`, `03-architecture.md`, screenshots in
`docs/capcut-screens/`. Where the research disagrees, this spec decides.

---

## 1. v1 feature list

### Project & top bar
- Top bar: `Auto saved: HH:MM:SS` (left), editable project name (centre), cyan **Export** (right, ⌘E).
- One current project, autosaved to IndexedDB 800 ms after each change (and on tab hide);
  reopened automatically with its media on reload. Missing media → "Media lost" tile.
- Aspect ratio from the player's **Ratio** menu: 9:16 (default), 16:9, 1:1, 4:5.

### Library (left panel)
- Tab bar exactly like CapCut: Media · Audio · Text · Stickers · Effects · Transitions · Captions ·
  Filters · Adjustment · Templates. **Live in v1:** Media, Audio, Text, Transitions, Filters.
  The rest are shown dimmed with "Coming soon" (keeps the structure).
- **Media:** Import button + drag files from the OS; grid of tiles (thumbnail, duration badge
  `00:10`, "Added" badge when used, "Media lost" tile). Tile `+` adds at the playhead
  (video/image → main track; audio → audio track); drag a tile onto the timeline.
- **Audio:** the imported audio files (waveform tiles), same `+`/drag.
- **Text:** "Default text" tile → text clip (3 s) at the playhead on a text track.
- **Transitions:** grid of the 11 built-in transitions (`TRANSITIONS` in `src/model/catalog.ts`);
  `+` applies to the cut after the selected clip; drag onto a cut.
- **Filters:** grid of the 10 built-in looks (`FILTERS`) + None; click applies to the selected
  visual clip(s) at intensity 100.

### Player (centre)
- Header "Player". Canvas at project resolution, letterboxed, black background.
- Bottom bar: current / total timecode `HH:MM:SS:FF` (current in cyan), Play/Pause (Space),
  **Ratio** menu, fullscreen (Esc exits).
- Real playback: video/image/text compositing, audio mixing with volume + fades, speed
  (with pitch preserved unless "Change audio pitch"), transitions, animations, filters, adjust.
- On-canvas: click selects the topmost clip; selected clip shows a box with corner scale handles
  and a rotate handle; drag to move; centre snap guides.

### Inspector (right)
Selection drives it (CapCut):
| Selection | Tabs (sub-tabs) |
|---|---|
| nothing | **Project** — name, ratio, resolution, fps, media count |
| video | **Video** (Basic) · **Audio** (Basic) · **Speed** (Standard) · **Animation** (In / Out) · **Adjust** (Basic) |
| image | Video · Animation · Adjust |
| audio | Audio · Speed |
| text | **Text** (content, font, size, colour, B/I/U, alignment, line/letter spacing, Stroke, Background, Shadow; + Transform/opacity) · Animation |
| transition | **Transition** — type grid, Duration, Apply to all, Remove |
| several clips | "N clips selected" + Delete |

- **Video › Basic:** Transform (Scale 1–400 %, Position X/Y, Rotate, Mirror H/V, align buttons:
  left/centre/right/top/middle/bottom), Blend (mode list from `BLEND_MODES`, Opacity 0–100 %).
- **Audio › Basic:** Volume −60…+20 dB (0.0 dB default), Fade in, Fade out (0…clip length), per-clip mute.
- **Speed › Standard:** speed 0.1×–100× (log slider, ticks 0.1/1/2/5/10/100), Duration field
  (`2.3s → 1.2s`, editable: back-computes speed), "Change audio pitch" toggle, Reset.
- **Animation:** In / Out sub-tabs, grid "None" + 9 animations (`ANIMATIONS`), Duration slider
  (default 0.5 s, In + Out never exceed the clip).
- **Adjust › Basic:** 11 sliders from `ADJUST_RANGES` (Temp, Tint, Saturation, Exposure,
  Brightness, Contrast, Highlights, Shadows, Sharpen, Fade, Vignette), Filter + Intensity row,
  section reset, **Apply to all** (same values to every clip of that track kind).
- Every section: checkbox where CapCut has one, collapse caret, ↺ reset. Keyframe diamonds are
  **not** shown in v1.
- Every slider gesture = one undo step (`beginTx` on pointer-down, `commitTx` on pointer-up).

### Timeline (bottom)
- **Toolbar (left → right):** Select ▾ (Select / Split mode), Undo, Redo, Split, Delete left,
  Delete right, Delete, Marker, Mirror, Rotate 90° … right side: Main-track magnet, Auto snapping,
  Zoom − / slider / +, Zoom to fit.
- **Ruler** with `MM:SS` labels that adapt to zoom; click/drag scrubs; markers as flags.
- **Playhead:** white line with handle, draggable; auto-scroll while playing.
- **Tracks:** overlays & text above the **main track** (taller, filmstrip thumbnails, Cover
  placeholder), audio tracks below (waveforms). Track header: type icon, lock, eye (visual
  tracks), speaker (tracks with sound). New tracks appear automatically; empty ones vanish.
- **Clips:** name, thumbnails/waveform, speed badge (`2.0x`) when ≠ 1, white outline + trim
  handles when selected, transition marker on cuts (click selects the transition).
- **Gestures:** click / shift-click / marquee select; drag to move (across compatible tracks; drop
  in the empty band above/below = new track); drag edges to trim; snapping to playhead, clip
  edges, markers, 0 (8 px), Alt bypasses snapping; magnet reorders the main track.
- **Zoom:** 2–600 px/s, ⌘/Ctrl+wheel and ⌘= / ⌘−, anchored at the playhead; Shift+Z fits.
- **Shortcuts:** Space play, ⌘B split, Q/W delete left/right, ⌫/Del delete, ⌘Z / ⇧⌘Z undo/redo,
  ←/→ frame step (Shift = 10 frames), ↑/↓ previous/next edit, Home/End, M marker, ⌘D duplicate,
  ⌘C/⌘V copy/paste (paste = duplicate at playhead), ⌘A select all, A/B select/split mode,
  P magnet, N snapping, V enable/disable clip, ⌘E export. Ignored while typing in a field.

### Export
- Dialog: file name, resolution (720p / **1080p** — short side), frame rate (24/25/**30**/60),
  quality (Lower / **Recommended** / Higher), format MP4 (H.264 + AAC).
- Renders frame by frame from `getFrameState` (same as the player), progress bar + cancel,
  downloads the file. Clear error if the browser lacks WebCodecs.

---

## 2. Layout and region sizes

```
┌ Top bar 40px ─ "Auto saved: 19:48:07" ─── Project name ─────────────── [Export] ┐
├ Library 28% (min 240) ┬┬ Player (flex, min 240) ┬┬ Inspector 25% (min 280) ────┤  upper = 60% of height
│ tab bar 56px          ││ header 40px            ││ tabs 40px                   │  (25–80%, drag)
│ content (scroll)      ││ canvas (letterboxed)   ││ sections (scroll)           │
│                       ││ bar 40px: tc ▶ Ratio ⛶ ││                             │
├═══════════════════════╧╧════════ splitter ═════╧╧═════════════════════════════┤
│ Timeline: toolbar 36px · ruler 26px · headers 140px | tracks 48px (main 64px)  │
└────────────────────────────────────────────────────────────────────────────────┘
```

Gutters 4px, panel radius 8px, window bg `--bg-window`, panels `--bg-panel`. All splitters
draggable; sizes persist in localStorage. Tokens are in `src/theme.css`.

---

## 3. Data model (src/model/types.ts — the source of truth)

- **Times are integer microseconds** (`Us`). Helpers in `src/model/time.ts`.
- `Project { id, name, version, settings{aspect,width,height,fps,background}, assets{id→MediaAsset},
  tracks[], markers[] }`.
- `MediaAsset { id, kind: video|audio|image, name, mime, size, duration (image 0), width, height,
  hasAudio, blobKey, missing? }`. Blobs live in IndexedDB; object URLs in `src/media/registry.ts`.
- `Track { id, kind: main|overlay|audio|text, name, locked, hidden, muted, clips[], transitions[] }`.
  **Array order = z-order** (index 0 bottom). Exactly one `main`, always the first visual track.
  Display order: `timelineRows(project)`.
- `Clip` = `VideoClip | ImageClip | AudioClip | TextClip`, all with `id, type, trackId, name,
  start, duration, disabled`.
  - visual clips: `transform {scale(1=fit), x, y, rotation°, opacity 0..1, flipH, flipV}`,
    `crop`, `blend`, `animationIn/Out {type, duration} | null`, `filter {id, intensity 0..1} | null`,
    `adjust {brightness, contrast, saturation, exposure, temperature, tint, highlights, shadows,
    fade, vignette, sharpen}`.
  - timed media (video, audio): `assetId, inPoint, speed 0.1..100, preservePitch`; source span =
    `[inPoint, inPoint + duration × speed]`.
  - video/audio: `audio {volumeDb −60..20, fadeIn, fadeOut, muted}`.
  - text: `text {content, fontFamily, fontSize(px), color, bold, italic, underline, align,
    lineHeight, letterSpacing, stroke{enabled,color,width}, background{enabled,color,opacity},
    shadow{enabled,color,blur,offsetX,offsetY}}`.
- `Transition { id, type, fromClipId, toClipId, duration }` on the track; clips must be adjacent;
  centred on the cut; max = half the shorter clip; timeline length unchanged.
- Defaults: image 5 s, text 3 s, animation 0.5 s, transition 0.5 s (`src/model/defaults.ts`).
- Catalogues (aspects, animations, transitions, blend modes, filters, adjust ranges, fonts,
  limits): `src/model/catalog.ts`.

### Store (src/store/index.ts) — `useEditor`
State: `project, past, future, txBase, selection{clipIds, transitionId}, playhead, playing, zoom,
magnet, snapping, saveStatus`. Only `project` is undoable/persisted.

Actions: `newProject setProject setProjectName setAspectRatio · addAssets importFiles removeAsset
setAssetsMissing · addClip addTextClip moveClip trimStart trimEnd splitAtPlayhead splitClip
deleteLeft deleteRight deleteClips deleteSelected duplicateClips duplicateSelected updateClip
updateClips setSpeed setDuration mirrorSelected rotateSelected setAnimation · addTransition
updateTransition removeTransition applyTransitionToAll · addTrack removeTrack setTrack ·
addMarker removeMarker · select selectTransition selectAll clearSelection · setPlayhead stepFrames
goToPrevEdit goToNextEdit play pause togglePlay · setZoom zoomIn zoomOut setMagnet setSnapping ·
undo redo beginTx commitTx cancelTx · setSaveStatus`.
Selectors in `src/store/selectors.ts`. Autosave/boot in `src/store/autosave.ts` (wired in App).

Editing rules enforced by `normalize()` after every edit: clips sorted and non-overlapping (later
clips pushed right), main track packed from 0 while the magnet is on, animations/fades fit the
clip, transitions pruned/clamped, integer times. Locked tracks refuse edits and selection.

---

## 4. Area ownership (parallel builders)

| Area / builder | Owns (may create/edit) | Reads (must not edit) |
|---|---|---|
| **A — Library + Inspector** | `src/panels/**`, `src/inspector/**`, `src/ui/controls.tsx`, new files in `src/media/` for thumbnails & waveforms (e.g. `thumbnails.ts`, `waveform.ts`) | model, store, `media/registry.ts`, `media/import.ts` |
| **B — Timeline** | `src/timeline/**` (toolbar, ruler, headers, clips, gestures, snapping UI, zoom, playhead, markers, transition markers, keyboard shortcuts in `src/timeline/shortcuts.ts`, the drop target for library drags) | model, store, A's thumbnail/waveform helpers (import only) |
| **C — Player + Render + Export** | `src/player/**`, `src/engine/**` **except** `frameState.ts(+test)`, `src/export/**` | model, store, `engine/frameState.ts`, `media/registry.ts` |
| Architect / QA | `src/model/**`, `src/store/**`, `src/engine/frameState.ts`, `src/media/import.ts`, `src/media/registry.ts`, `src/App.tsx`, `src/main.tsx`, `src/theme.css`, `package.json`, `docs/integration-notes/*` (applies requests) | — |
| Shared, append-only | `src/ui/icons.tsx`, `src/ui/Icon.tsx`, `src/ui/primitives.tsx(.css)` (UI kit) | — |

Contracts between builders:
- **Drag from library → timeline:** `dataTransfer` type `application/x-our-editor` with JSON
  `{ kind: 'asset', assetId }` | `{ kind: 'text' }` | `{ kind: 'transition', type }`. A sets it,
  B handles the drop (asset → `addClip(assetId, {at, trackId|kind})`, transition → nearest cut).
- **Selection** lives in the store; the player (C) selects on canvas click, the timeline (B) on
  clip click, the inspector (A) reacts.
- **Playback clock:** C owns it. While playing C writes `setPlayhead` ~15–30×/s; B only reads
  `playhead` (and calls `setPlayhead` when scrubbing).
- **Keyboard:** B owns the global shortcut handler (mounted by `Timeline`); ⌘E is in App.
- **Gestures:** every drag/slider wraps `beginTx()` … `commitTx()` (Escape → `cancelTx()`).
- Store/model changes go through `docs/integration-notes/<area>.md` (see its README).
- Each builder: `npm run typecheck && npm test && npm run build` green before handing back;
  add Vitest tests for your pure helpers.

---

## 5. v2 backlog (researched, deferred)

Editing: keyframes (`‹ ◇ ›` on every row; transform, opacity, volume first), crop dialog
(model field exists), freeze frame, reverse, replace clip, detach/extract audio + linkage,
split-all-tracks ⇧⌘B, select-left/right `[`/`]`, group/compound clips, ripple delete for
non-main tracks, multi-clip drag, right-click context menu, preview axis (hover scrub), cover
picker, ~~project home screen (list/rename/delete projects)~~ — built 2026-10-20 (src/home/),
project fps/resolution picker,
Original ratio (follow first clip) and more ratios (4:3, 2.35:1, 3:4 …).
Look: Speed › Curve (Montage, Hero, Bullet, Jump cut, Flash in/out, Custom), Combo animations,
more In/Out animations, more transitions, LUT import (.cube), HSL / Curves / Color wheel,
Whites/Blacks/Brilliance/Clarity/Grain, WebGL colour pipeline, filters & adjustments as timeline
layer segments, Save as preset, masks, canvas background (colour/blur/image), stickers, video
effects, text templates / word art / style presets, inline text editing on the canvas.
Audio: volume keyframes, normalize loudness, fill channel, voice-over recording, time-stretch in
export for pitch-preserved speed changes.
Captions: manual caption track, SRT import/export.
Export: 2K/4K, HEVC/AV1, MOV, GIF, audio-only (MP3/WAV), export in a Worker, MediaRecorder
fallback for non-WebCodecs browsers.
UI: layout presets, shortcut list modal, player quality menu, safe-area guides, library search /
sort / favourites, stock libraries.

**Out (AI — not planned):** Remove BG, AI remove/expand, enhance quality, noise reduction,
stabilize, smooth slow-mo / optical flow, auto adjust, color match/correction, skin protection,
enhance/isolate voice, translator, auto captions, text-to-speech, smart suggestions / global
edits, AI clipper, Dreamina, generate, AI stylize, EditPilot, body effects, auto reframe.
