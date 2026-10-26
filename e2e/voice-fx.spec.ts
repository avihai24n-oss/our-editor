/**
 * Voice changer spaces / devices / characters + Mixer (src/audio/dsp.ts), rendered for real in
 * Chromium's OfflineAudioContext — the export path — on a speech-like test signal (1.5 s of voiced
 * bursts, then 1.5 s of silence), and measured: every filter is audible and finite, devices cut the
 * lows / highs, spaces leave a tail in proportion to their size, the Mixer's sections do their job.
 */
import { expect, test } from '@playwright/test';
import { openApp, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type M = { rms: number; peak: number; finite: boolean; low: number; high: number; tail: number };

test('every voice filter and the Mixer sections render and measure right', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const res: Record<string, M> = await page.evaluate(async () => {
    const dsp = await import('/src/audio/dsp.ts' as any);
    const { ensureWorklets } = await import('/src/audio/worklets.ts' as any);
    const SR = 48000;
    const N = SR * 3;
    // speech-like: 120 Hz voiced bursts with harmonics to ~6 kHz + a little breath noise
    const src = new Float32Array(N);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < SR * 1.5; i++) {
      const t = i / SR;
      const env = Math.max(0, Math.sin(Math.PI * ((t * 4) % 1))) ** 0.5;
      let v = 0;
      for (let h = 1; h <= 50; h++) v += Math.sin(2 * Math.PI * 120 * h * t) / h;
      src[i] = 0.25 * env * (v * 0.6 + rnd() * 0.15);
    }
    const band = async (data: Float32Array, type: BiquadFilterType, f: number) => {
      const c = new OfflineAudioContext(1, data.length, SR);
      const b = c.createBuffer(1, data.length, SR);
      b.copyToChannel(data as any, 0);
      const s = c.createBufferSource();
      s.buffer = b;
      const q = c.createBiquadFilter();
      q.type = type;
      q.frequency.value = f;
      const q2 = c.createBiquadFilter();
      q2.type = type;
      q2.frequency.value = f;
      s.connect(q).connect(q2).connect(c.destination);
      s.start();
      const out = (await c.startRendering()).getChannelData(0);
      let e = 0;
      for (let i = 0; i < SR * 1.5; i++) e += out[i]! * out[i]!;
      return e;
    };
    const measure = async (data: Float32Array): Promise<M> => {
      let e = 0;
      let peak = 0;
      let finite = true;
      let tail = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]!;
        if (!Number.isFinite(v)) finite = false;
        if (i < SR * 1.5) e += v * v;
        else if (i > SR * 1.55) tail += v * v; // from 50 ms after the voice stops
        peak = Math.max(peak, Math.abs(v));
      }
      return { rms: Math.sqrt(e / (SR * 1.5)), peak, finite, low: (await band(data, 'lowpass', 220)) / e, high: (await band(data, 'highpass', 3500)) / e, tail: tail / e };
    };
    const render = async (fx: any) => {
      const ctx = new OfflineAudioContext(2, N, SR);
      const worklets = await ensureWorklets(ctx);
      const buf = ctx.createBuffer(1, N, SR);
      buf.copyToChannel(src, 0);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const chain = dsp.buildFxChain(ctx, dsp.fxFromAudio(fx), { worklets });
      s.connect(chain.input);
      chain.output.connect(ctx.destination);
      s.start();
      const out = await ctx.startRendering();
      return out.getChannelData(0).slice();
    };
    const base = { fillChannel: null, reduceNoise: false, voiceFilter: null };
    const out: Record<string, M> = { dry: await measure(src) };
    for (const f of dsp.VOICE_FILTERS) out[f.id] = await measure(await render({ ...base, voiceFilter: { id: f.id, strength: 50 } }));
    const mx = (patch: any) => ({ ...base, mixer: { ...dsp.DEFAULT_MIXER, ...patch } });
    out['mix:neutral'] = await measure(await render(mx({})));
    out['mix:lowcut'] = await measure(await render(mx({ lowCut: 300 })));
    out['mix:eq-low+12'] = await measure(await render(mx({ eq: { ...dsp.DEFAULT_MIXER.eq, on: true, lowGain: 12 } })));
    out['mix:comp'] = await measure(await render(mx({ comp: { ...dsp.DEFAULT_MIXER.comp, on: true, threshold: -40, ratio: 10, attack: 1 } })));
    out['mix:reverb'] = await measure(await render(mx({ reverb: { on: true, decay: 2.5, predelay: 20, damping: 30, mix: 40 } })));
    out['mix:delay'] = await measure(await render(mx({ delay: { on: true, time: 300, feedback: 50, mix: 50 } })));
    out['mix:out+6'] = await measure(await render(mx({ output: 6 })));
    for (const p of dsp.MIXER_PRESETS) out[`preset:${p.id}`] = await measure(await render({ ...base, mixer: p.mixer }));
    return out;
  });

  console.log(JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, m]) => [k, { rms: +m.rms.toFixed(3), low: +m.low.toFixed(3), high: +m.high.toFixed(3), tail: +m.tail.toExponential(2) }]))));
  const dry = res.dry!;
  for (const [k, m] of Object.entries(res)) {
    expect(m.finite, k).toBe(true);
    expect(m.rms, `${k} audible`).toBeGreaterThan(dry.rms * 0.05);
    expect(m.peak, `${k} not exploding`).toBeLessThan(4);
  }
  // devices: the band-limited ones lose the lows and most highs
  for (const k of ['phone', 'walkie', 'gramophone']) {
    expect(res[k]!.low, `${k} lows`).toBeLessThan(dry.low * 0.25);
    expect(res[k]!.high, `${k} highs`).toBeLessThan(dry.high * 0.6);
  }
  // muffled ones lose the highs
  for (const k of ['next-room', 'underwater', 'distant']) expect(res[k]!.high, `${k} highs`).toBeLessThan(dry.high * 0.4);
  // spaces: a tail after the voice stops, bigger space = longer tail
  expect(dry.tail).toBe(0);
  // a small room is short by nature (~0.5 s): its tail is real but small
  expect(res.room!.tail, 'room tail').toBeGreaterThan(3e-5);
  for (const k of ['tiled', 'stone', 'cathedral', 'distant', 'memory']) expect(res[k]!.tail, `${k} tail`).toBeGreaterThan(1e-4);
  expect(res.cathedral!.tail).toBeGreaterThan(res.stone!.tail);
  expect(res.stone!.tail).toBeGreaterThan(res.room!.tail);
  // mixer
  expect(Math.abs(res['mix:neutral']!.rms / dry.rms - 1)).toBeLessThan(0.02); // all off = untouched
  expect(res['mix:lowcut']!.low).toBeLessThan(dry.low * 0.3);
  // +12 dB low shelf: the (low-dominated) voice gets about twice as loud, the highs' share drops
  expect(res['mix:eq-low+12']!.rms / dry.rms).toBeGreaterThan(1.8);
  expect(res['mix:eq-low+12']!.high).toBeLessThan(dry.high * 0.5);
  expect(res['mix:comp']!.peak).toBeLessThan(dry.peak * 0.8);
  expect(res['mix:reverb']!.tail).toBeGreaterThan(1e-3);
  expect(res['mix:delay']!.tail).toBeGreaterThan(1e-3);
  expect(res['mix:out+6']!.rms / dry.rms).toBeGreaterThan(1.9);

});

test('Voice changer shows the groups and the Mixer drives the clip', async ({ page }) => {
  await openApp(page);
  const { importMedia, mediaPath } = await import('./helpers');
  await importMedia(page, [mediaPath('a-tone-6s.mp3')]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const id = s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'audio' });
    s.select([id]);
  });
  await page.getByRole('tab', { name: 'Voice changer' }).or(page.getByText('Voice changer', { exact: true })).first().click();
  for (const g of ['Spaces', 'Eras & devices', 'Character', 'Pitch & effects']) await expect(page.getByRole('listbox', { name: g })).toBeVisible();
  await page.getByTestId('voice-filter-stone').click();
  const clip = () => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === 'audio').audio)));
  expect((await clip()).voiceFilter).toEqual({ id: 'stone', strength: 50 });
  await page.getByTestId('mixer-preset-warm-narrator').click();
  const a = await clip();
  expect(a.mixer.comp.on).toBe(true);
  expect(a.mixer.warmth.on).toBe(true);
  await expect(page.getByTestId('section-audio-mixer-eq')).toBeVisible();
  await screenshot(page, 'voice-changer-mixer');
  // the preview graph has the mixer stage
  await page.evaluate(() => (window as any).__oe.getState().play());
  await expect
    .poll(async () => (await page.evaluate(() => (window as any).__oeAudio.voices())).some((v: any) => v.stages.some((s: string) => s.startsWith('mixer:'))), { timeout: 15_000 })
    .toBe(true);
  await page.evaluate(() => (window as any).__oe.getState().pause());
});
