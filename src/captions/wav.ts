/** 16-bit PCM WAV encoding and mono down-mixing (pure, for the transcription upload). */

/** Average of the channels. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/** Linear-interpolation resampler with a box pre-filter when going down (good enough for speech recognition). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const half = ratio > 1 ? Math.floor(ratio / 2) : 0;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    if (half > 0) {
      const c = Math.round(pos);
      let s = 0;
      let k = 0;
      for (let j = c - half; j <= c + half; j++) {
        if (j >= 0 && j < x.length) {
          s += x[j]!;
          k++;
        }
      }
      out[i] = k ? s / k : 0;
    } else {
      const a = Math.floor(pos);
      const f = pos - a;
      out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? x[a] ?? 0) * f;
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
