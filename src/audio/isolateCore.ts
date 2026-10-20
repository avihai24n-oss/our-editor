/**
 * Voice isolation (DSP, not AI) — the one implementation used by the preview AudioWorklet
 * (`oe-isolate`, src/audio/worklets.ts) and, through that same worklet, by the export's
 * OfflineAudioContext; unit tests run it directly (getIsolateCore()).
 *
 * Streaming STFT, N = 1024, hop 256 (75 % overlap), √Hann analysis + synthesis windows, so the
 * output is the input delayed by exactly N samples when nothing is changed (≈ 21 ms at 48 kHz,
 * preview and export alike).
 *
 * mode 'isolate' (keep the voice), strength s = 0..1:
 *   1. Wiener suppression with a decision-directed a-priori SNR (Ephraim–Malah style smoothing,
 *      fewer "musical noise" chirps than plain spectral subtraction). The noise power per bin is
 *      the clip's NOISE PROFILE: the mean spectrum of the quietest 10 % of its frames, measured
 *      offline once per clip (oeNoiseProfile, cached by src/audio/noiseProfile.ts). Over-subtraction
 *      1 + s, gain floor −30 dB.
 *   2. Speech-band emphasis: bins below 100 Hz / above 8 kHz roll off at 12 dB/octave (≥ −30 dB).
 *   3. Gentle gate: a frame counts as speech when ≥ 4 speech-band bins stand 10 dB above the
 *      noise profile (noise alone essentially never does this); otherwise, after a 53 ms hold,
 *      the frame gain eases down to −12 dB · s.
 *   Every bin gain is (1 − s) + s · g, with g ≤ 1, so the stage never boosts anything.
 *   Without a profile (not measured yet) only the band emphasis runs.
 *
 * mode 'remove' (keep the background, APPROXIMATE): mid/side split per bin; the mid (centre)
 * channel is cut by up to −30 dB · s inside a 150 Hz–6 kHz speech band with soft edges; side
 * (stereo) content and the centre's bass and air are kept. On a mono source this is a plain
 * speech-band notch.
 *
 * The source is a plain-JS string so it can be inlined into the worklet module.
 */
export const ISOLATE_CORE_SOURCE = String.raw`
class OeIsolateCore {
  constructor(opt) {
    opt = opt || {};
    const N = 1024, H = 256, nb = N / 2 + 1;
    this.N = N; this.H = H; this.nb = nb; this.latency = N;
    const sr = opt.sampleRate || 48000;
    let s = Number(opt.strength);
    if (!Number.isFinite(s)) s = 0;
    s = Math.min(1, Math.max(0, s / 100));
    this.s = s;
    this.mode = opt.mode === 'remove' ? 'remove' : 'isolate';
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.cs = new Float64Array(N / 2); this.sn = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) { this.cs[k] = Math.cos((2 * Math.PI * k) / N); this.sn[k] = Math.sin((2 * Math.PI * k) / N); }
    this.rev = new Uint32Array(N);
    let bits = 0; while ((1 << bits) < N) bits++;
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.inb = [new Float64Array(N), new Float64Array(N)];
    this.ola = [new Float64Array(N), new Float64Array(N)];
    this.outq = [new Float64Array(H), new Float64Array(H)];
    this.re = [new Float64Array(N), new Float64Array(N)];
    this.im = [new Float64Array(N), new Float64Array(N)];
    this.fill = N - H;
    // noise profile → this sample rate's bins (the profile is a function of frequency)
    this.noise = null;
    const prof = opt.profile;
    if (prof && prof.length >= 2) {
      const pr = opt.profileRate || 48000;
      const pn = prof.length;
      this.noise = new Float64Array(nb);
      for (let k = 0; k < nb; k++) {
        const x = Math.min(pn - 1, (k * sr) / pr);
        const i = Math.floor(x), f = x - i;
        const a = prof[i], b = prof[Math.min(pn - 1, i + 1)];
        const v = a + (b - a) * f;
        this.noise[k] = Number.isFinite(v) && v > 0 ? v : 0;
      }
    }
    this.band = new Float64Array(nb);
    this.speech = new Uint8Array(nb);
    this.notch = new Float64Array(nb);
    const floorBand = Math.pow(10, -30 / 20);
    for (let k = 0; k < nb; k++) {
      const f = (k * sr) / N;
      let b = 1;
      if (f < 100) b = Math.max(floorBand, (f / 100) * (f / 100));
      else if (f > 8000) b = Math.max(floorBand, (8000 / f) * (8000 / f));
      this.band[k] = 1 - s * (1 - b);
      this.speech[k] = f >= 100 && f <= 8000 ? 1 : 0;
      let shape = 1;
      if (f < 150) shape = (f / 150) * (f / 150) * (f / 150) * (f / 150);
      else if (f > 6000) shape = Math.pow(6000 / f, 4);
      this.notch[k] = 1 - s * (1 - floorBand) * shape;
    }
    this.gPrev = [new Float64Array(nb).fill(1), new Float64Array(nb).fill(1)];
    this.pPrev = [new Float64Array(nb), new Float64Array(nb)];
    this.gain = [new Float64Array(nb), new Float64Array(nb)];
    this.floor = Math.pow(10, -30 / 20);
    this.alpha = 1 + s;
    this.gate = 1;
    this.hold = 0;
    this.gateClosed = Math.pow(10, (-12 * s) / 20);
    this.frames = 0;
  }
  fft(re, im, inv) {
    const N = this.N, rev = this.rev, cs = this.cs, sn = this.sn;
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sg = inv ? 1 : -1;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let st = 0; st < N; st += size) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const wr = cs[t], wi = sg * sn[t];
          const a = st + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  process(inp, out, n) {
    const N = this.N, H = this.H;
    inp = inp || [];
    const nch = Math.min(2, out.length);
    for (let i = 0; i < n; i++) {
      const idx = this.fill - (N - H);
      for (let c = 0; c < 2; c++) {
        const src = inp[c] || inp[0];
        let x = src && i < src.length ? src[i] : 0;
        if (!Number.isFinite(x)) x = 0;
        this.inb[c][this.fill] = x;
        if (c < nch) out[c][i] = this.outq[c][idx];
      }
      this.fill++;
      if (this.fill === N) { this.frame(); this.fill = N - H; }
    }
  }
  frame() {
    const N = this.N, H = this.H, nb = this.nb, win = this.win, s = this.s;
    this.frames++;
    for (let c = 0; c < 2; c++) {
      const re = this.re[c], im = this.im[c], x = this.inb[c];
      for (let i = 0; i < N; i++) { re[i] = x[i] * win[i]; im[i] = 0; }
      this.fft(re, im, false);
    }
    if (this.mode === 'isolate') {
      const noise = this.noise;
      let present = 0;
      for (let c = 0; c < 2; c++) {
        const re = this.re[c], im = this.im[c], gp = this.gPrev[c], pp = this.pPrev[c], g = this.gain[c];
        for (let k = 0; k < nb; k++) {
          const P = re[k] * re[k] + im[k] * im[k];
          if (!noise) { g[k] = this.band[k]; continue; }
          const nk = noise[k];
          if (this.speech[k] && P > 10 * nk && P > 1e-14) present++;
          let G = 1;
          if (nk > 0) {
            const na = nk * this.alpha;
            const gamma = P / na;
            let xi = 0.98 * (gp[k] * gp[k] * pp[k]) / na + 0.02 * Math.max(gamma - 1, 0);
            if (!(xi > 1e-3)) xi = 1e-3;
            G = xi / (1 + xi);
          }
          gp[k] = G; pp[k] = P;
          const gw = G > this.floor ? G : this.floor;
          g[k] = (1 - s + s * gw) * this.band[k];
        }
      }
      if (noise) {
        let target = this.gateClosed;
        if (present >= 4) { this.hold = 10; target = 1; }
        else if (this.hold > 0) { this.hold--; target = 1; }
        this.gate += (target - this.gate) * (target > this.gate ? 0.7 : 0.12);
      }
      const gate = this.gate;
      for (let c = 0; c < 2; c++) {
        const re = this.re[c], im = this.im[c], g = this.gain[c];
        for (let k = 0; k < N; k++) {
          const kk = k <= N / 2 ? k : N - k;
          const v = g[kk] * gate;
          re[k] *= v; im[k] *= v;
        }
      }
    } else {
      const rl = this.re[0], il = this.im[0], rr = this.re[1], ir = this.im[1];
      for (let k = 0; k < N; k++) {
        const kk = k <= N / 2 ? k : N - k;
        const m = this.notch[kk];
        const mr = 0.5 * (rl[k] + rr[k]) * m, mi = 0.5 * (il[k] + ir[k]) * m;
        const sr = 0.5 * (rl[k] - rr[k]), si = 0.5 * (il[k] - ir[k]);
        rl[k] = mr + sr; il[k] = mi + si;
        rr[k] = mr - sr; ir[k] = mi - si;
      }
    }
    // overlap-add: √Hann² = Hann, which sums to 2 at hop N/4 → × 0.5; inverse FFT → × 1/N
    const sc = 0.5 / N;
    for (let c = 0; c < 2; c++) {
      const re = this.re[c], im = this.im[c], ola = this.ola[c];
      this.fft(re, im, true);
      for (let i = 0; i < N; i++) ola[i] += re[i] * win[i] * sc;
      const q = this.outq[c];
      for (let i = 0; i < H; i++) q[i] = ola[i];
      ola.copyWithin(0, H);
      ola.fill(0, N - H);
      this.inb[c].copyWithin(0, H);
    }
  }
}

/**
 * Noise profile of channels[*][start, end): mean power spectrum (N = 1024, √Hann, hop 512) of
 * the quietest 10 % (at least 4) of the frames that are not digital silence, lightly smoothed
 * across bins. null when the span is shorter than one frame or entirely silent.
 */
function oeNoiseProfile(channels, sampleRate, start, end) {
  const core = new OeIsolateCore({ sampleRate: sampleRate, strength: 0 });
  const N = core.N, nb = core.nb, hop = N / 2, win = core.win;
  const len = channels.length ? channels[0].length : 0;
  start = Math.max(0, Math.floor(start || 0));
  end = Math.min(len, Math.floor(end == null ? len : end));
  if (!channels.length || end - start < N) return null;
  const nch = Math.min(2, channels.length);
  const energies = [];
  for (let p = start; p + N <= end; p += hop) {
    let e = 0;
    for (let c = 0; c < nch; c++) { const ch = channels[c]; for (let i = 0; i < N; i++) { const v = ch[p + i] * win[i]; e += v * v; } }
    energies.push(e / nch);
  }
  const live = energies.filter((e) => e > 1e-10 && Number.isFinite(e)).sort((a, b) => a - b);
  if (!live.length) return null;
  const take = Math.min(live.length, Math.max(4, Math.ceil(live.length * 0.1)));
  const thr = live[take - 1];
  const acc = new Float64Array(nb);
  const re = new Float64Array(N), im = new Float64Array(N);
  let used = 0;
  for (let f = 0, p = start; p + N <= end; p += hop, f++) {
    const e = energies[f];
    if (!(e > 1e-10) || e > thr || used >= take) continue;
    for (let c = 0; c < nch; c++) {
      const ch = channels[c];
      for (let i = 0; i < N; i++) { re[i] = ch[p + i] * win[i]; im[i] = 0; }
      core.fft(re, im, false);
      for (let k = 0; k < nb; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / nch;
    }
    used++;
  }
  if (!used) return null;
  const out = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    const a = acc[Math.max(0, k - 1)], b = acc[k], c = acc[Math.min(nb - 1, k + 1)];
    out[k] = (0.25 * a + 0.5 * b + 0.25 * c) / used;
  }
  return out;
}
`;

export interface IsolateCoreOptions {
  sampleRate: number;
  mode: 'isolate' | 'remove';
  /** 0..100 */
  strength: number;
  /** Noise power per bin (N = 1024) measured at profileRate; null = not measured. */
  profile?: Float32Array | null;
  profileRate?: number;
}

export interface IsolateCore {
  readonly latency: number;
  readonly gate: number;
  process(inp: readonly (Float32Array | undefined)[], out: Float32Array[], n: number): void;
}

export interface IsolateCoreModule {
  Core: new (o: IsolateCoreOptions) => IsolateCore;
  profile: (channels: readonly Float32Array[], sampleRate: number, start: number, end: number) => Float32Array | null;
}

let mod: IsolateCoreModule | null = null;

/** The core on the main thread (noise profiles, unit tests). Same source as the worklet. */
export function getIsolateCore(): IsolateCoreModule {
  mod ??= new Function(`${ISOLATE_CORE_SOURCE}\nreturn { Core: OeIsolateCore, profile: oeNoiseProfile };`)() as IsolateCoreModule;
  return mod;
}
