import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Quality,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type AudioCodec,
} from 'mediabunny';
import type { Ctx2D, Us } from './renderFrame';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  durationUs: Us;
  videoBitrate: number; // bps
  audioBitrate: number; // bps
  /** Draw the frame for time t (µs) onto ctx. The editor passes its compositor here. */
  render: (ctx: Ctx2D, t: Us, frameIndex: number) => void | Promise<void>;
  /** The offline audio mix (already rendered). null = no audio track. */
  audio: AudioBuffer | null;
  /**
   * Timestamp of the first audio sample, in seconds. Pass a NEGATIVE value equal to the AAC encoder's
   * priming delay to compensate it: Mediabunny then writes an MP4 edit list that trims the priming.
   * Default: -AAC_PRIMING_SAMPLES / sampleRate for AAC, 0 otherwise.
   */
  audioStartSec?: number;
  onProgress?: (p: { frame: number; frames: number; fraction: number }) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
  encodeMs: number;
}

/**
 * Chrome's AAC encoder (measured on macOS, Chrome 155 / Chromium 156) puts 2112 priming samples in front of the
 * audio and reports the first packet at t=0, so without compensation audio plays 44 ms late. Starting the audio
 * at -2112/sampleRate makes Mediabunny write an MP4 edit list that trims the priming: verified sample-exact.
 */
export const AAC_PRIMING_SAMPLES = 2112;

export class ExportCanceled extends Error {
  constructor() {
    super('Export canceled');
  }
}

/** Returns which codecs this browser can encode for the given config, or null for video if MP4 is impossible. */
export async function probeCodecs(o: Pick<ExportOptions, 'width' | 'height' | 'fps' | 'videoBitrate' | 'audioBitrate'>) {
  if (typeof VideoEncoder === 'undefined') return { video: null, audio: null };
  const video = await getFirstEncodableVideoCodec(['avc'], {
    width: o.width,
    height: o.height,
    frameRate: o.fps,
    quality: new Quality({ bitrate: o.videoBitrate }),
  });
  // AAC first; Opus-in-MP4 as a fallback (some Linux Chromium builds have no AAC encoder).
  const audio = typeof AudioEncoder === 'undefined'
    ? null
    : await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: 2,
        sampleRate: 48000,
        quality: new Quality({ bitrate: o.audioBitrate }),
      });
  return { video, audio };
}

export async function exportMp4(o: ExportOptions): Promise<ExportResult> {
  const { video: videoCodec, audio: audioCodec } = await probeCodecs(o);
  if (!videoCodec) throw new Error('H.264 encoding not supported in this browser (use the WebM fallback)');

  const canvas = new OffscreenCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    quality: new Quality({ bitrate: o.videoBitrate }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: o.fps });

  let audioSource: AudioBufferSource | null = null;
  if (o.audio && audioCodec) {
    audioSource = new AudioBufferSource(
      { codec: audioCodec, quality: new Quality({ bitrate: o.audioBitrate }) },
      { startTimestamp: o.audioStartSec ?? (audioCodec === 'aac' ? -AAC_PRIMING_SAMPLES / o.audio.sampleRate : 0) },
    );
    output.addAudioTrack(audioSource);
  }

  const abort = () => void output.cancel();
  o.signal?.addEventListener('abort', abort, { once: true });
  const t0 = performance.now();
  try {
    await output.start();

    // Audio first: it is one buffer, cheap, and the muxer interleaves by timestamp anyway.
    if (audioSource && o.audio) await audioSource.add(o.audio);

    const frames = Math.round((o.durationUs * o.fps) / 1e6);
    for (let f = 0; f < frames; f++) {
      if (o.signal?.aborted) throw new ExportCanceled();
      const t = Math.round((f * 1e6) / o.fps); // integer µs, never accumulated
      await o.render(ctx, t, f);
      await videoSource.add(t / 1e6, 1 / o.fps); // awaits encoder backpressure
      o.onProgress?.({ frame: f + 1, frames, fraction: (f + 1) / frames });
    }
    videoSource.close();
    audioSource?.close();

    if (o.signal?.aborted) throw new ExportCanceled();
    await output.finalize();
    const mimeType = await output.getMimeType();
    const buf = output.target.buffer!;
    return {
      blob: new Blob([buf], { type: 'video/mp4' }),
      mimeType,
      videoCodec,
      audioCodec: audioSource ? audioCodec : null,
      encodeMs: performance.now() - t0,
    };
  } catch (e) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel();
    if (o.signal?.aborted) throw new ExportCanceled();
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', abort);
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
