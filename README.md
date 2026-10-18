# Our Editor

A browser video editor modelled on the **CapCut desktop** app: dark theme, CapCut's layout
(library left, player centre, inspector right, timeline below) and CapCut's interaction model.
v1 is the basics, done well. It has no AI features and no backend, and media never leaves the machine.

Projects are vertical (**9:16**) by default. You can switch them to 16:9, 1:1, 4:5 or 3:4.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Use a Chromium browser (Chrome, Edge, Arc). Export needs WebCodecs. Other browsers fall back to a
real-time WebM export.

| Command | What it does |
|---|---|
| `npm run dev` | dev server |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Vitest unit + component tests |
| `npm run build` | typecheck + production build into `dist/` |
| `cd e2e && npm install && npx playwright install chromium && E2E_PORT=5391 npx playwright test` | end-to-end flows in real Chromium (needs `test-media/`, see `test-media/README.md`, and `ffprobe` on PATH) |

## What v1 does

**Top bar**
- Auto-save status
- Editable project name
- **Export** (⌘E)
- **Keyboard shortcuts** panel (keyboard icon)

**Library (left)**
- Ten CapCut tabs. Media, Audio, Text, Transitions, Filters and Adjustment work. Stickers, Effects,
  Captions and Templates show "Coming soon".
- **Media:**
  - Import video, audio and images with the button or by dropping files on the panel.
  - Tiles show thumbnails, real audio waveforms, a duration badge, an "Added" badge and a
    "Media lost" state.
  - Search, grid/list view and sort.
  - The hover "+" adds a file at the playhead; tiles can also be dragged to the timeline.
  - Right-click → Delete.
- **Text:** "Default text" plus 9 styled presets (click or drag).
- **Transitions:** 11 transitions.
- **Filters:** 10 looks.
- **Adjustment:** 11 adjust presets.

**Player (centre)**
- Canvas preview that renders exactly what the export renders.
- `HH:MM:SS:FF` current/total timecode.
- Play/Pause (Space).
- Zoom (Fit/50/150/200 %), **Ratio** menu and full screen.
- Click a clip in the preview to select it. Drag to move it (with centre guides); corner handles
  scale it and the round handle rotates it.
- **Preview axis (S):** while paused, hovering the timeline shows that frame.

**Inspector (right)**
- **Video › Basic:**
  - Scale, position, rotate (with a dial), the six align buttons and mirror.
  - Blend mode and opacity, with an on/off checkbox.
- **Audio:** Volume (dB), fade in and fade out.
- **Speed › Standard:** 0.1×–100×, editable duration, and "Change audio pitch".
- **Animation:** In / Out (9 each) with a duration.
- **Adjust:** a Filter with intensity, and 11 sliders with an on/off checkbox. Apply to all.
- **Text:** content, font, size, colour, B/I/U, alignment, spacing, and stroke / background / shadow.
- **Transition:** type, duration, Apply to all and Remove.
- **Project:** shown when nothing is selected (name, ratio, details).
- Every slider drag or typing session is one undo step.

**Timeline (bottom)**
- **Toolbar:** select/split tool, undo/redo, split, delete left/right, delete, marker, mirror,
  rotate; magnet, snapping, linkage, preview axis, zoom slider and fit.
- **Tracks:** main track (magnetic), overlay tracks above it, text tracks above those, audio tracks
  below. Dropping on the empty space above or below the tracks creates a new track.
- **Track headers:** lock, hide, mute and the Cover tile.
- **Clips:**
  - Filmstrip thumbnails, waveforms, speed badges and animation/fade ramps.
  - Trim with the edge handles. Move with snapping (Alt turns snapping off).
  - Moving a clip that is part of a multi-selection moves the whole selection.
  - Marquee selection.
- **Shortcuts:** CapCut desktop's set. The keyboard icon next to **Export** opens the full list,
  grouped like CapCut's panel. Mac shows ⌘ ⇧ ⌥ and Windows shows Ctrl / Shift / Alt. The list, the key
  handler and the toolbar tooltips all come from one table, `src/timeline/shortcutDefs.ts`.

  | Group | Keys (Mac; on Windows Ctrl replaces ⌘ and Alt replaces ⌥) |
  |---|---|
  | Essentials | Space play/pause · ⌘B split · ⇧⌘B split all tracks · Q / W delete left / right · ← / → one frame · ↑ / ↓ previous / next edit · ⇧Z fit timeline · ⌘E export |
  | Tools | A / B select / split tool · `[` / `]` select clips left / right of the playhead · ⌫ delete · V enable/disable · M marker · I / O mark in / out · ⇧X area = selected clips · ⌥X clear area |
  | Timeline & preview | ⇧← / ⇧→ 10 frames · Home / End · ⌘= / ⌘− zoom · ⌃⌘F or ⇧⌘F full-screen preview (Esc exits) · ⌥⇧Z fit preview to window · S preview axis · Esc cancel / clear area / deselect |
  | Audio & speed | ⇧⌘S extract / restore audio · ⌘R Speed tab · ⇧B Speed › Curve · ⌘. / ⌘, volume ±1 dB · P magnet · N snapping · ~ linkage |
  | Project & clipboard | ⌘I import · ⌘Z / ⇧⌘Z undo / redo · ⌘C / ⌘X / ⌘V copy / cut / paste at the playhead · ⌘D duplicate · ⌘A select all · Tab / ⇧Tab next / previous library tab |
  | Coming soon (toast) | ⌘G / ⇧⌘G group / ungroup · ⌥G / ⌥⇧G compound clip · ⌘J match cut · ⌥K keyframes · Return split caption |

  Shortcuts match the physical key, so they also work on a Hebrew keyboard and with ⌥ combos. They
  are ignored while you type in a text field (except ⌘E) and while a dialog is open. ⌘N and ⌘Q
  belong to the browser and cannot be taken by a web page.

**Persistence**
- The project JSON and the media blobs live in IndexedDB.
- The project autosaves 0.8 s after each change and reloads on the next visit.

**Export**
- MP4: H.264 + AAC, muxed with Mediabunny and frame-exact.
- 720p / 1080p / 2K / 4K, bit rate Lower / Recommended / Higher, 24/25/30/50/60 fps.
- Progress bar, Cancel, and the browser download.

## Architecture

```
src/
  model/        types.ts (the JSON document, µs integers), defaults, catalog (ratios, filters,
                transitions…), time helpers, project helpers + load-time migration
  store/        useEditor (Zustand + immer): every action, undo/redo, transactions (one gesture =
                one undo step), ops.ts (pure edit operations + normalize), IndexedDB persistence,
                autosave/boot
  engine/       frameState.ts — THE render contract: (project, t) → what to draw / hear
    render/     renderFrame (canvas 2D compositor shared by player and export), colour, text layout
  media/        import (probe + store blobs), registry (asset → object URL), cleanup on asset removal
  panels/       left Library (tabs, media bin, text/transition/filter/adjust presets)
  inspector/    right Inspector (tabs by selection) + reusable controls
  player/       Player UI, PreviewEngine (rAF + AudioContext clock), media pool, audio engine
  timeline/     Timeline, toolbar, ruler, track headers, clips, gestures, DnD, shortcuts,
    media/      filmstrip thumbnails + waveform peaks caches
  export/       Export dialog, runExport (offline audio mix → render every frame → mux), WebM fallback
  ui/           icons, primitives, shared controls
  App.tsx       layout shell (resizable splitters)
e2e/            Playwright flows (smoke + full editing walk-through, screenshots in e2e/screens/)
docs/           SPEC-v1.md, research/, integration-notes/, QA-REPORT.md, capcut-screens/
```

The player and the exporter both call `getFrameState(project, t)` and then `renderFrame`, so the
preview and the export cannot drift apart. All edits go through store actions, so all of them can
be undone.

## v2 backlog

See **[docs/SPEC-v1.md § 5 — v2 backlog](docs/SPEC-v1.md#5-v2-backlog-researched-deferred)**:

- **Editing:** keyframes, crop UI, the right-click menu, Speed curves, Combo animations and masks.
- **Colour:** HSL/Curves and a WebGL colour pipeline.
- **Content and project:** stickers/effects, captions, and a project home screen.

Known v1 limits are listed in [docs/QA-REPORT.md](docs/QA-REPORT.md).
