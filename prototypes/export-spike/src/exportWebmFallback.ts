// Fallback for browsers without WebCodecs H.264: real-time MediaRecorder on canvas.captureStream().
// Real time only, not frame-exact, output is WebM (VP8/VP9 + Opus). Behind a flag in the editor.
import type { Us } from './renderFrame';
import type { ExportOptions } from './exportMp4';
import { ExportCanceled } from './exportMp4';

export interface WebmResult { blob: Blob; mimeType: string; encodeMs: number }

export function pickRecorderMime(): string | null {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? null;
}

export async function exportWebm(o: ExportOptions): Promise<WebmResult> {
  const mimeType = pickRecorderMime();
  if (!mimeType) throw new Error('Neither WebCodecs nor MediaRecorder WebM is available');

  const canvas = document.createElement('canvas'); // captureStream needs an HTMLCanvasElement
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const stream = canvas.captureStream(o.fps);

  // Audio: play the pre-rendered offline mix into a MediaStream destination in real time.
  let ac: AudioContext | null = null;
  let player: AudioBufferSourceNode | null = null;
  if (o.audio) {
    ac = new AudioContext({ sampleRate: o.audio.sampleRate });
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    player = ac.createBufferSource();
    player.buffer = o.audio;
    player.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }

  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: o.videoBitrate, audioBitsPerSecond: o.audioBitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));

  const frames = Math.round((o.durationUs * o.fps) / 1e6);
  const t0 = performance.now();
  await o.render(ctx, 0, 0);
  rec.start(250);
  player?.start();
  let canceled = false;
  try {
    // Wall-clock driven: draw whatever frame corresponds to "now". Frames can drop.
    await new Promise<void>((resolve, reject) => {
      const tick = async () => {
        if (o.signal?.aborted) return reject(new ExportCanceled());
        const elapsedUs: Us = (performance.now() - t0) * 1000;
        if (elapsedUs >= o.durationUs) return resolve();
        const f = Math.min(frames - 1, Math.floor((elapsedUs * o.fps) / 1e6));
        await o.render(ctx, Math.round((f * 1e6) / o.fps), f);
        o.onProgress?.({ frame: f + 1, frames, fraction: (f + 1) / frames });
        setTimeout(tick, 1000 / o.fps / 2); // setTimeout, not rAF: rAF stalls in hidden tabs
      };
      tick();
    });
  } catch (e) {
    canceled = true;
    throw e;
  } finally {
    rec.stop();
    player?.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    await ac?.close();
  }
  if (canceled) throw new ExportCanceled();
  return { blob: new Blob(chunks, { type: mimeType }), mimeType, encodeMs: performance.now() - t0 };
}
