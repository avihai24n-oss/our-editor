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
- **Home** (house icon): saves the project and opens the project gallery
- Auto-save status
- Editable project name
- **Export** (⌘E)
- **Keyboard shortcuts** panel (keyboard icon)

**Library (left)**
- Ten CapCut tabs. Media, Audio, Text, Transitions, Filters and Adjustment work. Stickers, Effects,
  Captions and Templates show "Coming soon".
- **Media:**
  - Import video, audio and images with the button, or drag files from Finder / the desktop
    **anywhere on the window**: the window dims ("Drop files to import") and the files go to the
    Media pool, which opens and briefly highlights the new tiles. Dropped on the timeline, they are
    also placed at the drop point. Unsupported files are skipped with a toast.
  - Tiles show thumbnails, real audio waveforms, a duration badge, an "Added" badge and a
    "Media lost" state.
  - Search, grid/list view and sort.
  - The hover "+" adds a file at the playhead; tiles can also be dragged to the timeline.
  - Right-click → Delete (or Delete / Backspace on a focused tile). Deleting removes the file and
    its clips as one undo step: ⌘Z brings both back.
  - Importing a file that is already in the pool does not add it twice. Importing a "Media lost"
    file again relinks it.
  - Functional audit of every Library control: [docs/AUDIT-library.md](docs/AUDIT-library.md).
- **Text:** "Default text" plus 9 styled presets (click or drag).
- **Transitions:** 11 transitions.
- **Filters:** 10 looks (rendered by the same colour pipeline as Adjust; tiles preview the real look).
- **Adjustment:** 11 adjust presets, plus **My presets** saved from the inspector (localStorage).

**Player (centre)**
- Canvas preview that renders exactly what the export renders.
- `HH:MM:SS:FF` current/total timecode.
- Play/Pause (Space).
- Zoom (Fit/50/150/200 %), **Ratio** menu and full screen.
- **Scopes** (bar button): Waveform, RGB Parade, Vectorscope (75 % targets, skin tone line) and
  Histogram of the graded frame on screen, live while scrubbing and playing (≈12 analyses/s on a
  ≤ 480 px read-back). **Split**: before / after with a draggable divider (left = no colour).
- Click a clip in the preview to select it. Drag to move it (with centre guides); corner handles
  scale it and the round handle rotates it.
- **Preview axis (S, on by default like CapCut):** an amber line follows the mouse over the
  timeline and the player shows that frame while paused. The white playhead moves only on a click,
  a drag, the keys or playback.

**Inspector (right)**
- **Video** (video and image clips), sub-tabs like CapCut:
  - **Basic:** Transform (scale with **Uniform scale** on/off → separate width / height, position,
    rotate with a dial, the six align buttons, mirror); Blend (11 modes incl. Linear burn, opacity,
    on/off); **Canvas** for main-track clips (Color / Blur 1–4 / Image behind the clip, Apply to
    all). CapCut's AI sections (Stabilize, Enhance quality, Reduce image noise, Optical flow, AI
    remove, AI expand, Retouch) are shown switched off as "Coming soon".
  - **Remove BG:** Chroma key (colour + eyedropper, Intensity, Shadow). Auto / Custom removal are AI
    and shown as "Coming soon".
  - **Mask:** None, Linear, Mirror, Circle, Rectangle, Heart, Star with position, rotate, size,
    feather, round corners and invert, plus on-canvas handles (move, size, rotate, feather).
- **Audio › Basic:** Volume (dB), fade in, fade out, Normalize loudness (−23 LUFS, BS.1770),
  Reduce noise (DSP high-pass + noise gate, not AI), **Isolate voice (DSP, not AI)** — keep the
  voice (noise-profile Wiener suppression + 100 Hz–8 kHz emphasis + gentle gate) or keep the
  background (approximate centre-channel cut), Strength 0–100, also on the clip right-click menu as
  "Voice isolation (DSP)" — and Fill channel (left / right → both). Enhance voice and Video
  translator are shown disabled (AI, coming soon).
- **Export frame** (player bar ⋯ › Export frame…): the frame at the playhead as PNG / JPEG / WebP
  (quality for the lossy two), at the project's size, drawn by the export renderer, with a preview.
  Saved by the editor's server (`vite-plugins/saveFiles.js`) into a folder on this Mac: default
  ~/Downloads, "Change…" opens Finder's folder dialog (remembered). Chrome's own folder picker is not
  used: it refuses Downloads / Desktop as "system folders". Never overwrites ("(2)"); only inside the
  home folder. Without the server it downloads. `src/export/exportFrame.ts`.
- **Volume keyframes** (Audio › Basic › Volume ‹ ◇ ›): ◇ adds a keyframe at the playhead (filled = one
  is there, click removes it), ‹ › jump between them, the slider / number box edit the key under the
  playhead (adding one). Linear in dB between keys, flat outside; keys sit on the source, so trims,
  splits and speed changes keep them on their sound. Preview and export use the same envelope
  (`src/model/volumeKeys.ts`).
- **Motion keyframes** (Video / Text › Transform and Blend, added 26 Oct 2026): ‹ ◇ › on Scale,
  Position, Rotate and Opacity, and a section ◇ on Transform that keys position + scale + rotation
  at once (⌥K does the same for the selected clip). Like volume: editing a keyed row — or dragging,
  scaling, rotating the clip on the player canvas — sets the key under the playhead (adding one;
  one undo step per drag); with the playhead off the clip it moves all keys of that property.
  "Keyframe curve" (shown with a key under the playhead): Linear (default, as CapCut), Ease in,
  Ease out, Ease in-out — the curve from that key to the next. Position moves on a straight line,
  rotation is numeric (0 → 360° = one full turn). Accent diamonds on the timeline clip: click = go
  there, drag = move in time, double-click = remove. "Ken Burns › Zoom in / Zoom out" (video,
  image) keys a slow 100 → 115 % zoom with a small drift over the whole clip. Keys sit on the
  content (video: source time; image / text: time from the left edge, shifted by trims and
  splits), interpolated in `getFrameState`, so preview and export match (`src/model/motionKeys.ts`).
- **Volume line on the timeline** (every clip with sound): drag up/down for the volume. 100 % rests a
  third up; the top two thirds are boost up to +20 dB (1000 %). Double-click = 100 %. With keyframes
  the line follows the envelope and shows diamonds: drag a diamond up/down, drag the line to move all
  keys, double-click the line to add a key, double-click a diamond to remove it.
- **Audio › Voice changer:** 11 DSP voice filters (Chipmunk, High, Low, Deep, Robot, Electronic,
  Echo, Megaphone, Distorted, Vinyl, Big hall) with a Strength slider; AI voice characters and
  Speech to song are disabled. Preview and export run the same Web Audio graph.
  - **Spaces / Eras & devices / Character** (added 26 Oct 2026), for placing a voice in a scene:
    Small room, Studio booth, Tiled room, Stone hall (synagogue), Big hall, Cathedral, Outdoors, Far
    away, Behind a door · Telephone, Walkie-talkie, Old radio, Gramophone, Megaphone, Vinyl ·
    Announcer, Close & intimate, Inner voice, Memory, Underwater. Reverbs use a seeded room impulse
    (pre-delay, early reflections, highs absorbed over time); devices have 24 dB/oct band edges on
    both sides of their drive. Strength = how much.
  - **Mixer** (channel strip after the voice filter): low / high cut, 3-band EQ, compressor (+makeup),
    warmth (saturation), delay, reverb (decay, pre-delay, damping, mix), output; each section has its
    own switch; presets Clean voice-over / Warm narrator / Documentary / Epic trailer. Same graph in
    preview and export. Measured in e2e/voice-fx.spec.ts (OfflineAudioContext renders).
- **Speed › Standard:** 0.1×–100× on CapCut's six-tick slider, editable duration, "Change audio
  pitch", Reset. **Speed › Curve:** None, Custom, Montage, Hero, Bullet, Jump cut, Flash in and
  Flash out, with a graph editor (drag points between 0.1× and 10× on a log axis, add / delete a
  point at the playhead or by double-click, Reset, resulting duration). Curves drive the preview,
  the export frames and the exported audio (pitch kept unless "Change audio pitch" is on), split
  and trim. Smooth slow-mo (AI) is shown disabled, like CapCut without it.
- **Animation:** CapCut's In / Out / Combo (video, image) and In / Out / Loop (text): 53 In,
  53 Out, 18 Combo and 15 text Loop animations (fade, zoom, slides, rotate, flips, swing, shake,
  jelly, bounce, drop, fly, stretch, blur, flash, glow, RGB split, slices, jitter, wipes, circle,
  iris, mid-split, blinds, 3D flips/door/cube, typewriter…). Search, category chips, ☆ favourites,
  live canvas thumbnails on hover, a one-shot player preview on click, and a Duration (Loop: Speed)
  slider. In + Out never exceed the clip; Combo replaces In/Out. One catalogue,
  `src/engine/animations.ts`, drives the player, the export and the thumbnails.
- **Adjust** (CapCut's five sub-tabs, all on a WebGL2 colour pass shared by player and export,
  with a CPU fallback):
  - **Basic:** Auto adjust / Color match / Color correction shown disabled (AI, coming soon);
    Filter + intensity; **LUT** (import `.cube` 3D/1D files, intensity, protect skin tone);
    **Adjust** — Temp, Tint, Saturation · Exposure, Brightness, Contrast, Highlights, Shadows,
    Whites, Blacks, Brilliance · Sharpen, Clarity, Particles (grain), Fade, Vignette.
  - **HSL:** 8 colour ranges × Hue / Saturation / Lightness.
  - **Curves:** Luma + R / G / B with draggable points (monotone cubic).
  - **Color wheel:** Lift, Gamma, Gain, Offset wheels, each with a luminance slider.
  - **Mask:** limit the adjustment to a Linear / Mirror / Circle / Rectangle shape (position,
    rotation, size, feather, roundness, invert).
  - Every section has a checkbox and a reset; **Apply to all** and **Save as preset**.
  - **Color** (DaVinci Resolve–style colour page, `src/engine/color/colorStage.ts`, same shader
    in preview and export): **Primaries** — the Lift / Gamma / Gain / Offset wheels (the Color wheel
    data, with R/G/B readouts and a Master slider) and the bar: Contrast + Pivot (S-curve, no
    clipping), Temp (Kelvin, Planckian) / Tint in linear light, Saturation, Hue, Color boost,
    Shadows / Highlights, Midtone detail, Lum mix; **Log wheels** (Shadow / Midtone / Highlight with
    Low / High range); **HSL curves** (Hue vs Hue / Sat / Lum, Lum vs Sat, Sat vs Sat; hue curves
    wrap, swatches add anchored points); **Qualifier** secondary (HSL key with soft edges, matte
    finesse, invert, power window, eyedropper on the player — Shift adds —, Show matte, and a
    correction inside the matte); **Color space transform** (LogC3 / S-Log3 / V-Log → Rec.709,
    Rec.709 → log); **Copy / Paste grade** (paste onto a multi-selection from the Selection
    inspector, one undo step); **Gallery** (grab still with a thumbnail, per browser) and six
    built-in film looks previewed on the current frame. Older projects load with a neutral page
    (Lum mix 0 keeps their wheel look).
- **Text:** content, font, size, colour, B/I/U, alignment, spacing, and stroke / background / shadow.
- **Transition:** type, duration, Apply to all and Remove.
- **Project:** shown when nothing is selected (name, ratio, details).
- Every slider drag or typing session is one undo step.

**Timeline (bottom)**
- **Toolbar:** tool dropdown (Select A, Split B, Select leftward `[`, Select rightward `]` — CapCut's four cursor tools, each with its own cursor; see `docs/research/07-tool-modes.md`), undo/redo, split, delete left/right, delete, marker, mirror,
  rotate; magnet, snapping, linkage, preview axis, zoom slider and fit.
- **Magnet on other tracks too:** with the magnet on, trimming a clip on an overlay or audio track
  ripples like the main track: a left-edge trim keeps the clip's start (it sticks left) and the clips
  after it on that track move by the trimmed amount; a right-edge trim pulls them along. Gaps the user
  left are kept, and nothing is packed. Magnet off: the CapCut behaviour (the edge leaves a gap).
- **Tracks:** main track (magnetic), overlay tracks above it, text tracks above those, audio tracks
  below. Dropping on the empty space above or below the tracks creates a new track.
- **Clip menu › Edit** (`src/actions/editMenu.ts`, registered in the clip context-menu registry):
  Mirror, Rotate 90°, Crop (dialog with Free / 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 4:5), Reverse
  (preview and export, picture and sound), Freeze (3 s still of the playhead frame, clip split around
  it) and Replace clip. Each is one undo step. See `docs/research/08-context-edit-menu.md`.
- **Track headers:** lock, hide, mute and the Cover tile.
- **Clips:**
  - Filmstrip thumbnails, speed badges and animation/fade ramps.
  - **Audio lane:** every video clip that carries sound shows its own waveform along the bottom of
    the filmstrip (CapCut's lane). It is the clip's sound, so it follows the clip's volume, fades,
    speed and Reverse, and goes flat when the clip is muted or its audio is extracted. A video
    without an audio track has no lane, and neither does a clip too short to keep the filmstrip
    readable. Audio clips keep their own full-height waveform.
  - Trim with the edge handles. Move with snapping (Alt turns snapping off).
  - Moving a clip that is part of a multi-selection moves the whole selection.
  - Marquee selection.
- **Compound clips (subprojects):** select clips, even across tracks, then press ⌥G or right-click
  › *Create compound clip*. They become one clip, striped purple with a stack icon, in their
  main-track slot.
  - Double-click opens it as a nested timeline, with a breadcrumb "Main › Compound 1" to get back.
    Edits inside show in every instance.
  - ⌥⇧G puts the clips back exactly.
  - Media › Subprojects lists every compound clip; drag one to the timeline for another instance.
  - The compound clip's transform, opacity, blend, animations and adjust apply to the nested
    picture as a whole.
  - See docs/research/10-compound-clips.md.
- **Shortcuts:** CapCut desktop's set. The keyboard icon next to **Export** opens the full list,
  grouped like CapCut's panel. Mac shows ⌘ ⇧ ⌥ and Windows shows Ctrl / Shift / Alt. The list, the key
  handler and the toolbar tooltips all come from one table, `src/timeline/shortcutDefs.ts`.

  | Group | Keys (Mac; on Windows Ctrl replaces ⌘ and Alt replaces ⌥) |
  |---|---|
  | Essentials | Space play/pause · ⌘B split · ⇧⌘B split all tracks · Q / W delete left / right · ← / → one frame · ↑ / ↓ previous / next edit · ⇧Z fit timeline · ⌘E export |
  | Tools | A Select tool · B Split tool (click a clip to cut it) · `[` / `]` Select leftward / rightward tool (selects left / right of the playhead, then of each click) · Esc back to Select · ⌫ delete · V enable/disable · M marker · I / O mark in / out · ⇧X area = selected clips · ⌥X clear area |
  | Timeline & preview | ⇧← / ⇧→ 10 frames · Home / End · ⌘= / ⌘− zoom · ⌃⌘F or ⇧⌘F full-screen preview (Esc exits) · ⌥⇧Z fit preview to window · S preview axis · Esc cancel / clear area / deselect |
  | Audio & speed | ⇧⌘S extract / restore audio · ⌘R Speed tab · ⇧B Speed › Curve · ⌘. / ⌘, volume ±1 dB · P magnet · N snapping · ~ linkage |
  | Project & clipboard | ⌘I import · ⌘Z / ⇧⌘Z undo / redo · ⌘C / ⌘X / ⌘V copy / cut / paste at the playhead · ⌘D duplicate · ⌘A select all · Tab / ⇧Tab next / previous library tab |
  | Compound clips | ⌥G create compound clip · ⌥⇧G undo compound clip |
  | Keyframes | ⌥K add / remove the selected clip's Transform keyframes at the playhead |
  | Coming soon (toast) | ⌘G / ⇧⌘G group / ungroup · ⌘J match cut · Return split caption |

  Shortcuts match the physical key, so they also work on a Hebrew keyboard and with ⌥ combos. They
  are ignored while you type in a text field (except ⌘E) and while a dialog is open. ⌘N and ⌘Q
  belong to the browser and cannot be taken by a web page.

**Add files to a project's Media pool from the shell / an agent** (dev server only)
- `scripts/add-media.sh [--aspect 16:9] "<project name>" <file>...` drops a request in
  `~/.our-editor/inbox/`; the open editor polls it every 2 s (`src/import/inbox.ts`), opens or creates the
  project by name, imports the files through the normal import, saves, and acks (`inbox/done/`). The script
  starts the server / editor window when needed and prints the result JSON. Agents: the `our-editor-media` skill.

**Import a CapCut project** (dev server / `vite preview` only)
- Top bar › *Import CapCut project…* or open `/?importCapcut=<draft folder>` (e.g. `/?importCapcut=1018`).
  Reads `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<folder>/draft_info.json` READ-ONLY,
  loads the media through the normal import, builds and saves the project, and shows a report of
  what came over exactly, what was approximated and what was dropped.
- Converter: `src/import/capcut/convert.ts` (pure, unit-tested on a copy of a real draft). Local
  file access: `vite-plugins/localFiles.js` (`/__local/capcut/projects`, `/__local/capcut/project?id=`,
  `/__local/file?path=` with Range; localhost only, only under ~/Movies/CapCut and ~/Desktop/ai/).

**Home screen** (the house icon in the top bar)
- Every project stored in this browser, newest first: cover frame (the last frame you had in the
  player), name, ratio, clip count, duration and when you last edited it.
- **New project**, click a card to open it, click a name to rename it, and ⋯ → Rename / Duplicate
  (media is shared, not copied) / Delete (with a confirmation).
- Search appears past six projects.
- Leaving the editor for the gallery saves the project first, so it is as safe as a refresh.
- The app itself always opens in the editor, on the project you left.

**Persistence** — *your work is never lost*
- **Project library on disk** (`~/.our-editor/library`, dev server / `vite preview`): every save is
  mirrored there (project JSON, view + cover, media blobs once), and every boot merges it both ways,
  newest wins, deletions included. So the home screen shows the same projects in any Chrome profile or
  browser on this machine; a fresh profile opens the newest project, and media comes over on demand.
  Code: `vite-plugins/projectStore.js`, `src/store/diskSync.ts`. e2e runs use a temp library, opt-in
  per context (cookie `oe-library=1`). Blobs on disk are never swept.
- The project JSON and the media blobs live in IndexedDB. A media file is written once, at import.
- The project JSON autosaves 0.8 s after each change (at most one write per 2 s, skipped when
  nothing changed) and reloads on the next visit. An idle tab writes nothing.
- It is also flushed whenever the page is hidden or unloaded (`pagehide`, `beforeunload`,
  `visibilitychange`) — unconditionally, so a change the debounce has not written yet still lands.
- An IndexedDB write started while the tab is closing is not guaranteed to commit, and a crash
  sends no event at all. So every save first writes the same JSON synchronously to localStorage
  and clears it once IndexedDB has committed. A leftover snapshot is work that never reached the
  database: the next boot commits it before loading (unless the stored project is newer).
- Where you were in each project — playhead, timeline zoom, selected clips and the cover frame —
  is saved beside it (IndexedDB store `views`) and restored when it reopens. Playback writes
  nothing; the view is saved once it stops. A playhead past the end or a selection whose clips are
  gone is dropped instead of restored.
- Switching projects saves the one you leave, releases its media (object URLs and caches) and only
  then hands the new document to the store, so the player never renders a project without its
  media. Opening a project clears the undo history.
- An open compound clip is saved closed; reopening the project shows the main timeline.

**Memory limits** (all in `src/media/memory.ts`; measurements in `docs/QA-REPORT.md` § Memory)
- Preview: at most 6 hidden `<video>` and 8 `<audio>` elements; anything the current frame does not
  use is released 3 s later, also while paused. A hidden tab pauses and releases every decoder.
- Caches are byte-budgeted LRUs: filmstrip thumbnails 150 MB, library posters 24 MB, waveform
  peaks 32 MB. Waveforms are decoded by streaming the file (Mediabunny), never the whole file.
- Undo: 200 steps and about 64 MB of snapshots.
- A watchdog reads the JS heap every 30 s; past 1.5 GB it clears the caches and shows
  "Memory high — caches cleared". Open the app with `?debug=1` for a live memory readout in the
  top bar.

**Export**
- MP4: H.264 + AAC, muxed with Mediabunny and frame-exact.
- 720p / 1080p / 2K / 4K, bit rate Lower / Recommended / Higher, 24/25/30/50/60 fps.
- Progress bar, Cancel, and the browser download.
- Speed-changed audio keeps its pitch (one WSOLA time-stretch for standard speed and curves), the
  mix goes through a peak limiter, and a stalled browser decoder / encoder fails the export with a
  message after 20 s instead of hanging.

## Architecture

```
src/
  model/        types.ts (the JSON document, µs integers), defaults, catalog (ratios, filters,
                transitions…), time helpers, project helpers + load-time migration
  store/        useEditor (Zustand + immer): every action, undo/redo, transactions (one gesture =
                one undo step), ops.ts (pure edit operations + normalize), IndexedDB persistence,
                autosave/boot
  audio/        clip FX chain (dsp.ts) + AudioWorklets shared by preview and export, BS.1770
                loudness (loudness.ts) and the streamed per-span measurement cache (measure.ts)
  engine/       frameState.ts — THE render contract: (project, t) → what to draw / hear
    render/     renderFrame (canvas 2D compositor shared by player and export), colour, text layout,
                masks, chroma key
    color/      WebGL2 colour grader (+ CPU fallback): LUT, HSL, curves, wheels, adjust mask
    animations.ts  the animation catalogue (In / Out / Combo / Loop) used by player, export, thumbs
  media/        import (probe + store blobs), registry (asset → object URL), cleanup on asset removal
  home/         home screen (project gallery) + the route between it and the editor
  panels/       left Library (tabs, media bin, text/transition/filter/adjust presets)
  inspector/    right Inspector (tabs by selection) + reusable controls
  player/       Player UI, PreviewEngine (rAF + AudioContext clock), media pool, audio engine
  timeline/     Timeline, toolbar, ruler, track headers, clips, gestures, DnD, shortcuts,
    media/      filmstrip thumbnails + waveform peaks caches
  export/       Export dialog, runExport (offline audio mix → render every frame → mux), WebM fallback
  ui/           icons, primitives, shared controls
  App.tsx       layout shell (resizable splitters)
e2e/            Playwright flows, audits (audit-*.spec.ts, helpers in audit-helpers.ts → audit/),
                per-tab specs (tab-*.spec.ts), combined.spec.ts (every feature on one clip);
                run one spec at a time: `cd e2e && E2E_PORT=5190 npx playwright test smoke.spec.ts`
docs/           SPEC-v1.md, research/, integration-notes/, QA-REPORT.md, capcut-screens/
```

The player and the exporter both call `getFrameState(project, t)` and then `renderFrame`, so the
preview and the export cannot drift apart. All edits go through store actions, so all of them can
be undone.

## v2 backlog

See **[docs/SPEC-v1.md § 5 — v2 backlog](docs/SPEC-v1.md#5-v2-backlog-researched-deferred)**:

- **Editing:** keyframes for other properties (mask, adjust, …), crop UI, the right-click menu, Velocity effects.
- ~~Combo animations, masks, HSL / Curves and a WebGL colour pipeline~~ — built 2026-10-19.
- **Content and project:** stickers/effects and captions.
- ~~Project home screen (list / open / rename / duplicate / delete)~~ — built 2026-10-20.

Known v1 limits are listed in [docs/QA-REPORT.md](docs/QA-REPORT.md).
