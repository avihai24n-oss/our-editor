# 03 — Technical architecture for "Our Editor" v1

Scope: a browser NLE modelled on CapCut Desktop. v1 covers the basics only and has no AI features.
Stack (fixed): Vite, React 18, TypeScript (strict), Zustand with immer, Vitest, plain CSS variables.
There is no backend, and all media stays local.
Primary target is desktop Chrome/Edge (WebCodecs plus the File and IndexedDB APIs). Firefox and Safari
are "should open, may not export" in v1.

Each section ends with a **Decision** line. Those lines are binding for the build agents.

---

## 0. Guiding principles

1. **The document and the engine are separate.** The project JSON is plain data that can be
   serialised, with no DOM objects, object URLs or class instances in it. The preview engine,
   the audio graph and the exporter *read* the document and never own it.
2. **Use pure functions for the logic of time.** Questions like "which clips are visible at t",
   "the source time for clip c at t", "the props of clip c at t", "split", "trim" and "ripple"
   are pure TypeScript functions in `src/core/`. They are unit-tested and have no React or DOM in
   them. The UI and the engine call them.
3. **Preview and export share one compositor.** `renderFrame(ctx, project, t, frameSource)`
   draws a frame. In preview `frameSource` reads from `<video>` elements, and in export it reads
   from decoded `VideoFrame`s. Because both use the same code, the export matches the preview.
4. **Leave slots for later features without building them.** Keyframes, speed curves, effects,
   stickers and captions get a type slot and a code path stub now, so adding them later does not
   need a migration.

---

## 1. Time units

Options considered:

| Option | Pro | Con |
|---|---|---|
| seconds as `number` (float) | simple and native to `<video>.currentTime` | float drift: `0.1+0.2`, and split points that land 1 µs off cause off-by-one frames and failing equality tests |
| integer frames | exact and matches the timecode | ties the document to one fps; changing the project fps or mixing 24/25/30 sources breaks it |
| **integer microseconds (µs)** | exact integer arithmetic, independent of fps, and the **native unit of WebCodecs** (`VideoFrame.timestamp`, `EncodedVideoChunk.timestamp`) and of Mediabunny | needs `/1e6` at the edges of `<video>` and `AudioContext` |

**Decision:** every time in the document is an **integer number of microseconds** (`type Us = number`,
kept integral with `Math.round`). Conversion to seconds happens only at the edges of the browser APIs
(`usToSec`, `secToUs` in `core/time.ts`). The UI snaps edits to the **project frame grid**
(`project.fps`, default 30) with `snapToFrame(us, fps)`, so clip boundaries land on frame boundaries.
The timecode display uses CapCut's `HH:MM:SS:FF` format.

---

## 2. Data model

```ts
// core/model.ts  — everything is JSON-serialisable
type Id = string;            // nanoid
type Us = number;            // integer microseconds

interface Project {
  id: Id; name: string; version: 1;            // schema version → migrations
  createdAt: number; updatedAt: number;
  settings: { aspect: '9:16' | '16:9' | '1:1' | '4:5'; width: number; height: number; // 1080x1920 default
              fps: 30 | 25 | 24 | 60; background: string };                           // '#000000'
  assets: Record<Id, MediaAsset>;
  tracks: Track[];                               // order = z-order: tracks[0] is the bottom layer
  markers: { id: Id; time: Us; color: string; label?: string }[];
  coverAssetId?: Id | null;                      // the "Cover" button
}

interface MediaAsset {
  id: Id; kind: 'video' | 'audio' | 'image';
  name: string; mime: string; size: number;
  duration: Us;                    // image → 0 (unbounded)
  width?: number; height?: number; fps?: number; hasAudio?: boolean;
  blobKey: Id;                     // the key in the IndexedDB 'blobs' store (the actual File)
  // derived and cached separately: thumbnails, waveform peaks — never in the doc
}

type TrackKind = 'video' | 'audio' | 'text';     // video tracks also carry images (and stickers later)
interface Track {
  id: Id; kind: TrackKind; name: string;
  isMain?: boolean;               // CapCut "main track": magnetic, no gaps
  locked: boolean; hidden: boolean; muted: boolean;   // the header icons lock / eye / speaker
  clips: Clip[];                  // kept sorted by start, never overlapping within a track
  transitions: Transition[];
}

interface ClipBase {
  id: Id; trackId: Id;
  start: Us;                      // position on the timeline
  duration: Us;                   // length on the timeline (after speed)
}
interface MediaClip extends ClipBase {
  type: 'video' | 'audio' | 'image';
  assetId: Id;
  in: Us;                         // source in-point (ignored for image)
  speed: number;                  // 0.1 … 100 (CapCut range); source span = duration * speed
  preservePitch: boolean;         // CapCut "Change audio pitch" = !preservePitch
  props: VisualProps & AudioProps;
  keyframes?: Partial<Record<AnimatableProp, Keyframe[]>>;   // v2 slot, empty in v1
}
interface TextClip extends ClipBase {
  type: 'text';
  text: string;
  style: { font: string; size: number; color: string; align: 'left'|'center'|'right';
           bold: boolean; italic: boolean; stroke?: { color: string; width: number };
           background?: { color: string; opacity: number } };
  props: VisualProps;
  keyframes?: Partial<Record<AnimatableProp, Keyframe[]>>;
}
type Clip = MediaClip | TextClip;

interface VisualProps {           // screenshot 02 Video>Basic, 07 Adjust>Basic
  x: number; y: number;           // offset from canvas centre, in project pixels
  scale: number;                  // 1 = "fit" (contain) inside the canvas
  rotation: number;               // degrees
  opacity: number;                // 0..1
  flipH: boolean; flipV: boolean; // "mirror" toolbar button
  crop: { l: number; t: number; r: number; b: number };   // 0..1 fractions
  blend: 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';
  adjust: { brightness: number; contrast: number; saturation: number;
            temperature: number; tint: number; exposure: number };  // -100..100, 0 = neutral
  filterId?: string | null; filterIntensity?: number;     // filter preset (v1: a few CSS-filter presets)
  animIn?: ClipAnimation | null; animOut?: ClipAnimation | null;   // screenshot 06
}
interface AudioProps { volumeDb: number; fadeIn: Us; fadeOut: Us }   // screenshot 03
interface ClipAnimation { presetId: string; duration: Us }

interface Transition {            // lives on the track between two adjacent clips
  id: Id; type: 'fade' | 'dissolve' | 'slide-left' | 'slide-up' | 'wipe-left' | 'zoom';
  fromClipId: Id; toClipId: Id;   // fromClip.start+duration === toClip.start (adjacent)
  duration: Us;                   // centred on the cut
}
type AnimatableProp = 'x'|'y'|'scale'|'rotation'|'opacity'|'volumeDb';
interface Keyframe { t: Us /* clip-local */; value: number; ease: 'linear'|'easeIn'|'easeOut'|'easeInOut' }
```

Key rules, each a pure function in `core/`:

- **Source mapping:** `sourceTime(clip, t) = clip.in + (t - clip.start) * clip.speed`.
  The span the clip uses in the source is `[in, in + duration*speed]` and must lie within the
  asset's duration. Changing the speed changes `duration` and leaves `in` alone
  (`duration = sourceSpan / speed`). This matches CapCut, where a faster clip gets shorter on the
  timeline (screenshot 04).
- **Effective props:** `resolveProps(clip, t)` returns `props` with keyframes interpolated
  (v2) and the in/out animations applied. **The compositor only ever calls `resolveProps`.**
  This is the slot that lets keyframes arrive later without touching the renderer.
- **Main track magnetism:** after every edit on an `isMain` track, `closeGaps(track)` packs its
  clips back to back from 0. Other tracks place clips freely, but clips on one track never overlap
  (`insertClip` pushes or refuses). There is one `isMain` video track. Overlay video tracks,
  text tracks and audio tracks are created on demand when a clip is dropped above or below,
  as in CapCut.
- **Transitions:** a transition is centred on the cut and needs `duration/2` of *handle* beyond
  `fromClip`'s out-point and before `toClip`'s in-point. When the source runs out, the renderer
  holds the edge frame. The timeline length does not change, which keeps the model simple.
  A transition is deleted automatically when its clips stop being adjacent (`pruneTransitions`).
- **Speed curve (screenshot 05)** is a v2 slot: add an optional `speedCurve?: {t:number,v:number}[]`
  later and generalise `sourceTime` into an integral. v1 has constant speed only.
- Everything the UI changes goes through **actions** (`splitClip`, `trimStart`, `trimEnd`,
  `moveClip`, `deleteLeft`, `deleteRight`, `setProps`, `addTransition`, …). Each action is
  implemented as a pure `(project, args) => project` reducer in `core/ops/` and wrapped by the store.

---

## 3. State management and undo/redo

- One Zustand store with the `immer` middleware, split into slices:
  - `doc` holds the `Project` and is the only thing that is undoable and persisted.
  - `ui` holds the selection, active left tab, active inspector tab, timeline zoom and scroll,
    and the hovered clip. It is not undoable.
  - `playback` holds `currentTime`, `isPlaying`, `duration` and `loop`. It is not undoable.
    During playback it is updated about 15–30×/s **for the UI only**, and the engine keeps its own clock.
- **Undo is a snapshot stack of `doc`, not immer patches.** Immer's structural sharing makes each
  snapshot nearly free, because unchanged tracks and clips are the same objects. Snapshots are
  much simpler to get right than patches when actions are composed. The stack is capped at 200
  entries.
- **Transactions:** continuous gestures (dragging a clip, trimming, moving a slider) call
  `beginTx()` on pointer-down, mutate freely, then `commitTx(label)` on pointer-up. That gives
  one undo step per gesture. `cancelTx()` on Escape restores the snapshot.
  Discrete actions are auto-wrapped as `tx(label, fn)`.
- Selectors stay granular (`useStore(s => s.doc.tracks[i].clips[j])` with `shallow`) so dragging
  one clip does not re-render the whole timeline.

**Decision:** Zustand + immer, with a snapshot undo stack and gesture transactions. Patches are not used.

---

## 4. Preview engine

### 4.1 Shape

```
<Player>
  <canvas width=1080 height=1920 style="height:100%">   ← the only visible surface
  (hidden) ElementPool: HTMLVideoElement / HTMLAudioElement / HTMLImageElement / ImageBitmap
  Engine (plain TS class, not React): clock, rAF loop, compositor, audio graph
```

- The canvas backing store uses the **project resolution** (for example 1080×1920), and CSS
  scales it to fit the player box. For performance, a "preview quality" setting can halve the
  backing store (540×960). The default is half while playing and full when paused.
- The `ElementPool` keys elements by **clip id**, not asset id. During a transition two clips of
  the same asset may be on screen at different source times, and each needs its own decoder.
  Elements are created lazily for clips within a ±5 s look-ahead window of the playhead and
  released (`src=''`, `load()`) when they fall far outside it. This keeps Chrome under its limit
  on concurrent hardware decoders (around 16–32 `<video>` elements are safe).
- `video.muted = false`, but all audio is routed through Web Audio (see §5), so element volume is
  irrelevant. `video.preservesPitch = clip.preservePitch` and `video.playbackRate = clip.speed`.
  Browsers clamp `playbackRate` to roughly 0.0625–16. Above 16× (CapCut allows up to 100×) the
  engine stops relying on playback and seeks per rAF tick instead.

### 4.2 Clock

- **Master clock = `AudioContext.currentTime`** while playing:
  `t = startT + (ctx.currentTime - ctxStartAt) * 1e6`. It is monotonic, stays in sample sync with
  what you hear, and does not drift with rAF jitter. While paused, the clock is just `playback.currentTime`.
- The loop is `requestAnimationFrame(tick)`. Each tick:
  1. Compute `t` from the clock and stop at the project end (or loop).
  2. `visible = clipsAt(project, t)`, a pure function returning clips per track in z-order,
     skipping hidden tracks.
  3. For each visible media clip, ensure an element exists and **sync it**. The expected time is
     `sourceTime(clip, t)`. If the element is paused, call `play()`. If
     `|el.currentTime - expected| > 0.12 s`, set `el.currentTime = expected` (a hard resync).
     Small drift is left alone, because a micro-seek costs more than it fixes.
  4. **Clips that start mid-way:** the look-ahead pre-warms upcoming clips. About 1 s before
     `clip.start` the engine sets `el.currentTime = clip.in` and waits for `seeked`, paused.
     At `clip.start` it calls `play()`. This removes the black frame at cuts.
  5. Clips that just left visibility are `pause()`d.
  6. `renderFrame(...)` draws the canvas.
  7. Throttled to about 15 Hz, write `playback.currentTime` to the store so the playhead and
     timecode update.
- **Scrubbing and seeking while paused:** seeks are coalesced with a "latest wins" queue per
  element. If a seek is in flight, the next target is remembered and only the last one is issued
  when `seeked` fires. Each element redraws via `requestVideoFrameCallback` (which falls back to
  `seeked`), so the canvas shows the real frame and not the previous one. Clip edges use
  `fastSeek` only while dragging the playhead, and the final position always gets an exact
  `currentTime` seek.
- Starting playback: `await audioCtx.resume()` (this needs a user gesture, and the Space key or
  Play click provides it). Then prime all visible elements to their expected time, wait for them
  all to be `readyState >= 2` (with a 300 ms timeout), then start the clock.

### 4.3 Compositor (shared with export)

```ts
renderFrame(ctx: CanvasRenderingContext2D, project, t: Us, src: FrameSource): void
interface FrameSource { get(clipId: Id): CanvasImageSource | null }   // <video>, ImageBitmap, VideoFrame
```

For each track from bottom to top, for each visible clip:

1. `p = resolveProps(clip, t)`
2. `ctx.save()`, then `translate(W/2 + p.x, H/2 + p.y)`, `rotate`, and `scale(p.scale * fit * flip)`.
3. `ctx.globalAlpha = p.opacity * transitionAlpha` and
   `ctx.globalCompositeOperation = blendMap[p.blend]`. Canvas supports multiply, screen,
   overlay, darken and lighten natively.
4. `ctx.filter = adjustToCssFilter(p.adjust, filterPreset)`, for example
   `brightness() contrast() saturate() hue-rotate() sepia()`. This covers Brightness, Contrast,
   Saturation, Exposure (approximated with brightness) and filter presets. **Temperature and Tint
   have no CSS filter.** v1 approximates them with a second pass: a `fillRect` in warm/cool or
   magenta/green over the clip's area at low alpha with `globalCompositeOperation='overlay'`,
   clipped to the clip rect. When LUTs (screenshot 07) or real colour grading arrive, swap in a
   single WebGL2 fragment shader per clip behind the same `adjust` interface. The
   `applyAdjustments` function is isolated for exactly this reason.
5. `drawImage(source, crop…, dest…)`. Text clips are drawn with `fillText` and `strokeText`,
   wrapped by a pure `layoutText()`. A text layout is cached by its style hash.
6. `ctx.restore()`.

**Transitions** are rendered by drawing *both* clips inside the transition window with
`progress = (t - (cut - d/2)) / d`:

- fade/dissolve: from = 1-p, to = p (alpha)
- slide-*: offset by `±W*p`
- wipe-*: clip rect grows
- zoom: scale plus alpha

Each is a pure `transitionFrame(type, p) → { from: {alpha, dx, dy, scale, clipRect}, to: {...} }`,
which is easy to test. CapCut-style **in/out animations** (screenshot 06) use the same mechanism
for a single clip (`animFrame(presetId, p)`).

**Decision:** Canvas 2D compositor with `ctx.filter` and blend modes in v1. One WebGL2 shader
replaces `applyAdjustments` later. Hidden `<video>` elements are pooled per clip, the master clock
is AudioContext, and a rAF loop drives drift-corrected sync.

---

## 5. Audio

- One `AudioContext({ latencyHint: 'interactive' })` per app.
- **Preview graph:** each pooled `<video>`/`<audio>` element →
  `createMediaElementSource(el)` → per-clip `GainNode` → per-track `GainNode` (mute) →
  `master GainNode` → `destination`. `createMediaElementSource` can be called **only once per
  element**, which is one more reason to pool elements and never recreate them per tick.
- **Volume and fades:** per tick, compute
  `gain = dbToLin(volumeDb) * fadeEnvelope(clip, t) * trackMute * transitionAudioCrossfade` and
  apply it with `gain.setTargetAtTime(v, now, 0.01)`, which smooths without clicks. The
  envelope is a pure `fadeEnvelope()` shared with export. The volume range is −60 dB…+20 dB as in
  screenshot 03, and −∞ is treated as 0.
- **Export graph:** an `OfflineAudioContext(2, durationSec*48000, 48000)` with one
  `AudioBufferSourceNode` per clip, using buffers decoded with `decodeAudioData` and cached per
  asset. Each node runs `start(when=clip.start, offset=clip.in, duration=srcSpan)` with
  `playbackRate = speed` → `GainNode`. The gain automation uses the same `fadeEnvelope` sampled
  with `setValueCurveAtTime`. This renders far faster than real time.
- **Known v1 limitation:** `AudioBufferSourceNode.playbackRate` changes pitch. For a clip with
  `speed ≠ 1` and `preservePitch = true`, the export pitch-shifts while the preview (which uses the
  element's `preservesPitch`) does not. v1 documents this. v2 adds a time-stretch step (for example
  SoundTouchJS / WSOLA in a worklet) on the decoded buffer before export.

---

## 6. Thumbnails and waveforms (derived data, cached)

- **Thumbnails for the timeline filmstrip and media bin:** decode with **Mediabunny**
  (`Input` + `CanvasSink`, `canvasesAtTimestamps([...])`). It is fast and frame-accurate and needs
  no `<video>` seeking. The fallback is a hidden `<video>`, seek, `drawImage` into a 160 px-tall
  canvas, then `createImageBitmap`. Thumbnails are generated at a fixed interval per asset (one
  per second, capped at 200), cached in memory as `ImageBitmap`s and in IndexedDB as small WebP
  blobs keyed `thumb:<assetId>:<index>`. The timeline picks the nearest cached thumbnail for each
  tile it draws, whatever the zoom. Generation runs in a small queue so the UI never blocks.
  Images get one thumbnail.
- **Waveforms:** `file.arrayBuffer()` → `audioCtx.decodeAudioData` → downsample to **peaks**
  (`min/max` pairs per 10 ms bucket, Float32Array) inside a Web Worker. The worker receives the
  channel data as a transferable. Peaks are cached in IndexedDB under `peaks:<assetId>`, and the
  decoded AudioBuffer is kept in an LRU for export. A clip draws its slice
  `[in, in+duration*speed]` of the peaks into a `<canvas>` sized to the clip's pixel width (see §9).
- Derived data never enters the project JSON. If it is missing, it is regenerated.

---

## 7. Export

| | MediaRecorder on `canvas.captureStream()` + `MediaStreamAudioDestinationNode` | **WebCodecs + Mediabunny** (successor of mp4-muxer) | ffmpeg.wasm |
|---|---|---|---|
| speed | real time only (a 60 s edit takes 60 s or more) | faster than real time with hardware H.264 | 5–20× slower than real time for 1080p |
| frame accuracy | no: frames drop when the tab or GPU stalls, and timestamps jitter | yes: each frame is rendered at an exact `t` and stamped exactly | yes |
| MP4/H.264 | Chrome 126+ can record `video/mp4;codecs=avc1`, but the bitrate and keyframes are poorly controllable and the result is often VFR | yes: `avc1.640028` (High@4.0 fits 1080×1920@30), with explicit bitrate and GOP | yes |
| tab must stay visible | yes (rAF throttles in background tabs) | no | no |
| weight and complexity | trivial | moderate (~20–60 kB) | 25–30 MB of wasm, needs COOP/COEP headers for threads |

Note: `mp4-muxer` is **deprecated by its author in favour of Mediabunny**
(<https://github.com/Vanilagy/mp4-muxer> migration guide, <https://mediabunny.dev>). New code
should use Mediabunny, which also provides demuxing and decoding and high-level `CanvasSource` and
`AudioBufferSource` sources.

**Decision:** use **WebCodecs via Mediabunny** for v1 export, with MP4 (H.264 + AAC) output at
1080×1920 by default (or the aspect's resolution) and 30 fps.

Export pipeline (`export/exportMp4.ts`, a single function):

1. Check support with `canEncode('avc')` / `VideoEncoder.isConfigSupported({codec:'avc1.640028', width:1080, height:1920, bitrate: 12e6, framerate: 30})`.
   If AAC encoding is unsupported (some Linux Chrome builds), fall back to Opus-in-MP4, which
   Chrome plays. Show a clear error rather than a broken file.
2. Create `new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })`
   with `CanvasSource(offscreenCanvas, { codec:'avc', bitrate: QUALITY_HIGH })` and an
   `AudioBufferSource({ codec:'aac', bitrate: 192e3 })`.
3. **Video frames:** for `f = 0 … N-1`, set `t = f * 1e6 / fps`. Obtain each visible clip's
   source frame from a per-clip **Mediabunny `VideoSampleSink` / `CanvasSink` iterator** opened
   at `sourceTime(clip, t)`. The iterator is advanced monotonically, so there is no seek per frame.
   Then run `renderFrame(offscreenCtx, project, t, exportFrameSource)` (the same compositor) and
   `await canvasSource.add(t/1e6, 1/fps)`, which respects backpressure.
4. **Audio:** render the offline mix (§5) into one `AudioBuffer` and `await audioSource.add(buffer)`.
5. `await output.finalize()`, wrap `target.buffer` in a Blob, then download through
   `<a download="name.mp4">` (or `showSaveFilePicker` when it is available).
6. Show a progress modal with the frame count and an ETA. Cancelling disposes the encoder.
   Run steps 3–4 in a **Worker with OffscreenCanvas** if the main thread jank is noticeable. The
   compositor is DOM-free precisely so it can move there; v1 may start on the main thread.
7. Keep a **fallback** behind a flag: the MediaRecorder real-time path, for browsers without
   WebCodecs (Firefox < 130, older Safari).

---

## 8. Persistence

- **IndexedDB** through the tiny `idb` wrapper (~1 kB), with one DB `our-editor` and these stores:
  - `projects`: `{id, name, updatedAt, thumbnail}` plus the full `Project` JSON
  - `blobs`: the imported `File` objects themselves, keyed by `blobKey`. IndexedDB stores
    Blob/File by structured clone, so this survives reloads with no permission prompts.
  - `cache`: thumbnails and peaks (evictable)
- On import: `put(blobs, file)`, then probe metadata (Mediabunny `Input` gives the duration,
  dimensions, codec and `hasAudio`; the fallback is a `<video>` `loadedmetadata`). Then add the
  `MediaAsset`.
- On load: for each asset, `URL.createObjectURL(await get(blobs, blobKey))` into an in-memory
  `assetUrls` map that is **not** in the doc. URLs are revoked when the project closes.
- Autosave: subscribe to `doc` and debounce 800 ms → `put(projects, doc)`, plus `beforeunload`
  and `visibilitychange` flushes. Call `navigator.storage.persist()` once on the first import so
  Chrome does not evict media under pressure. Show the storage estimate in the project list.
- The File System Access API (keeping the original files on disk instead of copying them) is a
  v2 option for large libraries. It needs permission re-prompts on every session, which is too
  much friction for v1.
- `Project.version` plus a `migrations[]` array run on load. This is the escape hatch for every
  later schema change.
- A home screen ("Projects": new project with aspect picker, recent list, delete, rename) comes
  before the editor, matching CapCut's start screen.

---

## 9. Timeline UI

**Decision:** **DOM for structure and interaction, with `<canvas>` only inside a clip for its
filmstrip or waveform.**

- Track headers, clips, transitions, the playhead and markers are absolutely positioned `div`s:
  `left = start * pxPerUs`, `width = duration * pxPerUs`. DOM gives hit-testing, focus, hover,
  cursors, accessibility and CSS styling for free, and a few hundred clips is well within its
  budget. A fully canvas timeline is faster for thousands of items but means re-implementing all
  of that, which is wrong for v1.
- **Virtualise horizontally:** only render clips intersecting
  `[scrollLeft - 1 screen, scrollLeft + 2 screens]`, and draw filmstrip and waveform canvases only
  for the visible part.
- **Ruler:** one `<canvas>` with ticks chosen from a "nice step" table for the current zoom, and
  labels in timecode.
- **Zoom:** store `pxPerSecond` (range 2 … 600, matching the bottom-right zoom slider in
  screenshot 01). Ctrl/Cmd+wheel and the slider zoom **anchored at the cursor or the playhead**,
  with `newScroll = anchorTime*newPx - anchorX`. A "fit" button zooms to the whole project.
- **Pointer interactions** (one `useTimelineGesture` hook using Pointer Events with
  `setPointerCapture`):
  - *move*: drag the clip body. A move can change track (via the hovered track row) or create a
    new track when dropped in the gap above or below. The main track reorders by insertion index
    (magnetic), and other tracks use free placement that refuses overlap.
  - *trim*: drag the left or right handle (8 px zone, wider on hover). Trimming is clamped to the
    source bounds and a minimum of one frame. Images and text trim freely.
  - *playhead*: click or drag on the ruler or empty area seeks. The playhead is draggable.
  - *selection*: click, shift-click and marquee (rubber band) on empty space.
  - *snap*: candidates are the playhead, every clip start and end on all tracks, markers and 0.
    Each candidate is converted to px, and the nearest within **8 px** wins. A vertical snap guide
    line is shown. Holding a modifier (Alt) bypasses snapping, and the toolbar has a "snap" toggle.
  - During a gesture the store mutates inside a transaction (§3), so the preview updates live and
    each gesture is one undo step.
- **Toolbar (screenshot 08):** select, undo, redo, split (at the playhead), delete-left (Q),
  delete-right (W), delete, marker. Crop, mirror and rotate open the inspector. In v1, freeze,
  reverse and the AI buttons are absent.
- **Track headers:** lock, eye (hide) and mute toggles, plus the "Cover" tile on the main track.

---

## 10. Keyboard shortcuts layer

A single declarative table in `src/app/shortcuts.ts`:

```ts
{ id:'playPause', keys:['Space'], run: s => s.togglePlay() }
{ id:'split',     keys:['Mod+B'] } , { id:'delete', keys:['Delete','Backspace'] }
{ id:'deleteLeft',keys:['Q'] }, { id:'deleteRight', keys:['W'] }
{ id:'undo', keys:['Mod+Z'] }, { id:'redo', keys:['Mod+Shift+Z','Mod+Y'] }
{ id:'frameBack', keys:['ArrowLeft'] }, { id:'frameFwd', keys:['ArrowRight'] }
{ id:'prevEdit', keys:['ArrowUp'] }, { id:'nextEdit', keys:['ArrowDown'] }
{ id:'marker', keys:['M'] }, { id:'zoomIn', keys:['Mod+='] }, { id:'zoomOut', keys:['Mod+-'] }
{ id:'copy', keys:['Mod+C'] }, { id:'paste', keys:['Mod+V'] }, { id:'selectAll', keys:['Mod+A'] }
{ id:'home', keys:['Home'] }, { id:'end', keys:['End'] }
```

- One `keydown` listener on `window`. It ignores events whose target is an input, textarea,
  select or contentEditable, `Mod` maps to ⌘ on Mac and Ctrl elsewhere, and it calls
  `preventDefault` only for matched keys.
- The same `id`s back the toolbar buttons and their tooltips ("Split (⌘B)"), so behaviour and
  labels never diverge.

---

## 11. Testing strategy

- **Vitest (node / jsdom)** covers all of `src/core/`: time conversion and frame snapping,
  `sourceTime`, `clipsAt`, `resolveProps`, `fadeEnvelope`, `transitionFrame`, and every op
  (split, trim, move, ripple and closeGaps on the main track, delete-left/right, add and prune
  transitions, speed change), undo transactions and schema migrations. These modules hold most of
  the bug risk. The target is ≥ 90 % line coverage on `core/`.
  - Property-style tests: after any random sequence of ops, the invariants hold. Clips on a track
    are sorted and non-overlapping, the main track has no gaps, every clip's source span lies
    inside its asset, every transition's clips are adjacent, and all times are integers.
- **Engine unit tests:** `renderFrame` against a stub `CanvasRenderingContext2D` that records the
  calls, plus a fake `FrameSource`. These assert the draw order, alpha and transforms.
  `Engine.tick` runs with a fake clock and fake media elements, asserting resync thresholds and
  pre-warming.
- **Component tests (Vitest + Testing Library)** cover the inspector panels (a slider writes the
  prop and one undo step), track header toggles and the shortcut layer.
- **Playwright e2e (Chromium)** runs on fixture media generated once with ffmpeg: a 3 s 1080×1920
  30 fps test pattern with a beep, plus a PNG and a 2 s WAV. Flows covered:
  1. import → drag to the timeline → play → the playhead advances
  2. split, delete, undo/redo
  3. trim with snap
  4. change the aspect ratio → the canvas size changes
  5. reload → the project and media are restored from IndexedDB
  6. export → the downloaded MP4 is probed in the test: duration ±1 frame, 1080×1920, h264 + aac
  - Visual checks are pixel probes of the canvas (`getImageData` at known points) rather than
    full screenshots, which are flaky with video.
- Run `npm run typecheck && npm test && npm run e2e` in CI and as each agent's definition of done.

---

## 12. Proposed folder structure

```
our-editor/
  index.html
  vite.config.ts            vitest.config.ts       playwright.config.ts
  tsconfig.json  (strict, noUncheckedIndexedAccess)
  src/
    main.tsx
    app/
      App.tsx               // routes: ProjectsHome | Editor
      shortcuts.ts          // §10 table + useShortcuts()
      theme.css             // CSS variables (dark CapCut palette), reset, typography
    core/                   // PURE — no React, no DOM. Most tests live here.
      time.ts               // Us, secToUs, snapToFrame, formatTimecode
      model.ts              // types §2 + factories (createProject, createClip…)
      defaults.ts           // default props, aspect → resolution table
      query.ts              // clipsAt, sourceTime, trackEnd, projectDuration, findAdjacent
      props.ts              // resolveProps, keyframe interpolation stub, animFrame
      transitions.ts        // transitionFrame(type,p), catalogue
      audioMath.ts          // dbToLin, fadeEnvelope
      snap.ts               // snap candidates + nearest
      ops/                  // split.ts trim.ts move.ts delete.ts speed.ts tracks.ts transitions.ts
      migrations.ts
    store/
      index.ts              // create store (doc / ui / playback slices)
      history.ts            // snapshot undo stack, beginTx/commitTx/cancelTx
      actions.ts            // thin wrappers: tx(label, () => ops.x(...))
    engine/                 // browser APIs, no React
      Engine.ts             // clock + rAF loop + sync
      ElementPool.ts
      compositor.ts         // renderFrame (shared with export)
      adjust.ts             // adjustToCssFilter / temp-tint pass  (WebGL later)
      text.ts               // layoutText, drawText
      audioGraph.ts         // preview Web Audio graph
    media/
      import.ts             // File → IDB blob → probe → MediaAsset
      probe.ts              // Mediabunny Input metadata
      thumbnails.ts         // CanvasSink queue + cache
      waveform.ts + waveform.worker.ts
    export/
      exportMp4.ts          // §7
      offlineMix.ts         // OfflineAudioContext render
    persistence/
      db.ts                 // idb schema
      projects.ts           // save/load/list/delete, autosave subscriber
      assetUrls.ts          // object URL registry
    ui/
      layout/               // TopBar, EditorLayout (resizable 4-pane grid), Panel
      left/                 // ToolTabs + MediaBin, AudioTab, TextTab, TransitionsTab, FiltersTab, AdjustmentTab
      player/               // Player (canvas host), PlayerControls (timecode, play, Ratio, fullscreen)
      inspector/            // Inspector shell + VideoBasic, AudioBasic, Speed, Animation, Adjust, TextPanel
      timeline/             // Timeline, Toolbar, Ruler, TrackHeader, TrackRow, ClipView, TransitionView,
                            //   Playhead, Filmstrip, Waveform, ZoomSlider, useTimelineGesture.ts
      controls/             // Slider (with numeric input + reset), NumberField, Toggle, Tabs, Icon, Modal
      home/                 // ProjectsHome
  tests/
    fixtures/               // tiny generated media
    e2e/                    // Playwright specs
  docs/
    capcut-screens/  research/
```

The `core` → `store` → `engine/ui` dependency direction is one-way, enforced with an ESLint
`import/no-restricted-paths` rule: `core` imports nothing app-specific.

---

## 13. Dependencies (minimal)

`react`, `react-dom`, `zustand`, `immer`, `nanoid`, `idb`, `mediabunny`.
Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `jsdom`,
`@testing-library/react`, `@playwright/test`, `eslint`.
There is no UI kit, Tailwind or ffmpeg.wasm. Icons are inline SVG components.

---

## 14. Suggested split for the parallel build agents

The contracts between agents are the files `core/model.ts` and `store/actions.ts`, so **agent A
lands those first** and the others build against them.

| Agent | Owns | Depends on |
|---|---|---|
| A — Core and store | `core/**`, `store/**`, their unit tests | (first) |
| B — Shell and theme | `app/**`, `ui/layout`, `ui/controls`, `ui/home`, the CSS variables, top bar, left tabs shell | model types |
| C — Player and engine | `engine/**`, `ui/player` | A |
| D — Timeline | `ui/timeline/**`, the snapping UI, gestures, toolbar, shortcuts | A |
| E — Media and persistence | `media/**`, `persistence/**`, MediaBin, thumbnails, waveforms | A |
| F — Inspector | `ui/inspector/**` (Video Basic, Audio, Speed, Animation, Adjust, Text) | A, C (live preview) |
| G — Export | `export/**`, the export modal | A, C (`compositor`) |
| H — QA | Playwright e2e, the invariant tests, a bug bash, fix-or-file | all |

---

## Sources

- mp4-muxer is deprecated in favour of Mediabunny: <https://raw.githubusercontent.com/Vanilagy/mp4-muxer/HEAD/MIGRATION-GUIDE.md>
- Mediabunny guide: <https://mediabunny.dev/guide/introduction>
- Mediabunny talk, client-side media processing: <https://university.svta.org/conference-proceedin/performant-and-accessible-client-side-media-processing-with-mediabunny/>
- Omniclip, an open-source WebCodecs editor (state → actions → controllers → views, custom-element timeline): <https://docsearch.algolia.com/mcp/docs/repo/omni-media/omniclip>
- A local-first browser editor with WebCodecs, WebGPU and WASM: <https://dev.to/martindelophy/how-i-built-a-local-first-ai-video-editor-with-webcodecs-webgpu-and-wasm-4lkn>
- FOSDEM 2026, browser and backend media processing: <https://fosdem.org/2026/events/attachments/ZFUHDH-bridging_the_gap_between_browser_and_backend_media_processing/slides/266741/presentat_001td9g.pdf>
- Remotion blog (WebCodecs and Mediabunny in practice): <https://www.remotion.dev/blog>
