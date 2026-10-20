/**
 * Edit › Reverse for audio: the media's samples, time-reversed and aligned to the MEDIA duration
 * (the asset's container duration, which the video side mirrors around too), so that sample i of
 * the result is the instant D − i/sr of the original. A reversed clip then reads this buffer
 * FORWARD from its inPoint (which is in reversed media time, see model/types TimedMediaFields).
 * Used by the export mix (OfflineAudioContext) and the preview's reversed voices. Pure.
 */

/** Reverses each channel around `mediaSec` seconds. Samples past the decoded audio are silence. */
export function reverseChannels(channels: readonly Float32Array[], sampleRate: number, mediaSec: number): Float32Array[] {
  const n = Math.max(1, Math.round(mediaSec * sampleRate));
  return channels.map((src) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = n - 1 - i;
      out[i] = j < src.length ? src[j]! : 0;
    }
    return out;
  });
}

/** AudioBuffer version of reverseChannels (one new buffer on `ctx`). */
export function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer, mediaSec: number): AudioBuffer {
  const ch: Float32Array[] = [];
  for (let i = 0; i < buf.numberOfChannels; i++) ch.push(buf.getChannelData(i));
  const out = reverseChannels(ch, buf.sampleRate, mediaSec > 0 ? mediaSec : buf.duration);
  const b = ctx.createBuffer(buf.numberOfChannels, out[0]!.length, buf.sampleRate);
  out.forEach((d, i) => b.copyToChannel(d as Float32Array<ArrayBuffer>, i));
  return b;
}
