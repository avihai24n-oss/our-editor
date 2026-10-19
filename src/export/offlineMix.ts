/**
 * Offline audio mix for export. Same audibility rules as getFrameState's audio ops:
 * muted tracks / clips, disabled clips, videos with hasAudio === false and lost media are
 * silent; hidden tracks still sound. One AudioBufferSourceNode per clip → GainNode
 * (volume dB × linear fades) → destination of an OfflineAudioContext.
 *
 * Each clip goes through the same FX chain as the preview (src/audio/dsp.ts): fill channel,
 * reduce noise, voice filter, then the gain stage (volume × normalize × fades).
 *
 * Speed: an AudioBufferSourceNode's playbackRate shifts pitch, so when the clip keeps its pitch
 * ("Change audio pitch" off, the default) the chain's pitch shifter runs at 1/speed to undo it
 * (clamped to 0.25..4). The preview gets the same result from the media element's preservesPitch.
 */
import { buildFxChain, fxFromAudio, type FxConfig } from '../audio/dsp';
import { normalizeGainDb } from '../audio/loudness';
import { measureAudioBuffer } from '../audio/measure';
import { ensureWorklets } from '../audio/worklets';
import { dbToGain } from '../model/project';
import type { AudioProps, Id, Project } from '../model/types';

export const MIX_SAMPLE_RATE = 48_000;

export interface MixClip {
  clipId: Id;
  assetId: Id;
  startSec: number;
  durationSec: number;
  /** Source in-point, seconds. */
  inSec: number;
  speed: number;
  /** Linear gain from volume dB. */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  preservePitch: boolean;
  /** Audio › Basic / Voice changer settings. */
  fx: Pick<AudioProps, 'normalize' | 'reduceNoise' | 'fillChannel' | 'voiceFilter'>;
}

/** The FX chain config for a planned clip (pitch compensation for pitch-preserved speed). */
export const mixFx = (c: Pick<MixClip, 'speed' | 'preservePitch' | 'fx'>): FxConfig =>
  fxFromAudio(c.fx, c.preservePitch && c.speed !== 1 ? 1 / c.speed : 1);

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
        volume,
        fadeInSec: Math.min(clip.audio.fadeIn, clip.duration) / 1e6,
        fadeOutSec: Math.min(clip.audio.fadeOut, clip.duration) / 1e6,
        preservePitch: clip.preservePitch,
        fx: {
          normalize: !!clip.audio.normalize,
          reduceNoise: !!clip.audio.reduceNoise,
          fillChannel: clip.audio.fillChannel ?? null,
          voiceFilter: clip.audio.voiceFilter ?? null,
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
  const lufs = o.loudness ? await o.loudness(c, buf) : measureAudioBuffer(buf, c.inSec, c.durationSec * c.speed);
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
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    const chain = buildFxChain(ctx, mixFx(c), { worklets });
    const g = chain.output;
    const k = await normalizeGainFor(c, buf, o);
    const pts = gainPoints({ ...c, volume: c.volume * k });
    g.gain.setValueAtTime(pts[0]![1], pts[0]![0]);
    for (const [t, v] of pts.slice(1)) g.gain.linearRampToValueAtTime(v, t);
    // the clip ends here: cut effect tails (echo, reverb) like the preview does
    g.gain.setValueAtTime(0, c.startSec + c.durationSec);
    src.connect(chain.input);
    g.connect(ctx.destination);
    const offset = Math.min(c.inSec, Math.max(0, buf.duration - 1e-3));
    src.start(c.startSec, offset, c.durationSec * c.speed);
    src.stop(c.startSec + c.durationSec);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
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
