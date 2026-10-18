# 04 — Export spike (Mediabunny, H.264 + AAC MP4): verified

Status: **MP4 export verified end-to-end**, headless and headed, 18 Oct 2026.
Code: `prototypes/export-spike/` (own package, Mediabunny **1.61.6** — same version as the root
`package.json`). The builder of `src/export/` should copy `src/exportMp4.ts` and `src/offlineMix.ts`
from there almost verbatim.

```
cd prototypes/export-spike && npm install && npx playwright install chromium
npm run dev            # manual: http://localhost:5199  (?force=webm, ?sync=1, ?dur=30)
node prove.mjs         # 4 browser configs: MP4 + cancel + WebM fallback + 30 s throughput, ffprobe-checked
node sync.mjs [2112]   # A/V sync: 1-sample click at t=1.5 s, measures where it lands in the decoded MP4
```

## 1. What was proven

The page draws 90 frames (moving circle, rotating square, text, `frame NNN t=…` counter) on a
1080×1920 `OffscreenCanvas`, one frame per exact timestamp (not real time), mixes 3 s of stereo
audio with `OfflineAudioContext` (two oscillators → per-clip `GainNode` with fade-in/out
automation → destination, i.e. the editor's per-clip volume/fade graph), encodes with Mediabunny,
reports progress, supports cancel, and downloads through `<a download>`. Playwright captures the
download and `ffprobe -count_frames` checks it.

ffprobe of the output (every config):

| check | result |
|---|---|
| container | MP4 (`fastStart: 'in-memory'`, moov first) |
| video | `h264` / `avc1`, High profile, **1080×1920**, `30/1`, **90 frames**, stream duration **3.000 s** |
| audio | `aac` / `mp4a` (LC, `mp4a.40.2`), 2 ch, 48 kHz |
| container duration | 3.028 s (= the AAC stream; AAC pads to a 1024-sample frame — less than one video frame) |
| frame accuracy | decoded frame 45 shows `frame 045 t=1.500s` |
| A/V sync | click placed at 1.5 s decodes at sample 72000 exactly (**0 samples off**) — after the priming fix in §3.1 |
| cancel | abort at frame 30 → `ExportCanceled`, encoders released in ~170–270 ms, no download |

## 2. Codec support and performance (macOS, Apple Silicon)

| config (Playwright `chromium.launch`) | browser | `getFirstEncodableVideoCodec(['avc'])` / audio | 3 s MP4 | 30 s export (900 frames) |
|---|---|---|---|---|
| `{headless:true}` (chromium-headless-shell) | Chromium 156 | `avc` / `aac` | PASS, 3.1 MB | 7.0 s → **129 fps** (software encoder) |
| `{headless:true, channel:'chromium'}` (new headless) | Chromium 156 | `avc` / `aac` | PASS, 1.1 MB | 4.1 s → **222 fps** (VideoToolbox) |
| `{headless:true, channel:'chrome'}` | Chrome 155 | `avc` / `aac` | PASS, 1.1 MB | 4.0 s → **222 fps** |
| `{headless:false, channel:'chrome'}` | Chrome 155 | `avc` / `aac` | PASS, 1.2 MB | 4.1 s → **221 fps** |

- **No `--enable-features` flags were needed anywhere.** H.264 and AAC encode both work in plain
  headless Playwright Chromium on macOS. So the e2e export test can run in the default
  Playwright project; prefer `channel: 'chromium'` (new headless) since it uses the hardware
  encoder like real Chrome.
- The headless-shell build uses a software H.264 encoder: codec string `avc1.640c28`
  (constrained-High flag), pixel format `yuvj420p` (full range), and ~2.7× larger files at the same
  settings. Real Chrome/new-headless produce `avc1.640028`, `yuv420p`. Don't assert on exact sizes.
- Offline audio mix of 3 s: 3–12 ms. Whole 3 s export including mix: ~0.5–1.1 s.
- 7× real time at 1080×1920 with a trivial compositor. With real decoded clips the compositor and
  the `VideoSampleSink` decode will dominate; budget for maybe 2–4× real time.
- Not tested: Linux/Windows Chrome (AAC may be missing on Linux Chromium → the code already
  falls back to Opus-in-MP4 via `getFirstEncodableAudioCodec(['aac','opus'])`), Safari, Firefox.

## 3. API gotchas found (Mediabunny 1.61.6)

1. **AAC priming = audio 44 ms late unless compensated.** Chrome's AAC encoder prepends
   **2112 samples** of priming and stamps the first packet at t=0, and nothing reports it. Measured:
   a click at 1.5 s landed at 1.544 s. Fix (verified sample-exact on all configs): start the audio
   source at a negative timestamp,
   `new AudioBufferSource(cfg, { startTimestamp: -2112 / sampleRate })`. Mediabunny then writes an
   MP4 edit list (`elst`) that trims the priming; ffmpeg and players honour it. The spike makes this
   the default for `'aac'` (`AAC_PRIMING_SAMPLES`). It was measured only on macOS — **keep the sync
   check (click at known t → decode → find peak) in the e2e suite** so a different platform encoder
   is caught. Opus pre-skip was not tested.
2. **`bitrate` is deprecated** in `VideoEncodingConfig` / `AudioEncodingConfig` and the
   `canEncode*`/`getFirstEncodable*` options; use `quality: new Quality({ bitrate: 12e6 })`
   (or `new Quality('high')`). `QUALITY_HIGH` constants are deprecated too.
3. Bitrate is a VBR **target**, not a floor: 12 Mbps requested → ~3 Mbps on the simple 3 s
   content, ~6.8 Mbps on 30 s. Fine; pass `bitrateMode: 'constant'` in the `Quality` if a
   predictable size is ever needed.
4. Pass `frameRate: fps` in `output.addVideoTrack(src, { frameRate })` — it snaps timestamps to the
   frame grid. Compute `t = Math.round(f * 1e6 / fps)` per frame (µs, never accumulated), then
   `videoSource.add(t / 1e6, 1 / fps)`.
5. **Always `await` `videoSource.add()` / `audioSource.add()`** — that is the backpressure.
   Call `close()` on each source before `output.finalize()`.
6. Cancel = `output.cancel()` (state becomes `'canceled'`); check `signal.aborted` each frame and
   call `cancel()` in the `catch` unless the state is already `'canceled'`/`'finalized'`.
7. `CanvasSource` takes the canvas at construction and snapshots it on every `add()` — render into
   that same canvas each frame. Get its context with `{ alpha: false }`. Frames must not change size
   (`sizeChangeBehavior: 'deny'` default).
8. `output.getMimeType()` gives the exact codec string (`video/mp4; codecs="avc1.640028, mp4a.40.2"`).
9. **MediaRecorder WebM fallback has no duration** in its header (ffprobe: `duration=N/A`), so
   seeking is broken in some players. If the fallback ships, patch the duration (e.g. the small
   `fix-webm-duration` package) or remux through Mediabunny (`Input` → `Conversion` to WebM). It is
   real time (3 s took 3.01 s), not frame-exact (89–91 frames for 90), and VP9 + Opus.
10. `canvas.captureStream()` needs an `HTMLCanvasElement` (not `OffscreenCanvas`); drive the
    fallback with `setTimeout`, not `requestAnimationFrame`, which stalls in hidden tabs.
11. Spike harness note: when spawning vite from node with `stdio:'pipe'`, drain or inherit stderr
    or the dev server can die mid-run.

## 4. The pattern to copy (`src/export/exportMp4.ts`)

```ts
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec } from 'mediabunny';

export const AAC_PRIMING_SAMPLES = 2112;
export class ExportCanceled extends Error { constructor() { super('Export canceled'); } }

export async function exportMp4(o: {
  width: number; height: number; fps: number; durationUs: number;
  videoBitrate: number; audioBitrate: number;
  render: (ctx: OffscreenCanvasRenderingContext2D, t: number, frameIndex: number) => void | Promise<void>;
  audio: AudioBuffer | null;
  onProgress?: (p: { frame: number; frames: number; fraction: number }) => void;
  signal?: AbortSignal;
}): Promise<Blob> {
  const videoCodec = await getFirstEncodableVideoCodec(['avc'], {
    width: o.width, height: o.height, frameRate: o.fps, quality: new Quality({ bitrate: o.videoBitrate }) });
  if (!videoCodec) throw new Error('H.264 encoding not supported'); // → offer the WebM fallback
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: 2, sampleRate: 48000, quality: new Quality({ bitrate: o.audioBitrate }) });

  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, quality: new Quality({ bitrate: o.videoBitrate }), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: o.fps });
  let audio: AudioBufferSource | null = null;
  if (o.audio && audioCodec) {
    audio = new AudioBufferSource({ codec: audioCodec, quality: new Quality({ bitrate: o.audioBitrate }) },
      { startTimestamp: audioCodec === 'aac' ? -AAC_PRIMING_SAMPLES / o.audio.sampleRate : 0 });
    output.addAudioTrack(audio);
  }

  const onAbort = () => void output.cancel();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await output.start();
    if (audio && o.audio) await audio.add(o.audio);           // whole offline mix in one buffer
    const frames = Math.round(o.durationUs * o.fps / 1e6);
    for (let f = 0; f < frames; f++) {
      if (o.signal?.aborted) throw new ExportCanceled();
      const t = Math.round(f * 1e6 / o.fps);                 // integer µs
      await o.render(ctx, t, f);                               // ← the compositor
      await video.add(t / 1e6, 1 / o.fps);                     // backpressure
      o.onProgress?.({ frame: f + 1, frames, fraction: (f + 1) / frames });
    }
    video.close(); audio?.close();
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (e) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel();
    throw o.signal?.aborted ? new ExportCanceled() : e;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }
}
```

Offline mix (`src/export/offlineMix.ts`) — the shape that was encoded:

```ts
const ctx = new OfflineAudioContext(2, Math.ceil(durSec * 48000), 48000);
for (const c of clips) {
  const src = ctx.createBufferSource(); src.buffer = decoded(c.assetId); src.playbackRate.value = c.speed;
  const g = ctx.createGain();
  const t0 = c.start / 1e6, t1 = t0 + c.duration / 1e6;
  g.gain.setValueAtTime(c.fadeIn ? 0 : c.volume, t0);
  if (c.fadeIn) g.gain.linearRampToValueAtTime(c.volume, t0 + c.fadeIn / 1e6);
  g.gain.setValueAtTime(c.volume, Math.max(t0 + c.fadeIn / 1e6, t1 - c.fadeOut / 1e6));
  if (c.fadeOut) g.gain.linearRampToValueAtTime(0, t1);
  src.connect(g).connect(ctx.destination);
  src.start(t0, c.in / 1e6, (c.duration / 1e6) * c.speed);
}
const mix = await ctx.startRendering();   // → exportMp4({ audio: mix, ... })
```

(For a shared `fadeEnvelope()` with non-linear curves, use `setValueCurveAtTime` with the sampled
envelope instead of the two ramps.)

## 5. Plugging in the editor's compositor

`exportMp4` only needs `render(ctx, t, frameIndex)`. In the editor:

```ts
const blob = await exportMp4({
  width, height, fps: 30, durationUs: projectDuration(project),
  videoBitrate: 12e6, audioBitrate: 192e3,
  audio: await renderOfflineMix(project),
  render: async (ctx, t) => {
    await exportFrameSource.prepare(t);     // advance each visible clip's VideoSampleSink iterator to sourceTime(clip, t)
    renderFrame(ctx, project, t, exportFrameSource);   // the same compositor the preview uses
  },
  onProgress, signal: abortController.signal,
});
```

- `renderFrame` must accept `CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`
  (the spike's `Ctx2D` type) and stay DOM-free, so the whole loop can later move into a Worker
  unchanged.
- `exportFrameSource.prepare(t)` is the only async step: for each clip visible at `t`, pull from
  its monotonically advancing Mediabunny `VideoSampleSink`/`CanvasSink` iterator until the sample
  covering `sourceTime(clip, t)`; close (`sample.close()`) samples you skip. `renderFrame` then
  draws synchronously from what `prepare` left.
- Text must use fonts that are already loaded (`await document.fonts.ready`) before frame 0, or
  the first frames render in a fallback font.
- Fallback: if `getFirstEncodableVideoCodec(['avc'])` returns `null`, call the real-time
  `exportWebm()` (spike `src/exportWebmFallback.ts`) behind a flag, and fix its duration (§3.9).
- e2e: copy `prove.mjs`'s ffprobe checks (90 frames, 1080×1920, h264/avc1, aac, video duration
  exact, container duration within one frame) and `sync.mjs`'s click test.
