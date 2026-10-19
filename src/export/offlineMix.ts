/**
 * Offline audio mix for export. Same audibility rules as getFrameState's audio ops:
 * muted tracks / clips, disabled clips, videos with hasAudio === false and lost media are
 * silent; hidden tracks still sound. One AudioBufferSourceNode per clip → GainNode
 * (volume dB × linear fades) → destination of an OfflineAudioContext.
 *
 * Speed: an OfflineAudioContext playbackRate changes the pitch, but the preview keeps it (media
 * element `preservesPitch`, CapCut's default). So clips with `preservePitch` are time-stretched
 * with WSOLA first and played at rate 1; "Change audio pitch" clips keep the playbackRate path.
 * The finished mix goes through a peak limiter so overlapping loud clips cannot clip.
 */
import { dbToGain } from '../model/project';
import { limitPeaks, stretchPreservePitch } from './audioDsp';
import type { Id, Project } from '../model/types';

export const MIX_SAMPLE_RATE = 48_000;

export interface MixClip {
  clipId: Id;
  assetId: Id;
  startSec: number;
  durationSec: number;
  /** Source in-point, seconds. */
  inSec: number;
  speed: number;
  /** Keep the pitch at speed ≠ 1 (CapCut "Change audio pitch" off). */
  preservePitch: boolean;
  /** Linear gain from volume dB. */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
}

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
        preservePitch: clip.preservePitch !== false,
        volume,
        fadeInSec: Math.min(clip.audio.fadeIn, clip.duration) / 1e6,
        fadeOutSec: Math.min(clip.audio.fadeOut, clip.duration) / 1e6,
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

/** Renders the stereo mix of the whole timeline. Returns null when nothing is audible. */
export async function renderMix(project: Project, durationUs: number, decode: DecodeAsset, signal?: AbortSignal): Promise<AudioBuffer | null> {
  const plan = planMix(project);
  if (!plan.length || durationUs <= 0) return null;
  const durSec = durationUs / 1e6;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durSec * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE);
  let any = false;
  for (const c of plan) {
    if (signal?.aborted) return null;
    const buf = await decode(c.assetId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const pts = gainPoints(c);
    g.gain.setValueAtTime(pts[0]![1], pts[0]![0]);
    for (const [t, v] of pts.slice(1)) g.gain.linearRampToValueAtTime(v, t);
    src.connect(g).connect(ctx.destination);
    if (c.speed !== 1 && c.preservePitch) {
      const sr = buf.sampleRate;
      const outLen = Math.max(1, Math.round(c.durationSec * sr));
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      const stretched = stretchPreservePitch(chans, c.inSec * sr, c.speed, outLen);
      const sb = ctx.createBuffer(stretched.length, outLen, sr);
      stretched.forEach((d, i) => sb.copyToChannel(d, i));
      src.buffer = sb;
      src.start(c.startSec, 0, c.durationSec);
    } else {
      src.buffer = buf;
      src.playbackRate.value = c.speed;
      const offset = Math.min(c.inSec, Math.max(0, buf.duration - 1e-3));
      src.start(c.startSec, offset, c.durationSec * c.speed);
    }
    src.stop(c.startSec + c.durationSec);
    any = true;
  }
  if (!any) return null;
  const mix = await ctx.startRendering();
  limitPeaks(Array.from({ length: mix.numberOfChannels }, (_, i) => mix.getChannelData(i)), mix.sampleRate);
  return mix;
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
