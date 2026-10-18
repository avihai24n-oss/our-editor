# Engine — the render contract

One rule: **the Player and the Exporter draw from the same pure function.**

```ts
import { getFrameState } from './frameState';
const fs = getFrameState(project, t /* µs */);
// fs = { t, width, height, background, ops: DrawOp[], audio: AudioOp[] }
```

`frameState.ts` is owned by the architect/QA and is unit-tested (`frameState.test.ts`).
Builder C writes everything that turns a `FrameState` into pixels and sound
(`render.ts`, the media element pool, the clock, the Web Audio graph) in this folder.
Need a change in `frameState.ts`? Write it in `docs/integration-notes/engine.md`.

## What `getFrameState` resolves for you

| Concern | Where it is resolved | What the renderer does |
|---|---|---|
| Which clips are visible at t | per track, half-open `[start, end)` | nothing |
| Layer order | `ops` is already bottom → top (`project.tracks` order; main first) | draw ops in order |
| Hidden tracks / disabled clips | skipped (hidden tracks still produce `audio`) | nothing |
| Media time | `MediaDrawOp.sourceTime` (µs) = inPoint + (t − start) × speed, clamped to `[0, asset.duration − 1]` | seek/show that frame (`/1e6` for `currentTime`) |
| Fit | `fitWidth/fitHeight` = contain-fit of the asset in the canvas at scale 1 | draw the media into that box |
| Transform | `transform` = clip transform × animation × transition, final | see drawing recipe |
| Blend | `composite` (a `GlobalCompositeOperation`) | `ctx.globalCompositeOperation = op.composite` |
| Filter + Adjust | `color: ColorOps` = adjust + filter preset × intensity, plus `grayscale`/`sepia` 0..1 | build `ctx.filter` / shader uniforms from it |
| Animation In/Out | applied into `transform`/`blur`; progress exposed as `op.animation` | nothing (info only) |
| Transitions | both clips emitted inside `[cut − d/2, cut + d/2)`, `from` then `to`, with effect applied; source frames held at the edges; dip transitions add a `FillDrawOp` | honour `clipRect` and `blur`; draw `fill` ops |
| Audio | `audio: AudioOp[]` with `sourceTime`, `speed`, `preservePitch`, `gain` (dB × fades); muted tracks/clips and videos with `hasAudio === false` are removed | play/sync elements, set gain |

## Drawing recipe (Canvas 2D, canvas backing store = `width × height`)

```ts
ctx.fillStyle = fs.background; ctx.fillRect(0, 0, W, H);
for (const op of fs.ops) {
  if (op.kind === 'fill') { ctx.globalAlpha = op.opacity; ctx.fillStyle = op.color; ctx.fillRect(0,0,W,H); continue; }
  ctx.save();
  if (op.clipRect) { ctx.beginPath(); ctx.rect(op.clipRect.x*W, op.clipRect.y*H, op.clipRect.w*W, op.clipRect.h*H); ctx.clip(); }
  ctx.globalAlpha = op.transform.opacity;
  ctx.globalCompositeOperation = op.composite;
  ctx.filter = cssFilterFrom(op.color, op.blur);         // builder's helper; temp/tint/vignette need extra passes
  ctx.translate(W/2 + op.transform.x, H/2 + op.transform.y);
  ctx.rotate(op.transform.rotation * Math.PI / 180);
  ctx.scale(op.transform.scale * (op.transform.flipH ? -1 : 1), op.transform.scale * (op.transform.flipV ? -1 : 1));
  if (op.kind === 'media') drawMedia(source, op);         // box = fitWidth × fitHeight centred on 0,0, minus op.crop
  else drawText(op);                                     // op.style, op.lines; centred on 0,0
  ctx.restore();
}
```

Units: positions are project pixels from the canvas centre, rotation in degrees, opacity 0..1,
`fontSize` in project pixels, `ColorOps` in CapCut slider units (−50..50, 0..100).

## Rules for the renderer

- **Never** compute visibility, timing, animation or transition math again — read it from the ops.
- Key media elements by `clipId`, not `assetId` (two clips of one asset can be on screen at once
  during a transition).
- `getAssetUrl(assetId)` (`src/media/registry.ts`) gives the object URL; `asset.missing` = "Media lost".
- The exporter steps `t = frame * 1e6 / fps` and calls `getFrameState` for each frame; audio is
  mixed offline from the same clip data (`dbToGain`, `fadeEnvelope` in `src/model/project.ts`).
