/**
 * Frame-exact MP4 (H.264 + AAC) export with WebCodecs through Mediabunny — the verified recipe
 * from docs/research/04-export-spike.md (AAC priming compensation, backpressure, cancel).
 * The task brief named the 'mp4-muxer' package; Mediabunny is its successor by the same author,
 * already installed and spike-verified, so no new dependency is needed.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import type { Ctx2D } from '../engine/render';
import type { Us } from '../model/types';
import { frameCount } from './settings';
import { createWatchdog } from './watchdog';

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  durationUs: Us;
  videoBitrate: number;
  audioBitrate: number;
  /** Draw frame `frameIndex` (timeline time t µs) onto ctx (canvas = width × height). */
  render: (ctx: Ctx2D, t: Us, frameIndex: number) => void | Promise<void>;
  audio: AudioBuffer | null;
  onProgress?: (p: { frame: number; frames: number; fraction: number }) => void;
  signal?: AbortSignal;
  /** No progress for this long fails the export with ExportStalled (default EXPORT_STALL_MS). */
  stallMs?: number;
  /** What the frame source is waiting for, named in the stall error. */
  stallDetail?: () => string | null;
}

export interface EncodeResult {
  blob: Blob;
  mimeType: string;
  ext: 'mp4' | 'webm';
}

/** Chrome's AAC encoder prepends 2112 priming samples; start audio at −2112/sr so the edit list trims them. */
export const AAC_PRIMING_SAMPLES = 2112;

export class ExportCanceled extends Error {
  constructor() {
    super('Export canceled');
    this.name = 'ExportCanceled';
  }
}

export const hasWebCodecs = (): boolean => typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

export async function probeCodecs(o: Pick<EncodeOptions, 'width' | 'height' | 'fps' | 'videoBitrate' | 'audioBitrate'>): Promise<{ video: VideoCodec | null; audio: AudioCodec | null }> {
  if (!hasWebCodecs()) return { video: null, audio: null };
  const video = await getFirstEncodableVideoCodec(['avc'], {
    width: o.width,
    height: o.height,
    frameRate: o.fps,
    quality: new Quality({ bitrate: o.videoBitrate }),
  });
  const audio =
    typeof AudioEncoder === 'undefined'
      ? null
      : await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000, quality: new Quality({ bitrate: o.audioBitrate }) });
  return { video, audio };
}

export async function exportMp4(o: EncodeOptions, codecs?: { video: VideoCodec | null; audio: AudioCodec | null }): Promise<EncodeResult> {
  const { video: videoCodec, audio: audioCodec } = codecs ?? (await probeCodecs(o));
  if (!videoCodec) throw new Error(`H.264 encoding at ${o.width}×${o.height} is not supported in this browser.`);

  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Cannot create a 2D canvas for export.');

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, quality: new Quality({ bitrate: o.videoBitrate }), keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: o.fps });

  let audioSource: AudioBufferSource | null = null;
  if (o.audio && audioCodec) {
    audioSource = new AudioBufferSource(
      { codec: audioCodec, quality: new Quality({ bitrate: o.audioBitrate }) },
      { startTimestamp: audioCodec === 'aac' ? -AAC_PRIMING_SAMPLES / o.audio.sampleRate : 0 },
    );
    output.addAudioTrack(audioSource);
  }

  const abort = () => void output.cancel().catch(() => undefined);
  o.signal?.addEventListener('abort', abort, { once: true });
  // every await below can block forever if WebCodecs stops answering: guard each step
  const dog = createWatchdog(o.stallMs, o.stallDetail);
  try {
    await dog.guard(output.start(), 'the start');
    if (audioSource && o.audio) await dog.guard(audioSource.add(o.audio), 'the audio track');
    const frames = frameCount(o.durationUs, o.fps);
    for (let f = 0; f < frames; f++) {
      if (o.signal?.aborted) throw new ExportCanceled();
      const t = Math.round((f * 1e6) / o.fps); // integer µs, never accumulated
      await dog.guard(
        (async () => {
          await o.render(ctx, t, f);
          await videoSource.add(t / 1e6, 1 / o.fps); // backpressure
        })(),
        `video frame ${f + 1} / ${frames}`,
      );
      o.onProgress?.({ frame: f + 1, frames, fraction: (f + 1) / frames });
    }
    videoSource.close();
    audioSource?.close();
    if (o.signal?.aborted) throw new ExportCanceled();
    await dog.guard(output.finalize(), 'the final step (muxing)');
    const buf = output.target.buffer;
    if (!buf) throw new Error('The encoder produced no data.');
    return { blob: new Blob([buf], { type: 'video/mp4' }), mimeType: await output.getMimeType(), ext: 'mp4' };
  } catch (e) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => undefined);
    if (o.signal?.aborted) throw new ExportCanceled();
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', abort);
  }
}

/** Real browser download through <a download> (Playwright-visible). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
