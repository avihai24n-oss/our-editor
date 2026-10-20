/**
 * Offline audio mix for export. Same audibility rules as getFrameState's audio ops:
 * muted tracks / clips, disabled clips, videos with hasAudio === false and lost media are
 * silent; hidden tracks still sound. One AudioBufferSourceNode per clip → GainNode
 * (volume dB × linear fades) → destination of an OfflineAudioContext.
 *
 * Per clip, in this order (the preview runs the same stages, see player/audioEngine.ts):
 *  1. speed mapping — standard speed or a curve, through the clip's own time mapping
 *     (model/time.ts sourceOffsetAt, the same integral as getFrameState). The clip is rendered to
 *     a rate-1 buffer: "Change audio pitch" on → resampled (pitch follows speed); off (default,
 *     like the preview's `preservesPitch`) → WSOLA time-stretch, pitch preserved
 *     (./audioDsp.ts stretchMapped — the one stretcher for standard speed and curves);
 *  2. the FX chain (src/audio/dsp.ts): fill channel, reduce noise, voice isolation, voice filter — its pitch
 *     shifter only carries the voice filter now (no speed compensation needed after 1.);
 *  3. the gain stage: volume × normalize × fades;
 * then every clip sums on the bus (the context destination) and the finished mix goes through
 * a peak limiter so overlapping loud clips cannot clip.
 */
import { buildFxChain, fxFromAudio, type FxConfig } from '../audio/dsp';
import { normalizeGainDb } from '../audio/loudness';
import { measureAudioBuffer } from '../audio/measure';
import { profileForBuffer } from '../audio/noiseProfile';
import { ensureWorklets } from '../audio/worklets';
import { dbToGain } from '../model/project';
import type { SpeedCurve } from '../model/speedCurve';
import { sourceOffsetAt, sourceSpan } from '../model/time';
import type { AudioProps, Id, Project, Us } from '../model/types';
import { limitPeaks } from './audioDsp';
import { resampleMapped, sampledMap, stretchMapped } from './timeStretch';

export const MIX_SAMPLE_RATE = 48_000;

export interface MixClip {
  clipId: Id;
  assetId: Id;
  startSec: number;
  durationSec: number;
  /** Source in-point, seconds. */
  inSec: number;
  speed: number;
  /** Speed › Curve, or null. */
  speedCurve: SpeedCurve | null;
  /** Clip duration in µs (the curve is normalised over it). */
  durationUs: Us;
  inPointUs: Us;
  /** Keep the pitch at speed ≠ 1 (CapCut "Change audio pitch" off). */
  preservePitch: boolean;
  /** Linear gain from volume dB. */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Audio › Basic / Voice changer settings. */
  fx: Pick<AudioProps, 'normalize' | 'reduceNoise' | 'fillChannel' | 'voiceFilter'> & Partial<Pick<AudioProps, 'voiceIsolation'>>;
}

/**
 * The FX chain config for a planned clip. No speed compensation: the speed mapping already
 * renders the clip at rate 1 with its pitch kept (WSOLA) or deliberately changed (resample), so
 * the chain's pitch shifter only carries the voice filter — the same chain as the preview.
 */
export const mixFx = (c: Pick<MixClip, 'fx'>, noiseProfile: Float32Array | null = null): FxConfig => fxFromAudio(c.fx, 1, noiseProfile);

/** Which clips are heard in the export, in project order. Pure. */
export function planMix(project: Project): MixClip[] {
  const out: MixClip[] = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.disabled) continue;
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      if (clip.audio.muted) continue;
      const asset = project.assets[clip.assetId];
      if (!asset || asset.missing) continue;
      if (clip.type === 'video' && asset.hasAudio === false) continue;
      const volume = dbToGain(clip.audio.volumeDb);
      if (volume <= 0 || clip.duration <= 0) continue;
      out.push({
        clipId: clip.id,
        assetId: clip.assetId,
        startSec: clip.start / 1e6,
        durationSec: clip.duration / 1e6,
        inSec: clip.inPoint / 1e6,
        speed: clip.speed,
        speedCurve: clip.speedCurve ?? null,
        durationUs: clip.duration,
        inPointUs: clip.inPoint,
        preservePitch: clip.preservePitch !== false,
        volume,
        fadeInSec: Math.min(clip.audio.fadeIn, clip.duration) / 1e6,
        fadeOutSec: Math.min(clip.audio.fadeOut, clip.duration) / 1e6,
        fx: {
          normalize: !!clip.audio.normalize,
          reduceNoise: !!clip.audio.reduceNoise,
          fillChannel: clip.audio.fillChannel ?? null,
          voiceFilter: clip.audio.voiceFilter ?? null,
          voiceIsolation: clip.audio.voiceIsolation ?? null,
        },
      });
    }
  }
  return out;
}

/** Gain automation points (time sec, value) for one clip: 0→vol over fade-in, vol→0 over fade-out. */
export function gainPoints(c: Pick<MixClip, 'startSec' | 'durationSec' | 'volume' | 'fadeInSec' | 'fadeOutSec'>): [number, number][] {
  const t0 = c.startSec;
  const t1 = c.startSec + c.durationSec;
  let fi = Math.max(0, c.fadeInSec);
  let fo = Math.max(0, c.fadeOutSec);
  if (fi + fo > c.durationSec && fi + fo > 0) {
    const k = c.durationSec / (fi + fo);
    fi *= k;
    fo *= k;
  }
  const pts: [number, number][] = [[t0, fi > 0 ? 0 : c.volume]];
  if (fi > 0) pts.push([t0 + fi, c.volume]);
  if (fo > 0) {
    if (t1 - fo > t0 + fi) pts.push([t1 - fo, c.volume]);
    pts.push([t1, 0]);
  }
  return pts;
}

export type DecodeAsset = (assetId: Id) => Promise<AudioBuffer | null>;

export interface RenderMixOptions {
  /**
   * Integrated loudness (LUFS) of a clip's source span, for Normalize loudness. runExport passes
   * the shared measurer (src/audio/measure.ts) so the export uses the preview's number; the
   * default measures the decoded buffer.
   */
  loudness?: (c: MixClip, buf: AudioBuffer) => Promise<number | null>;
}

/** Linear normalize gain of a planned clip (1 when normalize is off or unmeasurable). */
export async function normalizeGainFor(c: MixClip, buf: AudioBuffer, o: RenderMixOptions = {}): Promise<number> {
  if (!c.fx.normalize) return 1;
  const lufs = o.loudness ? await o.loudness(c, buf) : measureAudioBuffer(buf, c.inSec, sourceOffsetAt({ duration: c.durationUs, speed: c.speed, speedCurve: c.speedCurve }, c.durationUs) / 1e6);
  return Math.pow(10, normalizeGainDb(lufs) / 20);
}

/** Renders the stereo mix of the whole timeline. Returns null when nothing is audible. */
export async function renderMix(project: Project, durationUs: number, decode: DecodeAsset, signal?: AbortSignal, o: RenderMixOptions = {}): Promise<AudioBuffer | null> {
  const plan = planMix(project);
  if (!plan.length || durationUs <= 0) return null;
  const durSec = durationUs / 1e6;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durSec * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE);
  const worklets = await ensureWorklets(ctx);
  let any = false;
  for (const c of plan) {
    if (signal?.aborted) return null;
    const buf = await decode(c.assetId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    if (!c.speedCurve && c.speed === 1) {
      src.buffer = buf;
    } else {
      // 1. speed mapping (rate-1 buffer of exactly the clip's length)
      const frames = Math.max(1, Math.round(c.durationSec * buf.sampleRate));
      src.buffer = speedMappedBuffer(ctx, buf, c, frames);
    }
    // 2. fx chain, 3. gain stage (volume × normalize × fades)
    // Voice isolation: the clip's noise profile — the preview's cached one, or measured now from
    // the same 48 kHz decode (identical numbers either way)
    const profile = c.fx.voiceIsolation?.mode === 'isolate' ? profileForBuffer(c.assetId, c.inSec, sourceSpanSec(c), buf) : null;
    const chain = buildFxChain(ctx, mixFx(c, profile), { worklets });
    const g = chain.output;
    const k = await normalizeGainFor(c, buf, o);
    const pts = gainPoints({ ...c, volume: c.volume * k });
    g.gain.setValueAtTime(pts[0]![1], pts[0]![0]);
    for (const [t, v] of pts.slice(1)) g.gain.linearRampToValueAtTime(v, t);
    // the clip ends here: cut effect tails (echo, reverb) like the preview does
    g.gain.setValueAtTime(0, c.startSec + c.durationSec);
    src.connect(chain.input);
    g.connect(ctx.destination); // → bus
    if (src.buffer === buf) {
      const offset = Math.min(c.inSec, Math.max(0, buf.duration - 1e-3));
      src.start(c.startSec, offset, c.durationSec);
    } else {
      src.start(c.startSec);
    }
    src.stop(c.startSec + c.durationSec);
    any = true;
  }
  if (!any) return null;
  const mix = await ctx.startRendering();
  limitPeaks(Array.from({ length: mix.numberOfChannels }, (_, i) => mix.getChannelData(i)), mix.sampleRate);
  return mix;
}

/** Source span heard by a planned clip, seconds (= sourceSpan(clip), the preview's span). */
const sourceSpanSec = (c: MixClip): number => sourceSpan({ duration: c.durationUs, speed: c.speed, speedCurve: c.speedCurve }) / 1e6;

/** Source time (seconds) heard at output sample n of the clip. */
export function mixSourceMap(c: Pick<MixClip, 'inPointUs' | 'durationUs' | 'speed' | 'speedCurve'>, sampleRate: number): (n: number) => number {
  const clip = { duration: c.durationUs, speed: c.speed, speedCurve: c.speedCurve };
  return (n: number) => (c.inPointUs + sourceOffsetAt(clip, (n / sampleRate) * 1e6)) / 1e6;
}

/** Channels of a clip's audio after its speed mapping (rate-1 output, `frames` long). */
export function speedMappedChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  c: Pick<MixClip, 'inPointUs' | 'durationUs' | 'speed' | 'speedCurve' | 'preservePitch'>,
  frames: number,
): Float32Array[] {
  const exact = mixSourceMap(c, sampleRate);
  const map = c.speedCurve ? sampledMap(exact, frames) : exact;
  return c.preservePitch ? stretchMapped(channels, sampleRate, frames, map) : resampleMapped(channels, sampleRate, frames, map);
}

function speedMappedBuffer(ctx: BaseAudioContext, buf: AudioBuffer, c: MixClip, frames: number): AudioBuffer {
  const channels: Float32Array[] = [];
  for (let i = 0; i < buf.numberOfChannels; i++) channels.push(buf.getChannelData(i));
  const out = speedMappedChannels(channels, buf.sampleRate, c, frames);
  const b = ctx.createBuffer(buf.numberOfChannels, frames, buf.sampleRate);
  out.forEach((data, i) => b.copyToChannel(data as Float32Array<ArrayBuffer>, i));
  return b;
}

/** Decoder with a per-asset cache; `load` returns the asset's file (IndexedDB blob). */
export function createDecoder(load: (assetId: Id) => Promise<Blob | null>): DecodeAsset {
  const cache = new Map<Id, Promise<AudioBuffer | null>>();
  return (assetId) => {
    let p = cache.get(assetId);
    if (!p) {
      p = (async () => {
        const blob = await load(assetId);
        if (!blob) return null;
        try {
          const ctx = new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE);
          return await ctx.decodeAudioData(await blob.arrayBuffer());
        } catch {
          return null; // no audio track / unsupported codec → silent
        }
      })();
      cache.set(assetId, p);
    }
    return p;
  };
}
