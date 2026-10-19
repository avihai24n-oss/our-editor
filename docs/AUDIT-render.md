# Audit — player and render engine

Date: 2026-10-19. Branch `agent/qa-render`. Question: **does the preview show what the project says?**

Every row below has an automated assertion that reads pixels from the **real player canvas** in
Chromium (`e2e/audit-render.spec.ts`, 14 tests) or checks the pure logic (`src/engine/frameAccuracy.test.ts`,
14 tests). The expected value always comes from the document or a closed-form formula, never from the
engine under test.

**Test media** is built by ffmpeg on the first run into `e2e/audit-media/` (git-ignored, `e2e/audit-helpers.ts`):

- **Frame-coded clips** (270×480, 30 fps, 12 s): a testsrc2 picture, an identity band (A red, B blue,
  silent clip green) and a **10-bit frame-number strip**. The frame on the canvas is decoded exactly.
- **Flat PNGs** with exact RGB values: A = (200,100,50), B = (100,150,200), a white square, a
  quadrant image and a landscape image. These are generated through `geq`, because the lavfi colour
  source goes through YUV and turns 200,100,50 into 197,100,48.

The player canvas in the test viewport is 262×466 (≈ 0.24× project resolution). Geometry tolerances are therefore
a few project px, and colour tolerances are ±3 / 255 unless noted.

## Summary

| | |
|---|---|
| Assertions | ~120 pixel / number checks in 14 browser tests, plus 14 unit tests |
| Fixed | **5 bugs**: wrong frame with speed (preview and export), picture behind sound, wrong frame at every cut, wrong frame on pause, jump back on pause. Each has a root-cause fix and a regression test that failed on the old code |
| Still broken | none. Three known limits are listed at the end |

## Results

### Frame accuracy (paused, after a seek)

| Item | Expected | Measured | Result |
|---|---|---|---|
| Plain clip, 10 seeks (frames 0, 1, 2, 15, 29, 30, 31, 100, 211, 359) | source frame = inPoint + (t − start) × speed | 10 / 10 exact | pass |
| Canvas vs **ffmpeg reference frames** (n = 7, 45, 200; MAE vs n−2…n+2) | best match = n | best = n every time. MAE 4.5–5.2 vs ≥ 7.25 for the neighbours | pass |
| After a split at 4 s (frames 119/120/121/200) | continuous source frames | 4 / 4 exact | pass |
| After a trim-left (+1 s on the second piece, which ripples back to 4 s) | in-point 5 s → frames 150, 151, 187 | exact | pass |
| Speed 0.5× (5 seeks), 1.5× (4 seeks) | floor(source time × 30) | exact | pass |
| **Speed 2×** at timeline frames 1 and 7 | source frames 2 and 14 | **was 1 and 13** → now exact | **fixed (bug 1)** |
| **Speed 10×** (preview frames 1, 2, 3, 17, 35) | 10, 20, 30, 170, 350 | **was one frame early** → now exact | **fixed (bug 1)** |
| **Export = preview** at 10×, all 36 exported frames decoded with ffmpeg | frame k = source 10k | 36 / 36 exact (the export reader only had a 1 µs margin, so it failed above ~2×) | **fixed (bug 1)** |
| Unit: every timeline frame (400 per case) at 24/25/30/60 fps × 12 speeds (0.1×–100×) × in-points 0 and 37 | exact rational source frame | 0 mismatches | pass (new) |

### Playback (10.5 s, two cuts, two assets; one sample per rendered frame)

| Item | Expected | Measured (before → after) | Result |
|---|---|---|---|
| The timeline clock is the AudioContext clock | 10 s of timeline = 10 s of AudioContext time | 10.484 s vs 10.484 s | pass |
| **Picture vs clock** (decoded canvas frame − frame for the clock time) | ≤ 1 frame behind, never ahead | p50 **−2 → −1** frames, mean **−1.55 → −0.77**, never ahead (max 0) | **fixed (bug 2)** |
| Video element `currentTime` vs clock | < 0.75 frame | mean **−1.47 → −0.56** frames (−49 → −19 ms), p50 −0.29 | **fixed (bug 2)** |
| Sound (audio element) vs clock | p50 < 20 ms | p50 −6 ms, range −10.5…−2.5 ms | pass |
| Black frames while playing across cuts | 0 | 0 / 630 | pass |
| Frames from the wrong clip | 0 | 0 / 630 | pass |
| **First frame after each cut** | the new clip's first frame | **was 5 frames ahead** (B65 instead of B60, A185 instead of A180) → now exact | **fixed (bug 3)** |
| **Pause**: frame on screen = frame of the stored playhead, no jump back | equal, ≥ last played frame | **was 1 frame off** (playhead → 74, element left on 75). Now 75 = 75 and the last played frame was 74 | **fixed (bugs 4 + 5)** |
| Scrub while playing (setPlayhead 6 s) | keeps playing from 6 s, picture follows | playhead 6.69 s 0.7 s later, shows B#140 (expected ≈ 140) | pass |
| End of timeline | stops at the end, last frame stays, timecode 12:00 / 12:00 | stops at 12 000 000 µs, shows A#299 (last frame), not black | pass (after a fix to the end frame, see bug 1 note) |
| Play when the playhead is at the end | restarts from 0 | restarts (0.28 s after 300 ms) | pass. **There is no loop toggle in v1**, which is not a bug |
| Clip without an audio stream | plays, and no voice is created for it | frames advance (S#38 after 1.2 s); 1 voice (the music only) | pass |

### Layering

| Item | Expected | Measured | Result |
|---|---|---|---|
| Main track under everything | A | (200,100,50) | pass |
| Overlay above main | B | (100,150,200) | pass |
| Text (background) on top of the overlay | magenta | (255,0,255). 546 green glyph px | pass |
| Hidden text track / hidden overlay track / disabled clip | not drawn | the layer below shows exactly | pass |

### Transform (white 1080² square on black)

| Item | Expected | Measured | Result |
|---|---|---|---|
| Scale 1 / 0.5 | box y 420…1500 / 270…810 × 690…1230 | edges exact / 272…812 × 688…1228 (± 2 px = less than 1 canvas px) | pass |
| Position (+200, −300) | 470…1010 × 390…930 | 469.9…1009.9 × 391.6…931.6 | pass |
| Rotation 45° | diamond with diagonal 763.7 | tip in, old corner out, middle-row width 750 (anti-aliased tips at 0.24×) | pass |
| Rotation 90° (quadrant image) | old top-left (red) → top-right | red | pass |
| Opacity 50 % | 127.5 | 128 | pass |
| Blend checkbox off | opacity ignored → 255 | 255 | pass |
| Mirror H / V | TL shows green / blue | green / blue | pass |

### Blend modes (A under B; W3C compositing formulas)

| Mode | Expected | Measured | Result |
|---|---|---|---|
| multiply | 78,59,39 | 78,59,39 | pass |
| screen | 222,191,211 | 222,191,211 | pass |
| darken / lighten | 100,100,50 / 200,150,200 | equal | pass |
| overlay / hard-light | 188,118,78 / 157,127,167 | equal | pass |
| color-dodge / color-burn | 255,243,232 / 115,0,0 | equal | pass |
| soft-light | 191,111,86 | 191,111,86 | pass |
| multiply at 50 % opacity | 139,79,45 | 139,79,45 | pass |
| Blend section off | normal 100 % | B | pass |

### Filters and Adjust (on A)

| Item | Expected (documented formula) | Measured | Result |
|---|---|---|---|
| Brightness ±50 | × 1.5 / × 0.5 | 255,150,75 / 100,50,25 | pass |
| Exposure +50 | × 2 | 255,200,100 | pass |
| Contrast +50 | (v − 127.5) × 1.5 + 127.5 | 236,86,11 | pass |
| Saturation −50 | grey (Rec.709 luma 118) | 118,118,118 | pass |
| Temperature +50 / Tint −50 | 22 % #ff9628 / 15 % #28dc5a | 212,111,48 / 176,118,57 | pass |
| Fade 100 | 40 % grey | 171,111,81 | pass |
| Vignette 100 | centre unchanged, corners darkened (up to 85 %) | centre exact; corner 33,17,8 | pass |
| Highlights / Shadows / Sharpen | v1 approximations (`color.ts`); they must change the picture | change it (231,107,45 / 212,113,64 / 207,97,42) | pass (approximation by design) |
| Adjust checkbox off | sliders ignored | A | pass |
| Filter B&W 100 % / 50 % | luma / 50 % mix | 118 / 159,109,84 | pass |

### Text style

| Item | Expected | Measured | Result |
|---|---|---|---|
| Colour red → blue | all glyph px change | 714 red px → 0 red, 714 blue | pass |
| Centred on the canvas | block centre (540, 960) | x 214…866, y 862…1051 | pass |
| Stroke 8 px yellow | ring ≈ 8 px outside the fill, fill kept | 1466 yellow px, 8.2 px outside the fill | pass |
| Background 100 % | content + 0.3 × size padding (height 300) | height 297 | pass |
| Background 50 % over black | 0,127.5,0 | 0,126,0 | pass |
| Align left / centre / right (short 2nd line) | at the block's left / centre / right | 218 / 540 / 862 (block 214…866) | pass |

### Animation (In/Out, duration 1 s)

| Item | Expected | Measured | Result |
|---|---|---|---|
| Fade in p = 0.25 / 0.5 | α = easeOutCubic(p) = 0.578 / 0.875 | 115,57,28 / 175,87,43 | pass |
| Slide left in p = 0.5 | offset W × 0.125 = 135 | empty at x 125, covered at 145 | pass |
| Zoom in p = 0.5 | scale 0.9375 → edge at 33.75, α 0.875 | out at 25, 175,87,43 at 45 | pass |
| Fade out p = 0.5 / 0.75 | α = 1 − easeInOutCubic = 0.5 / 0.0625 | 100,50,25 / 13,6,3 | pass |
| Slide down out p = 0.5 | top edge at y 960 | black at 950, A at 975 | pass |

### Transitions (1 s, A → B)

| Item | Expected | Measured | Result |
|---|---|---|---|
| Mix 25 / 50 / 75 % | linear mix | 175,113,87 / 150,125,125 / 125,137,163 | pass |
| Black fade 25 / 50 / 75 % | A × 0.5 / black / B × 0.5 | exact | pass |
| White flash 50 % | white | white | pass |
| Wipe right 25 / 50 / 75 % | edge at easeInOutCubic(p) × W = 67.5 / 540 / 1012.5 | B left of the edge, A right of it, ± 12 px | pass |
| Slide left 50 % / slide up 25 % | split at x 540 / y 1800 | exact | pass |
| Blur 50 % / Zoom 75 % (centre) | 50 % mix / easeInOutCubic(0.75) mix | 150,125,125 / 106,146,190 | pass |
| Before / after the window | A / B only | exact | pass |

### Ratio and letterboxing (9:16 media)

| Ratio | Media x expected | Measured | Result |
|---|---|---|---|
| 9:16 (262×466 canvas) | 0…1080 | 0…1080 | pass |
| 16:9 (711×400) | 656.3…1263.8, black pillars | 656.2…1263.8 | pass |
| 1:1 (467×467) | 236.3…843.8 | 235.9…844.1 | pass |
| 4:5 (373×466) | 160.3…919.7 | 159.2…920.8 | pass |
| 3:4 (350×467) | 135…945 | 135.8…944.2 | pass |
| Landscape media in 9:16 | letterbox y 656.3…1263.8 | 655.4…1265.5 | pass |

### Image clips, audio-only regions, clips with no audio

| Item | Expected | Measured | Result |
|---|---|---|---|
| Image clips | exact RGB | every pixel check above uses image clips | pass |
| Audio-only region (music, no picture) | 100 % black, 0 draw ops, 1 audio op | 100 % black, 0 / 1 | pass |
| After the main video ends, music continues | black | 100 % black | pass |
| Video without an audio stream | no audio op, no voice | music audio op only | pass |

### On-canvas selection box

| Item | Expected | Measured | Result |
|---|---|---|---|
| The box matches the drawn pixels | 131 × 131 css px | 131.0 × 131.0 | pass |
| Drag the body (+90, +60) css px | x, y += 90/k, 60/k = 371.0, 247.3 | 371, 247; the pixels moved the same | pass |
| Corner-scale (SE handle +40, +25 css px) | 0.5 × \|p1 − c\| / \|p0 − c\| = 0.754, position unchanged | 0.754, position unchanged; the drawn size matches | pass |
| One undo step per gesture | undo → 0.5 | 0.5 | pass |

## Bugs fixed

| # | Bug (what the user would see) | Root cause | Fix | Regression tests |
|---|---|---|---|---|
| 1 | **Wrong frame with Speed.** At 2× the preview showed the frame before the right one at half the frames, and from about 3× the export did too, so preview and export disagreed. | Timeline frame times are whole µs (frame 1 = 33 333 µs, not 33 333.3). The speed multiplies the rounding: at 2×, frame 1 maps to 66 666 µs, while source frame 2 starts at 66 666.7 µs. An exact lookup lands one frame early. The exporter's 1 µs margin covered 2× but not 10× (3.3 µs). | `FRAME_LOOKUP_EPS_US = 100` and `frameLookupSec()` in `frameState.ts`, used by the player pool, the MP4 export reader and the WebM fallback. 100 µs is above the worst rounding (≈ 51 µs at 100×) and far below half a frame at 240 fps. Side effect: "end − 1 µs" for the end-of-timeline frame now hit the frame *after* the out-point, so the player shows the start of the last project frame instead (`PreviewEngine.invalidate`). | e2e: speed 2× / 10× seeks; export at 10×, all 36 frames decoded. Unit: 4 fps × 12 speeds × 400 frames; export reader; split piece with an in-point |
| 2 | **Picture ~50 ms behind the sound** while playing (lip-sync error) | `play()` starts the muted preview `<video>` ~1.5 frames late. The only correction was a re-seek past 150 ms of drift, so the offset stayed for the whole playback. | `decideSync({ nudge: true })` for the preview videos: inside the drift limit the playbackRate is nudged (≤ ±8 %, it closes the drift over 0.5 s) with a dead band. Audible elements are never nudged (it would bend the pitch). | e2e: drift p50 ≥ −1 frame, never ahead, element drift < 0.75 frame. Unit: `nudgedRate` / `decideSync` cases |
| 3 | **Jump at every cut**: the first frame of the next clip came from 5 frames later, then the picture jumped back | The look-ahead preload parked the next clip's `<video>` on the frame *at t + 0.8 s*, i.e. mid-clip, and that frame was drawn at the cut while the corrective seek was in flight | `MediaPool.preload(ops, t)` parks an upcoming clip on the frame it **enters** with (its in-point) | e2e: the first frame after both cuts is exact. Unit: preload parks at the in-point |
| 4 | **Pausing showed the wrong frame** (one frame off the playhead) | Paused tolerance was "half a frame" of time, which still straddles a frame boundary half the time (element at 2.510 s, target 2.4995 s: 10.5 ms apart but frames 75 vs 74) | Paused / stepped frames use a 1 ms tolerance (`PAUSED_TOLERANCE_SEC`). After one seek, `currentTime` equals the target. | e2e pause check; unit test with the measured numbers |
| 5 | **Picture jumped back a frame on pause** | The store playhead is written at most every 33 ms. Pausing rendered that stale value. | `stopPlayback` writes the clock's final time to the store, unless the pause itself moved the playhead (a scrub, undo or step keeps the user's playhead) | e2e: frame after pause ≥ last played frame |

## Known limits (not fixed, by design or out of scope)

- **About 3 frames of hold right after a cut while playing.** The incoming `<video>` needs ~70 ms to
  start. It shows its correct first frame, holds it, then catches up within ~0.5 s. Removing the
  hold needs pre-rolling the next element before the cut, which is a design change.
- **No loop playback toggle** in v1. Play at the end restarts from 0.
- **Highlights / Shadows / Sharpen** are approximations (brightness/contrast stand-ins), as documented
  in `src/engine/render/color.ts`. A per-pixel tone curve / convolution is on the v2 WebGL backlog.

## Runs (all passing)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 361 / 361 (24 files; +14 in `src/engine/frameAccuracy.test.ts`) |
| `npm run build` | passes |
| `e2e/audit-render.spec.ts` | 14 / 14 (45 s) |
| `smoke`, `flows`, `shortcuts`, `timeline-stability`, `file-drop`, `memory` | 1, 1, 2, 7, 2, 2 pass (run one at a time through the browser lock) |
