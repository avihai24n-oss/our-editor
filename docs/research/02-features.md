# 02 — CapCut desktop basic features (non-AI) — research for "Our Editor"

Sources: the user's screenshots in `docs/capcut-screens/` (primary, authoritative for layout and
labels), CapCut help/resource pages, third-party tutorials, and general NLE knowledge. CapCut does
not publish a full parameter spec; any number marked **(verify)** was not visible in a screenshot
and comes from tutorials or memory of the app. Treat it as a sensible default, not gospel.

Legend: **v1** = basic, must ship in the first version. **v2** = later. **OUT** = AI / out of scope.

---

## 0. How CapCut is organised (the mental model to copy)

CapCut desktop has five regions (screenshot 01):

| Region | What lives there | Our v1 |
|---|---|---|
| Top bar | Project name (centre), "Auto saved hh:mm:ss" (left), layout toggles, Pro, Share, **Export** (cyan, right) | name, autosave label, Export |
| Left **asset panel** | Tab strip (09): Media, Audio, Text, Stickers, Effects, Transitions, Captions, Filters, Adjustment, Templates. Each tab has a left sub-nav (e.g. Media: Import / Media / Subprojects / Yours / Library…) and a grid of tiles | Media, Audio, Text, Transitions, Filters, Adjustment (others greyed or hidden) |
| Centre **player** | "Player-Timeline 01" header, canvas, `current / total` timecode (`00:00:00:00` = hh:mm:ss:ff), play button, Full (quality), crop-to-fit, **Ratio**, fullscreen | yes |
| Right **inspector** | Context sensitive. Nothing selected → Project/Details. Clip selected → tabs **Video / Audio / Speed / Animation / Adjust** (+ AI stylize). Each tab has segmented sub-tabs (Video: Basic / Remove BG / Mask) | Video>Basic, Audio>Basic, Speed>Standard, Animation, Adjust>Basic |
| Bottom **timeline** | Toolbar (08), ruler, track headers (cover/lock/eye/mute/…), main video track with **Cover** button, overlay tracks above, audio tracks below, zoom slider at right | yes |

Key UX conventions to copy everywhere:

- **Every inspector section** has: a checkbox to enable it (Blend, LUT, Adjust…), a collapse caret,
  a **reset** (circular arrow) and a **keyframe control** `< ◇ >` (prev keyframe / add-remove /
  next keyframe) at the right of the section header **and** of every animatable row.
- **Every numeric row** = label, slider, numeric field with up/down stepper, keyframe diamond.
  Values are typed or dragged; slider and field are linked.
- Bottom of Adjust: **Apply to all** (copy settings to every clip on the track) and
  **Save as preset**. Speed tab has a **Reset** button at the bottom.
- Asset tiles: hover shows a preview; a **+** (or drag) adds it at the playhead; a **download**
  arrow appears for not-yet-downloaded assets; a **star** favourites it. Library grids have category
  chips (Trending, Basic, Light, Glitch, Mask, 3D… in screenshot 06).
- Applying a filter / adjustment from the left panel creates a **separate timeline segment** on its
  own track (applies to everything under it for its duration). Applying from the inspector affects
  the selected clip only. This "layer vs. clip" duality is important — v1 can do clip-only and add
  layer segments in v2.

---

## 1. Media import — v1

- **What / why:** bring local video, audio and images into the project's **media bin**, then onto
  the timeline. Everything starts here.
- **Where:** Left panel > Media > Import (button "Import" + drag-and-drop onto the bin or the
  timeline). Tiles show thumbnail, duration badge (`00:10`), an **"Added"** badge once used on the
  timeline, and a red **"Media lost"** tile when the source file is gone (screenshot 01). Audio
  tiles show a waveform.
- **Parameters:** none. Bin tools: search, grid/list view, sort, filter by type.
- **Default clip lengths:** video/audio = file duration; **image = 5 s (verify; CapCut uses 5 s)**,
  stretchable to any length.
- **First clip sets the canvas?** CapCut's Ratio defaults to "Original" (first clip). We default to
  **9:16** per the user, switchable 16:9 / 1:1 / 4:5 in the player's **Ratio** menu.
- **Browser implementation:** `<input type=file multiple accept="video/*,audio/*,image/*">` and
  drop zone; `URL.createObjectURL(file)`; probe metadata with a hidden `<video>`/`<audio>`
  (`loadedmetadata` → duration, videoWidth/Height); thumbnails via seek + `drawImage` to a small
  canvas; audio waveform via `decodeAudioData` + peak downsampling. Persist the `File` blobs in
  IndexedDB keyed by media id so a reload can rebuild object URLs; if a blob is missing, show
  "Media lost" with a relink action.
- **Excluded:** Record (camera/voice-over), Library stock, Generate, Dreamina, AI clipper — OUT/v2.

## 2. Timeline editing toolbar (screenshot 08) — v1 unless noted

Left to right: **+** (add/import), **Select tool** (with dropdown: Select / Split-blade mode,
v1 select only), **Undo**, **Redo**, **Split**, **Delete left** (trim start to playhead),
**Delete right** (trim end to playhead), **Delete**, **Marker**, **Crop**, **Mirror/rotate group**
(with small corner triangle = dropdown), then a separator and AI-ish tools (auto reframe, AI cut,
enhance, HD, voice) which are OUT. Right side of the toolbar (screenshot 01): mic (record, OUT),
**main track magnet**, **auto snapping**, **linkage** (link audio/video), **preview axis**,
fullscreen timeline toggle, **zoom − / slider / +**.

| Tool | What it does / why | Shortcut (CapCut) | v |
|---|---|---|---|
| Split | Cut the selected clip (or all clips under the playhead if none selected) at the playhead into two clips. The basic cut. | Ctrl/Cmd+B | v1 |
| Delete left / right | Removes the part of the clip before/after the playhead in one move (= split + delete), ripples on the main track. Fast trimming of bad starts/ends. | Q / W | v1 |
| Delete | Remove selected clip(s). On the main track the gap closes (magnet); on other tracks it leaves a gap. | Del / Backspace | v1 |
| Trim (drag edges) | Drag a clip's left/right edge to shorten/extend within source bounds (images unbounded). | — | v1 |
| Duplicate | Copy selected clip; CapCut via right-click > Copy/Paste or Ctrl+C/V (pastes at playhead on a free track). | Ctrl+C/V | v1 |
| Replace | Right-click > Replace clip: swap the media but keep position, duration and all applied settings (useful for templates). Source must be ≥ clip duration. | — | v2 |
| Freeze frame | Right-click / toolbar: inserts a 3 s (verify) still image of the frame at the playhead, splitting the clip. Used for "pause" emphasis. Implement: capture frame to an image blob → new image clip. | — | v2 |
| Reverse | Plays the clip backwards. Needs re-encoding in a browser (decode all frames) — expensive. | — | v2 |
| Mirror | Flip horizontally. Implement as `scaleX = -1` flag in transform. | — | v1 |
| Rotate | 90° steps from the toolbar dropdown; arbitrary degrees in Video>Basic. | — | v1 |
| Crop | Opens a crop dialog with free / 16:9 / 9:16 / 1:1 / 4:3 / 3:4… presets, a rotation straighten slider and Reset. Stores a source rect (0–1 normalised). | — | v1 (free + presets) |
| Marker | Adds a marker at the playhead on the timeline ruler (or on the selected clip). Used to note beats/cue points; can have a colour + note in v2. | M | v1 (ruler markers) |
| Undo / Redo | Full history. Implement as immutable state snapshots (immer patches) with a cap (~100 steps). | Ctrl+Z / Ctrl+Shift+Z | v1 |
| Main track magnet | When on, clips on the main (bottom video) track always butt together with no gaps (ripple). | — | v1 (default on) |
| Auto snapping | Clip edges snap to playhead, other edges, markers. | N | v1 |
| Linkage | Keeps detached audio linked to its video when moving. | — | v2 |
| Zoom | Timeline zoom slider + Ctrl/Cmd +/- and Ctrl+scroll. | Ctrl +/- | v1 |
| Select all | — | Ctrl+A | v1 |
| Play/pause | — | Space | v1 |
| Frame step | — | ← / → | v1 |

**Track headers** (screenshot 01): type icon, **lock**, **eye** (hide video), **speaker** (mute
track), **…** menu. Audio tracks show lock + mute only. Main track has the **Cover** button
(choose a frame or image as thumbnail — v2). v1: lock / hide / mute per track.

**Tracks model:** one **main video track**; overlay video/image tracks stack above (higher = on top);
text tracks above; audio tracks below. Dropping media above the main track creates an overlay
(picture-in-picture). This is how CapCut does layering — copy it.

## 3. Video > Basic (screenshot 02) — v1

Sub-tabs: **Basic** (v1), Remove BG (OUT), Mask (v2).

### Transform (section with reset + keyframe)
| Param | Range | Default | Unit | Notes |
|---|---|---|---|---|
| Scale | 1 % – 400 % (verify; slider shows ~0–400) | 100 % | % | Relative to "fit" size in canvas |
| Uniform scale | on/off | on | — | Off reveals Scale W / Scale H |
| Position X / Y | unbounded (canvas pixels in CapCut's project space) | 0, 0 | px | 0,0 = centred. Also drag in player |
| Rotate | −360° … 360° (number field accepts any) | 0.00° | ° | Field + a rotation dial |
| Align (6 + 2 buttons) | left, centre-H, right, top, centre-V, bottom (+ distribute, disabled for single) | — | — | Snaps the clip's edge to the canvas edge |

Player interaction: selecting a clip draws a bounding box with corner handles (scale), a rotate
handle, and drag to move; centre guide lines snap. **v1.**

### Blend (checkbox section)
- **Opacity** 0–100 %, default 100 %. v1.
- **Blend mode** dropdown (CapCut desktop list, verify order): Normal, Darken, Screen, Overlay,
  Multiply, Lighten, Hard light, Soft light, Linear burn, Color burn, Color dodge.
  Only meaningful for overlay-track clips. v1 = opacity + Normal/Multiply/Screen/Overlay/Darken/
  Lighten (all map 1:1 to `ctx.globalCompositeOperation`: `multiply`, `screen`, `overlay`,
  `darken`, `lighten`, `hard-light`, `soft-light`, `color-burn`, `color-dodge` — so actually the
  whole list is cheap in Canvas 2D; Linear burn needs WebGL → v2).

### Others in the tab
Stabilize, Enhance quality, Reduce image noise, Optical flow, AI remove, AI expand → **OUT**.
Background (canvas fill: colour / blur / image behind letterboxed clips) appears in the Video tab
under "Canvas" in CapCut → **v2** (v1: black background).

**Implementation:** compositor draws each visible layer bottom→top to a canvas sized to the
project ratio (e.g. 1080×1920 for 9:16): `save → translate(cx+x, cy+y) → rotate → scale(sx*mirror,
sy) → globalAlpha → globalCompositeOperation → drawImage(cropRect…) → restore`.

## 4. Audio > Basic (screenshot 03) — v1

| Param | Range | Default | Unit |
|---|---|---|---|
| Volume | −∞ (mute) … **+20 dB** (verify max; slider is centred near 0 dB at ~75 % travel) | 0.0 dB | dB |
| Fade in | 0 s … clip duration (CapCut caps the slider, verify ~10 s) | 0.0 s | s, 0.1 steps |
| Fade out | same | 0.0 s | s |

All three have keyframe diamonds (volume keyframes = manual ducking). v1: volume + fades,
volume keyframes v2.

- **Mute clip:** speaker icon on the clip/track header (track mute v1; per-clip mute = volume −∞).
- **Detach audio** (right-click on a video clip > Extract/Detach audio): moves the video's sound
  to its own audio track, linked; original video becomes silent. v2 (needs separate audio element
  per source — doable: same media, `kind: 'audio'` clip, video clip `muted=true`). **v1 nice-to-have.**
- **Extract audio** (Media > Import > Extract audio): import only the audio of a video file. v2.
- OUT: Normalize loudness (actually non-AI, v2), Enhance voice, Video translator, Reduce noise,
  Isolate voice. Fill channel (L/R copy) v2.
- **Implementation:** Web Audio graph per clip: `MediaElementSource → GainNode → destination`.
  dB→gain = `10^(dB/20)`. Fades = linear ramp on gain over the in/out window, recomputed on seek.
  Export: `OfflineAudioContext` mixing all audio clips.

## 5. Speed (screenshots 04, 05)

### Standard — v1
| Param | Range | Default | Notes |
|---|---|---|---|
| Speed | **0.1x – 100x** (slider ticks: 0.1, 1, 2, 5, 10, 100 — logarithmic-ish) | 1.00x | Changing speed changes timeline duration |
| Duration | derived = sourceDuration / speed (editable, which back-computes speed) | clip length | e.g. "2.3s → 2.3s" |
| Change audio pitch | toggle | **off** | Off = pitch preserved (time-stretch); on = chipmunk/slowed pitch |

Smooth slow-mo (optical flow) = OUT. **Reset** at bottom.

**Implementation:** `video.playbackRate = speed` (browsers support ~0.0625–16; beyond 16x we must
seek-step frames instead of playing). `preservesPitch = !changePitch`. Clip timeline length =
(outPoint − inPoint) / speed. Export via frame-accurate seeking so any speed works.

### Curve — v2
Presets (screenshot 05): None, Custom, **Montage, Hero, Bullet, Jump cut, Flash in, Flash out**.
Each is a speed-over-time curve (y axis 0.1x–10x, log) applied across the clip: Montage =
fast-slow-fast swing; Hero = normal → slow-mo dip in middle → normal; Bullet = a deep slow-mo
dip; Jump cut = a fast spike; Flash in = starts fast then normal; Flash out = normal then
accelerates out. Custom exposes ~5 draggable control points. Implement as a piecewise curve
`speed(t)` and integrate it to map timeline time → source time. Velocity effects = v2/OUT.

## 6. Animation (screenshot 06) — v1 (basic set)

- **What / why:** a one-shot motion applied to the clip's **start (In)**, **end (Out)** or a
  looping one across the whole clip (**Combo**). Gives cuts life without hand keyframing.
- **Where:** inspector > Animation tab, sub-tabs **In / Out / Combo**; a library grid with category
  chips (Trending, Basic, Light, Glitch, Mask, 3D, Vibration…); tile "None" first. Below the grid a
  **Duration** slider.
- **Durations:** In / Out default **0.5 s** (verify), max = clip length (In + Out can't overlap).
  Combo = whole clip by default. On the timeline the clip shows a small white bar/arrow at the
  start/end marking the animation span.
- **Basic set to ship (v1):** Fade In / Fade Out, Zoom In (Zoom 1), Zoom Out, Slide Left/Right/Up/
  Down (screenshot shows Slide Right, Slide Down), Rotate (Rotation entry), Blur In / Blur Out,
  Shake (Shake 1), Swing, Fly In, Flip. These are all expressible as transform + opacity + blur
  tweens with an easing function.
- **Combo (v2):** e.g. "Swing", "Rock", "Jelly" loops.
- **Implementation:** an animation = `{type, durationSec}`; at render time compute progress
  `p = (t − clipStart)/dur` (In) and apply `ease(p)` to an offset transform (e.g. slide: x from
  −canvasWidth to 0; zoom: scale 1.3→1; fade: alpha 0→1; blur: `ctx.filter = blur(px)`) multiplied
  on top of the base transform.

## 7. Text — v1

- **Where:** Left panel > Text: sub-nav **Add text** ("Default text" tile), Text templates,
  Effects (Word art), (AI-generated / auto captions OUT). Adding creates a text clip on a text
  track, default length **3 s (verify)**, centred.
- **Inspector for text:** tabs **Text / Animation / Tracking(v2) / Text-to-speech(OUT)**.
  Text > Basic:
  | Param | Default (verify) |
  |---|---|
  | Content | "Default text" (multiline textarea) |
  | Font | System / app default sans; font picker list |
  | Font size | 15 (CapCut units), range 1–300 |
  | Style | Bold / Italic / Underline toggles; Case (Aa / AA / aa) |
  | Color | white #FFFFFF |
  | Character spacing / line spacing | 0 / 0 |
  | Alignment | left / centre / right (+ vertical options) — default centre |
  | Stroke | off; colour black, width 0–100 (default ~20) |
  | Background | off; colour, opacity 0–100 %, rounded corners, height/width padding |
  | Shadow | off; colour, opacity, blur, distance, angle |
  | Transform | same Scale / Position / Rotate as video |
  | Opacity | 100 % |
- **Presets row:** a strip of style presets (white on black, yellow stroke…) — v2.
- **Text templates / Word art:** prebuilt animated designs — v2.
- **Implementation:** Canvas 2D `fillText` with `font`, `strokeText` (draw stroke first, width×2),
  background `roundRect` behind measured lines, `shadowBlur/shadowColor/shadowOffsetX/Y`. Edit
  in-place on the player via an overlay `<textarea>` on double-click (v2; v1 edits in inspector).

## 8. Transitions — v1 (basic set)

- **What / why:** a visual bridge between two adjacent clips on the **same track** (main track in
  practice). Smooths or punctuates a cut.
- **Where:** Left panel > Transitions (categories: Trending, Basic, Overlay, Camera, Blur, Slide,
  Wipe, Light, Glitch…). Drag onto the boundary between two clips, or select a clip and click +.
  A small transition icon sits on the cut. Selecting it opens the inspector with **Duration** and
  **Apply to all**.
- **Default duration:** **0.5 s** (verify), adjustable ~0.1 s up to **half the shorter adjacent
  clip** (tutorial source). In CapCut the transition **overlaps** the two clips: the cut point
  stays, and the effect uses frames from the tail of A and the head of B around it (the total
  timeline length shrinks by the overlap — verify; CapCut mobile keeps length, desktop overlaps).
  Recommended for us: **overlap model** (A's last d/2 + B's first d/2 mixed around the cut; no
  extra source handles needed if we freeze-extend when the source runs out).
- **Basic set to ship (v1):** Mix (cross-dissolve), Black fade (dip to black), White flash
  (dip to white), Slide left/right/up/down (push), Wipe left/right, Zoom in, Blur.
- **Implementation:** at render time, if t is inside a transition window, draw both frames and
  combine with `p = progress`: mix = alpha; dip = to colour then back; push = translate both;
  wipe = clip rect; zoom = scale A up + fade; blur = `ctx.filter = blur()` peaking at middle.

## 9. Filters — v1 (small set)

- **What:** a named, packaged **look** (a LUT plus tweaks) with one control: **Intensity 0–100,
  default 100** (verify). **Why:** one-click mood; vs. **Adjustment**, which is manual,
  per-parameter correction. Filters = creative preset; Adjust = technical control. They stack:
  filter first, then adjustment.
- **Where:** Left panel > Filters (categories: Featured, Life, Movies, Retro, B&W, Food, Nature,
  Style…). Clicking + adds a **filter segment** on a separate track (applies to all layers below
  for its span); in the inspector Adjust tab… v1: apply to the selected clip (stored on clip),
  layer-segment model v2.
- **Basic looks for v1 (build ourselves, no LUT files):** None, B&W (mono), Vintage/Sepia, Warm,
  Cool, Vivid, Fade/Matte, Cinematic (teal-orange), Retro, Noir (high-contrast B&W). Implement each
  as a preset of Adjust parameters or a 3×4 colour matrix, blended with original by intensity.
- **Implementation:** WebGL fragment shader (preferred) or Canvas 2D `ctx.filter` (`grayscale`,
  `sepia`, `saturate`, `contrast`, `brightness`, `hue-rotate`) for v1 quick path.

## 10. Adjust (screenshot 07)

Sub-tabs: **Basic** (v1), HSL (v2), Curves (v2), Color wheel (v2), Mask (v2).
Top AI items **Auto adjust, Color match, Color correction** = OUT.

### LUT (checkbox section) — v2
Name dropdown (None + imported `.cube` files), Intensity 0–100 (100), Protect skin tone toggle
(skin protection is semi-AI — OUT). Implement with a 3D texture lookup in WebGL.

### Adjust (checkbox section) — v1
All are sliders with numeric field + keyframe, **default 0**. CapCut desktop ranges (verify; most
are −50…+50, the "amount" ones 0…100):

| Group | Param | Range | What it does |
|---|---|---|---|
| Color | Temp | −50…50 | blue ↔ yellow white balance |
| Color | Tint | −50…50 | green ↔ magenta |
| Color | Saturation | −50…50 | colour intensity (−50 = grey) |
| Lightness | Exposure / Light (Brightness) | −50…50 | overall level |
| Lightness | Contrast | −50…50 | spread around mid-grey |
| Lightness | Highlight | −50…50 | bright tones only |
| Lightness | Shadow | −50…50 | dark tones only |
| Lightness | Whites | −50…50 | white point |
| Lightness | Blacks | −50…50 | black point |
| Lightness | Brilliance | −50…50 | local-contrast/tone (v2) |
| Effects | Sharpen | 0…100 | edge emphasis (convolution) |
| Effects | Clarity | 0…100 | mid-tone local contrast (v2) |
| Effects | Fade | 0…100 | lifts blacks, matte look |
| Effects | Vignette | −50…50 | darkens (+) or lightens (−) edges |
| Effects | Grain | 0…100 | film noise |

v1 ship list: Temp, Tint, Saturation, Brightness/Exposure, Contrast, Highlight, Shadow, Whites,
Blacks, Fade, Vignette, Sharpen, Grain. Buttons **Apply to all** (v1) and **Save as preset** (v2).

**Implementation:** one WebGL fragment shader per frame with uniforms for every slider (cheap, real
time at 1080×1920). Canvas 2D `ctx.filter` can cover brightness/contrast/saturate only, so plan
WebGL from the start. Order: LUT/filter → temp/tint → exposure → contrast → highlights/shadows/
whites/blacks (tone curve) → saturation → fade → vignette → grain → sharpen (needs neighbour
samples).

### HSL / Curves / Color wheel — v2
HSL: 8 colour swatches (red, orange, yellow, green, cyan, blue, purple, magenta) × Hue /
Saturation / Lightness −100…100. Curves: luma + R/G/B tone curves with draggable points.
Color wheel: Lift / Gamma / Gain / Offset wheels (shadows/mids/highlights).

## 11. Stickers & Effects — v2 (overview)

- **Stickers:** animated PNG/GIF/Lottie-ish overlays from an online library; behave like an
  overlay image clip with transform + animation. v2 (could later allow user PNG/GIF import —
  that's already "image import" in v1).
- **Effects:** two families — **Video effects** (applied as a segment on an effects track over
  everything below: glitch, light leaks, blur, shake, retro, bokeh…) and **Body effects** (AI —
  OUT). Each has parameters like speed/intensity. v2, implemented as shaders.

## 12. Captions (manual) — v2

Left panel > Captions: Auto captions (OUT), **Manual captions** / import `.srt/.lrc`. Captions
are a dedicated track of short text clips sharing one style; editing the style of one applies to
all. v1 users can use Text; v2 adds a caption track + SRT import/export.

## 13. Markers — v1

Add at playhead (M) on the ruler, or on a selected clip (moves with the clip). Shown as small
coloured flags; click to jump; v2 adds colour + note and "next/previous marker" navigation.
Model: `{id, time, color?, note?}` on the project (ruler) or clip.

## 14. Keyframes — v1 (core properties), v2 (everything)

- **How it works in CapCut:** every animatable row has a `< ◇ >` control. Clicking ◇ at the
  playhead adds a keyframe for that property (diamond turns filled/cyan); changing a value when
  the playhead is on a clip that already has keyframes for that property auto-adds a keyframe.
  `<` / `>` jump to the previous/next keyframe. The section-header diamond (e.g. Transform) keys
  all its rows at once. Keyframes appear as small diamonds on the clip in the timeline (visible in
  screenshot 01), selectable and draggable; Delete removes one.
- **Interpolation:** linear between keyframes by default; CapCut adds a per-segment ease/graph
  ("Keyframe graph", presets like ease in/out) — v2. Before the first / after the last keyframe the
  value holds.
- **v1 scope:** Scale, Position X/Y, Rotate, Opacity, Volume. v2: all Adjust sliders, text props.
- **Model:** `clip.keyframes[prop] = [{t: secondsFromClipStart, v, ease:'linear'}]`, sorted;
  `valueAt(prop, t)` = base value if empty, else lerp. Times are clip-relative so moving the clip
  moves its keyframes; trimming the start shifts them.

## 15. Export — v1

- **Where:** cyan **Export** button top-right → modal: title (file name), location, and sections
  **Video** (toggle), **Audio** (toggle, export audio only), **Captions** (v2), **GIF** (v2).
- **Video settings (CapCut, verify):**
  | Setting | Options | Default |
  |---|---|---|
  | Resolution | 480p, 720p, **1080p**, 2K, 4K | 1080p |
  | Bitrate | Lower, **Recommended**, Higher, Custom (Mbps) | Recommended |
  | Codec | H.264, HEVC (H.265), AV1 | H.264 |
  | Format | **MP4**, MOV | MP4 |
  | Frame rate | 24, 25, **30**, 50, 60 fps | 30 |
  | Color space | SDR Rec.709 (HDR v2) | — |
  Audio-only formats: MP3, WAV, AAC, FLAC.
  Resolution refers to the short side for vertical (1080p 9:16 = 1080×1920).
- **Browser implementation:** render offline, frame by frame: for each frame time, seek every
  visible video (await `seeked` or use `requestVideoFrameCallback`), composite on an
  OffscreenCanvas, feed `new VideoFrame(canvas)` to **WebCodecs `VideoEncoder`** (avc1 / H.264),
  mix audio with `OfflineAudioContext` → `AudioEncoder` (AAC/Opus), mux with **mp4-muxer** (or
  webm-muxer). Fallback: `MediaRecorder` on `canvas.captureStream()` (real-time, WebM, lower
  quality). v1 options: resolution (720p/1080p), fps (24/25/30/60), quality (Lower/Recommended/
  Higher → bitrate), format MP4 (WebM fallback). Progress bar + cancel.

---

## v1 checklist (what ships)

1. Layout shell: top bar, left tab strip (Media, Audio, Text, Transitions, Filters, Adjustment
   active; Stickers, Effects, Captions, Templates shown disabled "soon"), player, inspector,
   timeline. Dark theme, cyan accent (#00C1CD-ish CapCut cyan).
2. Import video/audio/image, media bin with duration badge, "Added" badge, drag to timeline.
3. Project ratio 9:16 default, Ratio menu 16:9 / 1:1 / 4:5; autosave to IndexedDB.
4. Timeline: main track + overlay tracks + text track + audio tracks; magnet, snapping, zoom,
   playhead, ruler, track lock/hide/mute, keyframe diamonds on clips.
5. Tools: select, split, delete left/right, delete, trim, copy/paste, mirror, rotate 90, crop,
   marker, undo/redo, standard shortcuts.
6. Inspector: Video>Basic (transform, align, opacity, blend modes), Audio>Basic (volume dB, fades),
   Speed>Standard (0.1–100x, duration, pitch toggle), Animation In/Out (basic set), Adjust>Basic
   (13 sliders, Apply to all), Text inspector, Transition duration, Filter intensity.
7. Keyframes for transform, opacity, volume (linear).
8. Transitions: mix, black fade, white flash, slide ×4, wipe ×2, zoom, blur.
9. Filters: ~10 built-in looks with intensity.
10. Export MP4 via WebCodecs (720p/1080p, fps, quality), MediaRecorder fallback.

## v2 parking lot

Replace, freeze frame, reverse, detach/extract audio, speed curves, Combo animations, LUTs,
HSL/Curves/Color wheel, Masks, canvas background (blur/colour), stickers, video effects, captions
track + SRT, text templates/word art, keyframe easing graph, filter/adjust as timeline layer
segments, Save as preset, Cover, normalize loudness, GIF/audio-only export, linkage.

## OUT (AI — not now)

Remove BG, AI remove/expand, Enhance quality, Reduce noise (image/audio), Stabilize (could be
non-AI later), Optical flow / Smooth slow-mo, Auto adjust, Color match, Color correction, Protect
skin tone, Enhance voice, Isolate voice, Video translator, Auto captions, Text-to-speech, Smart
suggestions / Global edits, AI clipper, Dreamina, Generate, AI stylize, EditPilot, Body effects,
Auto reframe.

---

### Sources consulted
- User screenshots `docs/capcut-screens/01–09` (primary).
- CapCut help — transitions: https://www.capcut.com/help/transitions-in-capcut
- CapCut help — export 2K/4K: https://www.capcut.com/help/export-videos-in-capcut
- CapCut resource — keyframes on PC: https://www.capcut.com/resource/how-to-add-keyframes-in-capcut
- CapCut help — keyframes PC: https://www.capcut.com/help/keyframes-in-capcut-pc
- CapCut resource — color grading: https://www.capcut.com/resource/capcut-color-grading
- CapCut create — blend modes: https://www.capcut.com/create/blend-modes-creative-video-photo-effects
- Tutorial — transitions (half of shorter clip rule): https://www.tourboxtech.com/en/news/capcut-transitions.html
- Tutorial — keyframes PC: https://www.technobezz.com/how-to-add-keyframes-in-capcut-pc
- Tutorial — export settings: https://www.miracamp.com/learn/capcut/how-to-export-high-quality-videos
- MDN — Canvas blend modes: https://developer.mozilla.org/en-US/docs/Web/CSS/blend-mode
