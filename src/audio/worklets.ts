/**
 * AudioWorklet processors used by the clip FX chain (src/audio/dsp.ts), in BOTH the preview
 * AudioContext and the export OfflineAudioContext, so the two sound the same.
 *
 * - `oe-pitch`: delay-line pitch shifter — two read taps half a window apart sweep through a
 *   ring buffer at rate `ratio`, cross-faded with complementary sin² windows. Classic, cheap,
 *   deterministic; ~W/2 samples of latency.
 * - `oe-gate`: "Reduce noise" — an adaptive downward gate. The noise floor is the quietest 20 ms
 *   block of the last 1.5 s; the gate opens 10 dB above it (threshold clamped to −65…−35 dBFS)
 *   and closes to −30 dB. Steady material (less than 15 dB between floor and the 4 s peak) is
 *   never gated. Attack 3 ms, hold 60 ms, release 150 ms. Not AI.
 *
 * - `oe-isolate`: Voice isolation (DSP, not AI) — STFT noise-profile Wiener suppression, speech-band
 *   emphasis and a gentle gate, or the approximate "remove vocals" centre cancellation. The DSP is
 *   src/audio/isolateCore.ts, inlined here.
 *
 * The source is a string so it can be loaded from a Blob URL in any context (no bundler magic).
 */
import { ISOLATE_CORE_SOURCE } from './isolateCore';

export const WORKLET_SOURCE = ISOLATE_CORE_SOURCE + String.raw`
class OePitch extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const opt = (o && o.processorOptions) || {};
    this.ratio = opt.ratio || 1;
    this.W = opt.window || 2048;
    this.N = 16384;
    this.buf = [];
    this.w = 0;
    this.p = 0;
  }
  read(b, pos) {
    const N = this.N;
    pos = pos % N; if (pos < 0) pos += N;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = b[i];
    const c = b[(i + 1) % N];
    return a + (c - a) * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    const nch = out.length;
    while (this.buf.length < nch) this.buf.push(new Float32Array(this.N));
    const n = out[0].length;
    const W = this.W, N = this.N, step = 1 - this.ratio, half = W / 2;
    let w = this.w, p = this.p;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const src = inp[c] || inp[0];
        this.buf[c][w] = src ? src[i] : 0;
      }
      let d2 = p + half; if (d2 >= W) d2 -= W;
      const s = Math.sin(Math.PI * p / W);
      const g1 = s * s, g2 = 1 - g1;
      for (let c = 0; c < nch; c++) {
        const b = this.buf[c];
        out[c][i] = this.read(b, w - p) * g1 + this.read(b, w - d2) * g2;
      }
      w = (w + 1) % N;
      p += step;
      if (p >= W) p -= W; else if (p < 0) p += W;
    }
    this.w = w; this.p = p;
    return true;
  }
}
registerProcessor('oe-pitch', OePitch);

class OeGate extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.blockN = Math.max(1, Math.round(0.02 * fs));
    this.ring = new Float32Array(75).fill(Infinity);
    this.peakRing = new Float32Array(200).fill(-Infinity);
    this.ri = 0; this.pi = 0;
    this.acc = 0; this.cnt = 0;
    this.blockDb = -120;
    this.env = 0;
    this.envCoef = Math.exp(-1 / (0.01 * fs));
    this.gain = 1;
    this.att = 1 - Math.exp(-1 / (0.003 * fs));
    this.rel = 1 - Math.exp(-1 / (0.15 * fs));
    this.holdN = Math.round(0.06 * fs);
    this.hold = 0;
    this.open = true;
    this.floor = 0; this.thr = -120; this.active = false;
    this.range = Math.pow(10, -30 / 20);
  }
  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    const nch = out.length;
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      let sq = 0;
      for (let c = 0; c < nch; c++) { const src = inp[c] || inp[0]; const x = src ? src[i] : 0; sq += x * x; }
      sq /= nch;
      this.acc += sq; this.cnt++;
      if (this.cnt >= this.blockN) {
        const db = 10 * Math.log10(this.acc / this.cnt + 1e-12);
        this.ring[this.ri] = db; this.ri = (this.ri + 1) % this.ring.length;
        this.peakRing[this.pi] = db; this.pi = (this.pi + 1) % this.peakRing.length;
        let mn = Infinity; for (let k = 0; k < this.ring.length; k++) if (this.ring[k] < mn) mn = this.ring[k];
        let mx = -Infinity; for (let k = 0; k < this.peakRing.length; k++) if (this.peakRing[k] > mx) mx = this.peakRing[k];
        this.floor = mn;
        this.active = mx - mn >= 15;
        this.thr = Math.min(-35, Math.max(-65, mn + 10));
        this.acc = 0; this.cnt = 0;
      }
      this.env = this.envCoef * this.env + (1 - this.envCoef) * sq;
      const lvl = 10 * Math.log10(this.env + 1e-12);
      if (!this.active || lvl > this.thr) { this.open = true; this.hold = this.holdN; }
      else if (lvl < this.thr - 3) { if (this.hold > 0) this.hold--; else this.open = false; }
      const target = this.open ? 1 : this.range;
      this.gain += (target - this.gain) * (target > this.gain ? this.att : this.rel);
      for (let c = 0; c < nch; c++) { const src = inp[c] || inp[0]; out[c][i] = (src ? src[i] : 0) * this.gain; }
    }
    return true;
  }
}
registerProcessor('oe-gate', OeGate);

class OeIsolate extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const opt = (o && o.processorOptions) || {};
    this.core = new OeIsolateCore({ sampleRate, mode: opt.mode, strength: opt.strength, profile: opt.profile || null, profileRate: opt.profileRate || 48000 });
  }
  process(inputs, outputs) {
    const out = outputs[0];
    this.core.process(inputs[0] || [], out, out[0].length);
    return true;
  }
}
registerProcessor('oe-isolate', OeIsolate);
`;

let blobUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Loads the processors into `ctx` once. Resolves false when AudioWorklet is unavailable. */
export function ensureWorklets(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (p) return p;
  p = (async () => {
    const wl = (ctx as BaseAudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
    if (!wl || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
    blobUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await wl.addModule(blobUrl);
      return true;
    } catch {
      return false;
    }
  })();
  loaded.set(ctx, p);
  return p;
}
