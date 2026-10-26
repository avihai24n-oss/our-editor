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
import { hasVolumeKeys, keysDbAt } from '../model/volumeKeys';
import type { SpeedCurve } from '../model/speedCurve';
import { localTimeForSourceOffset, mirrorInPoint, sourceOffsetAt, sourceSpan } from '../model/time';
import { reverseBuffer } from '../audio/reverse';
import { MAX_COMPOUND_DEPTH, sequenceTracks } from '../model/compound';
import type { AudioProps, Id, Project, Track, Us, VolumeKey } from '../model/types';
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
  /** Linear gain from volume dB (1 when `volumeKeys` carries the volume). */
  volume: number;
  /** Volume keyframes (source-positioned, see src/model/volumeKeys.ts); absent = flat `volume`. */
  volumeKeys?: VolumeKey[];
  fadeInSec: number;
  fadeOutSec: number;
  /**
   * Edit › Reverse: the clip reads the time-reversed media (src/audio/reverse.ts); `inSec` /
   * `inPointUs` are then in reversed media time and `realInSec` is the real span start.
   */
  reversed: boolean;
  /** Media (asset) duration, seconds — the reversal axis. */
  mediaSec: number;
  /** Real media time where the heard span starts, seconds (= inSec unless reversed). */
  realInSec: number;
  /** Audio › Basic / Voice changer settings. */
  fx: Pick<AudioProps, 'normalize' | 'reduceNoise' | 'fillChannel' | 'voiceFilter'> & Partial<Pick<AudioProps, 'voiceIsolation' | 'mixer'>>;
  /**
   * Compound clips (⌥G): the part of the timeline where this nested clip is heard, seconds (the
   * compound clip's window). Absent = the whole clip.
   */
  windowSec?: [number, number];
}

/**
 * The FX chain config for a planned clip. No speed compensation: the speed mapping already
 * renders the clip at rate 1 with its pitch kept (WSOLA) or deliberately changed (resample), so
 * the chain's pitch shifter only carries the voice filter — the same chain as the preview.
 */
export const mixFx = (c: Pick<MixClip, 'fx'>, noiseProfile: Float32Array | null = null): FxConfig => fxFromAudio(c.fx, 1, noiseProfile);

/** Which clips are heard in the export, in project order (clips nested in compound clips included). Pure. */
export function planMix(project: Project): MixClip[] {
  const out: MixClip[] = [];
  planTracks(project, project.tracks, 0, null, [], '', out);
  return out;
}

/**
 * Plans one track list. `shiftUs` maps its times to the timeline; `win` (timeline µs) is where it
 * can be heard (the enclosing compound clips' windows); `stack` guards against cycles.
 */
function planTracks(project: Project, tracks: readonly Track[], shiftUs: Us, win: [Us, Us] | null, stack: readonly Id[], prefix: string, out: MixClip[]): void {
  for (const track of tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.disabled) continue;
      if (clip.type === 'compound') {
        if (stack.length >= MAX_COMPOUND_DEPTH || stack.includes(clip.sequenceId)) continue;
        const inner = sequenceTracks(project, clip.sequenceId);
        if (!inner) continue;
        const a = clip.start + shiftUs;
        const b = a + clip.duration;
        const w: [Us, Us] = win ? [Math.max(win[0], a), Math.min(win[1], b)] : [a, b];
        if (w[1] <= w[0]) continue;
        planTracks(project, inner, a - clip.inPoint, w, [...stack, clip.sequenceId], `${prefix}${clip.id}/`, out);
        continue;
      }
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      if (clip.audio.muted) continue;
      const asset = project.assets[clip.assetId];
      if (!asset || asset.missing) continue;
      if (clip.type === 'video' && asset.hasAudio === false) continue;
      const keys = hasVolumeKeys(clip.audio) ? clip.audio.volumeKeys! : null;
      const volume = keys ? 1 : dbToGain(clip.audio.volumeDb);
      if (keys ? keys.every((k) => dbToGain(k.db) <= 0) : volume <= 0) continue;
      if (clip.duration <= 0) continue;
      const start = clip.start + shiftUs;
      if (win && (start + clip.duration <= win[0] || start >= win[1])) continue;
      out.push({
        clipId: prefix + clip.id,
        assetId: clip.assetId,
        startSec: start / 1e6,
        durationSec: clip.duration / 1e6,
        inSec: clip.inPoint / 1e6,
        speed: clip.speed,
        speedCurve: clip.speedCurve ?? null,
        durationUs: clip.duration,
        inPointUs: clip.inPoint,
        preservePitch: clip.preservePitch !== false,
        reversed: clip.reversed === true,
        mediaSec: asset.duration / 1e6,
        realInSec: (clip.reversed === true ? mirrorInPoint(asset.duration, clip.inPoint, sourceSpan(clip)) : clip.inPoint) / 1e6,
        volume,
        ...(keys ? { volumeKeys: keys.map((k) => ({ ...k })) } : {}),
        fadeInSec: Math.min(clip.audio.fadeIn, clip.duration) / 1e6,
        fadeOutSec: Math.min(clip.audio.fadeOut, clip.duration) / 1e6,
        fx: {
          normalize: !!clip.audio.normalize,
          reduceNoise: !!clip.audio.reduceNoise,
          fillChannel: clip.audio.fillChannel ?? null,
          voiceFilter: clip.audio.voiceFilter ?? null,
          voiceIsolation: clip.audio.voiceIsolation ?? null,
          ...(clip.audio.mixer ? { mixer: clip.audio.mixer } : {}),
        },
        ...(win && (start < win[0] || start + clip.duration > win[1]) ? { windowSec: [win[0] / 1e6, win[1] / 1e6] as [number, number] } : {}),
      });
    }
  }
}

/** The part of a planned clip that is heard: [from, to) seconds on the timeline. */
export function heardRange(c: Pick<MixClip, 'startSec' | 'durationSec' | 'windowSec'>): [number, number] {
  const a = c.startSec;
  const b = c.startSec + c.durationSec;
  return c.windowSec ? [Math.max(a, c.windowSec[0]), Math.min(b, c.windowSec[1])] : [a, b];
}

/** Gain points cut to [from, to]: the envelope's value at both edges, the points in between. */
export function clipGainPoints(pts: [number, number][], from: number, to: number): [number, number][] {
  const at = (x: number): number => {
    if (x <= pts[0]![0]) return pts[0]![1];
    for (let i = 1; i < pts.length; i++) {
      const [t1, v1] = pts[i]!;
      const [t0, v0] = pts[i - 1]!;
      if (x <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0);
    }
    return pts[pts.length - 1]![1];
  };
  return [[from, at(from)], ...pts.filter(([t]) => t > from && t < to), [to, at(to)]];
}

/** Sampling step of a keyframed volume envelope, seconds (linear ramps between samples). */
const KEY_STEP_SEC = 0.02;

/**
 * Gain automation points (time sec, value) for one clip: 0→vol over fade-in, vol→0 over fade-out.
 * With volume keyframes the envelope (linear in dB) is sampled every 20 ms and at every key, times
 * the fades — the same value the preview computes per frame.
 */
export function gainPoints(
  c: Pick<MixClip, 'startSec' | 'durationSec' | 'volume' | 'fadeInSec' | 'fadeOutSec'> & Partial<Pick<MixClip, 'volumeKeys' | 'inPointUs' | 'durationUs' | 'speed' | 'speedCurve'>>,
): [number, number][] {
  const flat = flatGainPoints(c);
  const keys = c.volumeKeys;
  if (!keys?.length) return flat;
  const clip = { duration: c.durationUs ?? Math.round(c.durationSec * 1e6), speed: c.speed ?? 1, speedCurve: c.speedCurve ?? null };
  const inPoint = c.inPointUs ?? 0;
  const t0 = c.startSec;
  const t1 = c.startSec + c.durationSec;
  const fade = (t: number): number => {
    const f = clipGainPoints(flat, t, t)[0]![1];
    return c.volume > 0 ? f / c.volume : 0;
  };
  const times = new Set<number>([t0, t1, ...flat.map(([t]) => t)]);
  for (let t = t0; t < t1; t += KEY_STEP_SEC) times.add(t);
  for (const k of keys) {
    const t = t0 + localTimeForSourceOffset(clip, k.src - inPoint) / 1e6;
    if (t > t0 && t < t1) times.add(t);
  }
  // grid samples that land a hair from a key / edge are dropped (float drift of the 20 ms grid)
  const sorted = [...times].sort((a, b) => a - b).filter((t, i, arr) => i === arr.length - 1 || arr[i + 1]! - t > 1e-6);
  return sorted.map((t) => {
      const src = inPoint + sourceOffsetAt(clip, Math.min(clip.duration, Math.max(0, (t - t0) * 1e6)));
    return [t, c.volume * dbToGain(keysDbAt(keys, src)) * fade(t)] as [number, number];
  });
}

function flatGainPoints(c: Pick<MixClip, 'startSec' | 'durationSec' | 'volume' | 'fadeInSec' | 'fadeOutSec'>): [number, number][] {
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
  /**
   * Range export (In / Out): the mix starts at this timeline time (µs) instead of 0 and lasts
   * `durationUs`. Rendered with a short pre-roll (MIX_PREROLL_SEC) that is cut off afterwards, so
   * effect state (echo, reverb, the limiter) entering the range is what the full mix would have.
   */
  fromUs?: Us;
}

/** Pre-roll rendered before a range export's In point and dropped (see RenderMixOptions.fromUs). */
export const MIX_PREROLL_SEC = 1;

/** The render window of a mix, in samples of the timeline at `sampleRate`. */
export interface MixWindow {
  /** Timeline time (seconds) of the context's sample 0 (= In − pre-roll; 0 for a full mix). */
  baseSec: number;
  /** Samples of pre-roll to drop from the rendered buffer. */
  prerollFrames: number;
  /** Samples kept (the output length). */
  frames: number;
  /** Heard part of the timeline, seconds: [from, to) (the pre-roll included). */
  fromSec: number;
  toSec: number;
}

/** Where a mix of `durationUs` starting at `fromUs` renders. Sample-aligned. Pure. */
export function mixWindow(fromUs: Us, durationUs: Us, sampleRate = MIX_SAMPLE_RATE, prerollSec = MIX_PREROLL_SEC): MixWindow {
  const inFrame = Math.round((Math.max(0, fromUs) / 1e6) * sampleRate);
  const prerollFrames = Math.min(inFrame, Math.round(prerollSec * sampleRate));
  const baseFrame = inFrame - prerollFrames;
  const frames = Math.max(1, Math.ceil((durationUs / 1e6) * sampleRate));
  return { baseSec: baseFrame / sampleRate, prerollFrames, frames, fromSec: baseFrame / sampleRate, toSec: (inFrame + frames) / sampleRate };
}

/** How one planned clip is scheduled in a mix context whose sample 0 is timeline time `baseSec`. */
export interface ClipSchedule {
  /** Context time the source starts / stops. */
  startAt: number;
  stopAt: number;
  /**
   * Seconds into `src.buffer` to start at: the source position for an unmapped clip (the media
   * buffer itself), the skipped part of the clip for a speed-mapped one (a rate-1 clip buffer).
   */
  offset: number;
  /** Duration passed to start() for an unmapped clip (null for a mapped one). */
  playFor: number | null;
  /** Gain automation, context time. */
  gain: [number, number][];
}

/**
 * Pure scheduling of a clip, cut to the heard part of the timeline [win.fromSec, win.toSec) and
 * shifted by `baseSec`. A clip that is not heard there returns null. With no window (a full mix)
 * the result is what renderMix always did.
 */
export function scheduleClip(c: MixClip, mapped: boolean, bufDurationSec: number, win: { baseSec: number; fromSec: number; toSec: number } | null, volume = c.volume): ClipSchedule | null {
  const [h0, h1] = heardRange(c);
  const from = win ? Math.max(h0, win.fromSec) : h0;
  const to = win ? Math.min(h1, win.toSec) : h1;
  if (to <= from) return null;
  const base = win?.baseSec ?? 0;
  const full = gainPoints({ ...c, volume });
  const pts = c.windowSec || (win && (from > h0 || to < h1)) ? clipGainPoints(full, from, to) : full;
  const skip = from - c.startSec; // seconds of the clip cut off (window / compound window)
  const startAt = from - base;
  const stopAt = to - base;
  const gain = pts.map(([t, v]) => [t - base, v] as [number, number]);
  if (!mapped) {
    return { startAt, stopAt, offset: Math.min(c.inSec + skip, Math.max(0, bufDurationSec - 1e-3)), playFor: to - from, gain };
  }
  return { startAt, stopAt, offset: skip, playFor: null, gain };
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
  // range export: render [In − pre-roll, Out) and drop the pre-roll afterwards
  const win = o.fromUs !== undefined && o.fromUs > 0 ? mixWindow(o.fromUs, durationUs) : null;
  const ctxFrames = win ? win.prerollFrames + win.frames : Math.max(1, Math.ceil(durSec * MIX_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, ctxFrames, MIX_SAMPLE_RATE);
  const worklets = await ensureWorklets(ctx);
  let any = false;
  const reversed = new Map<Id, AudioBuffer>();
  for (const c of plan) {
    if (signal?.aborted) return null;
    const decoded = await decode(c.assetId);
    if (!decoded) continue;
    // Edit › Reverse: read the time-reversed media forward (inPoint is in reversed media time)
    let buf = decoded;
    if (c.reversed) {
      const key = `${c.assetId}@${c.mediaSec}`;
      buf = reversed.get(key) ?? reverseBuffer(ctx, decoded, c.mediaSec);
      reversed.set(key, buf);
    }
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
    // the same 48 kHz forward decode over the real span (identical numbers either way, reversed or not)
    const profile = c.fx.voiceIsolation?.mode === 'isolate' ? profileForBuffer(c.assetId, c.realInSec, sourceSpanSec(c), decoded) : null;
    const chain = buildFxChain(ctx, mixFx(c, profile), { worklets });
    const g = chain.output;
    const k = await normalizeGainFor(c, buf, o);
    // a clip nested in a compound clip is heard only inside the compound's window; a range
    // export hears only [In − pre-roll, Out)
    const sc = scheduleClip(c, src.buffer !== buf, buf.duration, win, c.volume * k);
    if (!sc) continue;
    const pts = sc.gain;
    g.gain.setValueAtTime(pts[0]![1], pts[0]![0]);
    for (const [t, v] of pts.slice(1)) g.gain.linearRampToValueAtTime(v, t);
    // the clip ends here: cut effect tails (echo, reverb) like the preview does
    g.gain.setValueAtTime(0, sc.stopAt);
    src.connect(chain.input);
    g.connect(ctx.destination); // → bus
    if (sc.playFor !== null) src.start(sc.startAt, sc.offset, sc.playFor);
    else src.start(sc.startAt, sc.offset);
    src.stop(sc.stopAt);
    any = true;
  }
  if (!any) return null;
  const mix = await ctx.startRendering();
  limitPeaks(Array.from({ length: mix.numberOfChannels }, (_, i) => mix.getChannelData(i)), mix.sampleRate);
  if (!win || win.prerollFrames === 0) return mix;
  // drop the pre-roll: sample 0 of the result is the In point
  const out = new AudioBuffer({ numberOfChannels: mix.numberOfChannels, length: win.frames, sampleRate: mix.sampleRate });
  for (let i = 0; i < mix.numberOfChannels; i++) out.copyToChannel(mix.getChannelData(i).subarray(win.prerollFrames, win.prerollFrames + win.frames), i);
  return out;
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
