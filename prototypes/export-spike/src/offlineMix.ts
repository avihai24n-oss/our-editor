// Offline audio mix: exactly the shape of the editor's export mix.
// One source node per clip -> GainNode (volume * fade envelope) -> destination.

export const SAMPLE_RATE = 48000;

export interface MixClip {
  startSec: number; // timeline position
  durationSec: number;
  volume: number; // linear gain
  fadeInSec: number;
  fadeOutSec: number;
  /** in the editor: an AudioBufferSourceNode on the decoded asset (out === src) */
  makeSource: (ctx: BaseAudioContext) => { src: AudioScheduledSourceNode; out: AudioNode };
}

export async function renderOfflineMix(clips: MixClip[], durationSec: number, impulseAtSec?: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(durationSec * SAMPLE_RATE), SAMPLE_RATE);
  if (impulseAtSec !== undefined) {
    // A/V sync probe: one full-scale sample at an exact time, so the encoded file can be measured.
    const imp = ctx.createBuffer(2, 1, SAMPLE_RATE);
    imp.getChannelData(0)[0] = imp.getChannelData(1)[0] = 1;
    const n = ctx.createBufferSource();
    n.buffer = imp;
    n.connect(ctx.destination);
    n.start(impulseAtSec);
  }
  for (const c of clips) {
    const { src, out } = c.makeSource(ctx);
    const gain = ctx.createGain();
    const t0 = c.startSec;
    const t1 = c.startSec + c.durationSec;
    // fade envelope: 0 -> volume over fadeIn, hold, volume -> 0 over fadeOut
    gain.gain.setValueAtTime(c.fadeInSec > 0 ? 0 : c.volume, t0);
    if (c.fadeInSec > 0) gain.gain.linearRampToValueAtTime(c.volume, t0 + c.fadeInSec);
    gain.gain.setValueAtTime(c.volume, Math.max(t0 + c.fadeInSec, t1 - c.fadeOutSec));
    if (c.fadeOutSec > 0) gain.gain.linearRampToValueAtTime(0, t1);
    out.connect(gain).connect(ctx.destination);
    src.start(t0); // editor: src.start(t0, clip.inSec, srcSpanSec)
    src.stop(t1);
  }
  return ctx.startRendering();
}

/** Demo mix: two oscillators panned L/R with fades — stand-ins for two audio clips. */
export function demoClips(durationSec: number): MixClip[] {
  const osc = (freq: number, pan: number) => (ctx: BaseAudioContext) => {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(p);
    return { src: o, out: p };
  };
  return [
    { startSec: 0, durationSec, volume: 0.5, fadeInSec: 0.5, fadeOutSec: 0.5, makeSource: osc(440, -0.8) },
    { startSec: 1, durationSec: durationSec - 1, volume: 0.3, fadeInSec: 0.3, fadeOutSec: 1, makeSource: osc(660, 0.8) },
  ];
}
