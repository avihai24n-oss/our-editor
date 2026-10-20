/**
 * Audio tab, end to end: every control is set through the inspector, checked in the preview audio
 * graph (dev hook `window.__oeAudio`), survives a reload, and is then MEASURED in an exported MP4
 * with ffmpeg (astats per channel / per window, ebur128, volumedetect).
 *
 * The test media is synthesised with ffmpeg into a temp folder, so exact levels are known:
 *   tone.wav   stereo 1 kHz, peak −20 dBFS (RMS −23 dB) on both channels
 *   quiet.wav  stereo 1 kHz, peak −38 dBFS (≈ −38 LUFS)
 *   left.wav   1 kHz −20 dBFS on the LEFT channel only, right silent
 *   beeps.wav  a 0.2 s 1 kHz beep every second over −50 dBFS white noise
 *
 * Timeline (one audio track), seconds:
 *   0–2 tone 0 dB (reference) · 2–4 tone −6 dB · 4–6 tone 1 s fade-in · 6–10 quiet + Normalize
 *   10–12 left + Fill channel (left) · 12–14 left, no fill · 14–18 beeps + Reduce noise
 *   18–22 beeps, no reduce · 22–24 tone + Chipmunk 100 · 24–25 tone 2× (pitch kept)
 *   25–26 tone 2× + Change audio pitch
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectConsoleErrors, expectMediaFile, importMedia, openApp, pressShortcut, screenshot, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MEDIA_DIR = path.join(os.tmpdir(), 'oe-tab-audio-media');
const FILES = {
  tone: { name: 'tone.wav', expr: '0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t)' },
  quiet: { name: 'quiet.wav', expr: '0.012589*sin(2*PI*1000*t)|0.012589*sin(2*PI*1000*t)' },
  left: { name: 'left.wav', expr: '0.1*sin(2*PI*1000*t)|0' },
  beeps: {
    name: 'beeps.wav',
    expr: 'if(lt(mod(t,1),0.2),0.5*sin(2*PI*1000*t),0)+0.00548*(2*random(0)-1)|if(lt(mod(t,1),0.2),0.5*sin(2*PI*1000*t),0)+0.00548*(2*random(1)-1)',
  },
} as const;

function makeMedia(): Record<keyof typeof FILES, string> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = {} as Record<keyof typeof FILES, string>;
  for (const [k, f] of Object.entries(FILES) as [keyof typeof FILES, (typeof FILES)[keyof typeof FILES]][]) {
    const file = path.join(MEDIA_DIR, f.name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${f.expr}':s=48000:d=4`, '-c:a', 'pcm_s16le', file]);
    out[k] = file;
  }
  return out;
}

// ---------------------------------------------------------------- ffmpeg measurements

type Stats = Record<string, Record<string, number>>;

/** ffmpeg writes filter reports to stderr. */
function ffmpegStderr(args: string[]): string {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-1500)}`);
  return r.stderr;
}

function parseAstats(text: string): Stats {
  const res: Stats = {};
  let sec = '';
  for (const line of text.split('\n')) {
    const m = line.match(/\[Parsed_astats_\d+ @ [^\]]+\] (.*)$/);
    if (!m) continue;
    const body = m[1]!.trim();
    const ch = body.match(/^Channel: (\d+)/);
    if (ch) {
      sec = ch[1]!;
      res[sec] = {};
      continue;
    }
    if (body === 'Overall') {
      sec = 'Overall';
      res[sec] = {};
      continue;
    }
    const kv = body.match(/^([^:]+): (.+)$/);
    if (kv && sec) {
      const v = kv[2]!.trim();
      res[sec]![kv[1]!.trim()] = v === '-inf' ? -Infinity : Number(v);
    }
  }
  return res;
}

/** astats over [ss, ss+t): { '1': {...}, '2': {...}, Overall: {...} } keyed by the printed names. */
function stats(file: string, ss: number, t: number): Stats {
  return parseAstats(ffmpegStderr(['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'astats=metadata=0', '-f', 'null', '-']));
}

const rms = (s: Stats, ch: '1' | '2' | 'Overall' = 'Overall') => s[ch]!['RMS level dB']!;

function ebur128(file: string, ss: number, t: number): number {
  const err = ffmpegStderr(['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const m = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  if (!m) throw new Error(`no ebur128 summary:\n${err.slice(-2000)}`);
  return Number(m[1]);
}

function volumedetect(file: string, ss: number, t: number): { mean: number; max: number } {
  const err = ffmpegStderr(['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  return { mean: Number(err.match(/mean_volume: (-?[\d.]+) dB/)![1]), max: Number(err.match(/max_volume: (-?[\d.]+) dB/)![1]) };
}

// ---------------------------------------------------------------- app helpers

const S = (s: number) => Math.round(s * 1e6);

async function clipAudio(page: Page, id: string): Promise<any> {
  return page.evaluate((cid) => {
    const p = (window as any).__oe.getState().project;
    for (const t of p.tracks) for (const c of t.clips) if (c.id === cid) return { ...c.audio, preservePitch: c.preservePitch, speed: c.speed };
    return null;
  }, id);
}

async function selectClip(page: Page, id: string) {
  await page.evaluate((cid) => (window as any).__oe.getState().select([cid]), id);
  await expect(page.getByTestId('inspector-audio')).toBeVisible();
}

async function typeValue(page: Page, label: string, value: string) {
  const box = page.getByLabel(label, { exact: true });
  await box.click();
  await box.fill(value);
  await box.press('Enter');
}

/** Plays from `t`, waits until the clip's preview voice matches `pred`, pauses. Returns the voice. */
async function previewVoice(page: Page, clipId: string, t: number, pred: (v: any) => boolean): Promise<any> {
  await page.evaluate((us) => {
    const st = (window as any).__oe.getState();
    st.pause();
    st.setPlayhead(us);
    st.play();
  }, S(t));
  let found: any = null;
  try {
    await expect
      .poll(
        async () => {
          const voices = await page.evaluate(() => (window as any).__oeAudio.voices());
          found = voices.find((v: any) => v.clipId === clipId) ?? null;
          return !!found && pred(found);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  } finally {
    await page.evaluate(() => (window as any).__oe.getState().pause());
  }
  return found;
}

// ---------------------------------------------------------------- the test

test('Audio tab: controls drive the preview graph and the exported MP4 measures right', async ({ page }) => {
  test.setTimeout(420_000);
  const media = makeMedia();
  const consoleErrors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, Object.values(media));

  // ---- layout (store) — the controls themselves are set through the inspector below
  const ids: Record<string, string> = await page.evaluate((plan) => {
    const st = (window as any).__oe.getState();
    const byName = (n: string) => Object.values(st.project.assets as Record<string, any>).find((a: any) => a.name === n)!.id as string;
    const out: Record<string, string> = {};
    for (const p of plan) {
      const s = (window as any).__oe.getState();
      const id = s.addClip(byName(p.file), { at: p.at * 1e6 });
      s.trimEnd(id, (p.at + p.src) * 1e6);
      if (p.speed !== 1) (window as any).__oe.getState().setSpeed(id, p.speed);
      out[p.key] = id;
    }
    return out;
  }, [
    { key: 'ref', file: 'tone.wav', at: 0, src: 2, speed: 1 },
    { key: 'vol', file: 'tone.wav', at: 2, src: 2, speed: 1 },
    { key: 'fade', file: 'tone.wav', at: 4, src: 2, speed: 1 },
    { key: 'norm', file: 'quiet.wav', at: 6, src: 4, speed: 1 },
    { key: 'fill', file: 'left.wav', at: 10, src: 2, speed: 1 },
    { key: 'nofill', file: 'left.wav', at: 12, src: 2, speed: 1 },
    { key: 'nr', file: 'beeps.wav', at: 14, src: 4, speed: 1 },
    { key: 'nonr', file: 'beeps.wav', at: 18, src: 4, speed: 1 },
    { key: 'chip', file: 'tone.wav', at: 22, src: 2, speed: 1 },
    { key: 'fast', file: 'tone.wav', at: 24, src: 2, speed: 2 },
    { key: 'fastpitch', file: 'tone.wav', at: 25, src: 2, speed: 2 },
  ]);
  const ends = await page.evaluate(() => {
    const p = (window as any).__oe.getState().project;
    return p.tracks.flatMap((t: any) => t.clips.map((c: any) => [c.start, c.duration]));
  });
  expect(ends.length).toBe(11);

  // ---- Basic: volume −6 dB, fade in 1 s
  await selectClip(page, ids.vol!);
  await typeValue(page, 'Volume value', '-6');
  expect((await clipAudio(page, ids.vol!)).volumeDb).toBe(-6);
  await selectClip(page, ids.fade!);
  await typeValue(page, 'Fade in value', '1');
  expect((await clipAudio(page, ids.fade!)).fadeIn).toBe(1_000_000);

  // ---- Normalize loudness (readout shows the measured level)
  await selectClip(page, ids.norm!);
  await page.getByRole('checkbox', { name: 'Enable Normalize loudness' }).check();
  await expect(page.getByTestId('normalize-readout')).toContainText('LUFS →', { timeout: 15_000 });
  const readout = (await page.getByTestId('normalize-readout').textContent()) ?? '';
  console.log('normalize readout:', readout);
  expect((await clipAudio(page, ids.norm!)).normalize).toBe(true);

  // ---- Fill channel (default: left), Reduce noise
  await selectClip(page, ids.fill!);
  await page.getByRole('checkbox', { name: 'Enable Fill channel' }).check();
  expect((await clipAudio(page, ids.fill!)).fillChannel).toBe('left');
  await selectClip(page, ids.nr!);
  await page.getByRole('checkbox', { name: 'Enable Reduce noise' }).check();
  expect((await clipAudio(page, ids.nr!)).reduceNoise).toBe(true);
  // AI rows are present but disabled
  for (const ai of ['enhance']) await expect(page.getByTestId(`audio-ai-${ai}`).getByRole('checkbox')).toBeDisabled();

  // ---- Voice changer: Chipmunk at strength 100 (= +12 semitones, pitch ×2)
  await selectClip(page, ids.chip!);
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Voice changer' }).click();
  await page.getByTestId('voice-filter-chipmunk').click();
  await typeValue(page, 'Strength value', '100');
  expect((await clipAudio(page, ids.chip!)).voiceFilter).toEqual({ id: 'chipmunk', strength: 100 });
  await screenshot(page, 'tab-audio-voice-changer');
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Basic' }).click();
  await screenshot(page, 'tab-audio-basic');

  // ---- Speed tab: "Change audio pitch" on the last clip
  await selectClip(page, ids.fastpitch!);
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Speed' }).click();
  await page.getByRole('switch', { name: 'Change audio pitch' }).click();
  expect((await clipAudio(page, ids.fastpitch!)).preservePitch).toBe(false);
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Audio' }).click();

  // ---- undo / redo of an Audio tab control
  await selectClip(page, ids.nonr!);
  await page.getByRole('checkbox', { name: 'Enable Reduce noise' }).check();
  expect((await clipAudio(page, ids.nonr!)).reduceNoise).toBe(true);
  await pressShortcut(page, 'Mod+Z');
  expect((await clipAudio(page, ids.nonr!)).reduceNoise).toBe(false);
  await pressShortcut(page, 'Mod+Shift+Z');
  expect((await clipAudio(page, ids.nonr!)).reduceNoise).toBe(true);
  await pressShortcut(page, 'Mod+Z');
  expect((await clipAudio(page, ids.nonr!)).reduceNoise).toBe(false);

  // ---- survives a reload
  const t0 = Date.now();
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().saveStatus.lastSavedAt ?? 0), { timeout: 15_000 }).toBeGreaterThan(t0 - 1);
  await page.reload();
  await openApp(page);
  await expect.poll(() => page.evaluate(() => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).length), { timeout: 15_000 }).toBe(11);
  expect(await clipAudio(page, ids.vol!)).toMatchObject({ volumeDb: -6 });
  expect(await clipAudio(page, ids.fade!)).toMatchObject({ fadeIn: 1_000_000 });
  expect(await clipAudio(page, ids.norm!)).toMatchObject({ normalize: true });
  expect(await clipAudio(page, ids.fill!)).toMatchObject({ fillChannel: 'left' });
  expect(await clipAudio(page, ids.nr!)).toMatchObject({ reduceNoise: true });
  expect(await clipAudio(page, ids.chip!)).toMatchObject({ voiceFilter: { id: 'chipmunk', strength: 100 } });
  expect(await clipAudio(page, ids.fastpitch!)).toMatchObject({ preservePitch: false, speed: 2 });
  // the asset URLs come back asynchronously after a reload
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).every((a: any) => !a.missing)), { timeout: 15_000 }).toBe(true);

  // ---- preview audio graph (dev hook)
  const vVol = await previewVoice(page, ids.vol!, 2.5, (v) => Math.abs(v.gain - 0.5012) < 0.01);
  const vNorm = await previewVoice(page, ids.norm!, 6.5, (v) => v.normalizeGain > 1.5 && Math.abs(v.gain - v.target) < 0.05);
  const vFill = await previewVoice(page, ids.fill!, 10.5, (v) => v.stages.includes('fill:left'));
  const vNr = await previewVoice(page, ids.nr!, 14.5, (v) => v.stages.includes('gate'));
  const vChip = await previewVoice(page, ids.chip!, 22.5, (v) => v.stages.includes('pitch:2.0000'));
  console.log('preview voices', JSON.stringify({ vVol, vNorm, vFill, vNr, vChip }));
  expect(vVol.target).toBeCloseTo(0.5012, 3);
  expect(vVol.stages).toEqual(['input', 'gain']);
  // the readout's gain and the preview's gain are the same number
  const readoutDb = Number(readout.match(/→ ([+−-]?[\d.]+) dB/)![1]!.replace('−', '-'));
  expect(20 * Math.log10(vNorm.normalizeGain)).toBeCloseTo(readoutDb, 1);
  expect(vNr.stages).toEqual(['input', 'highpass:80', 'gate', 'gain']);
  expect(vChip.stages).toEqual(['input', 'pitch:2.0000', 'voice:chipmunk:100', 'gain']);

  // ---- export a 720p MP4
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 300_000);
  expectMediaFile(file, { hasAudio: true, hasVideo: true, duration: 26, durationTolerance: 0.25 });

  // ---- measurements
  const ref = stats(file, 0.3, 1.4);
  const vol = stats(file, 2.3, 1.4);
  const volDiff = rms(vol) - rms(ref);
  const vd = volumedetect(file, 2.3, 1.4);
  const vdRef = volumedetect(file, 0.3, 1.4);

  // fade-in 4.0 → 5.0 s: RMS in 100 ms windows vs the ideal linear ramp
  const fadeRows: { t: number; measured: number; expected: number }[] = [];
  for (let k = 1; k <= 9; k++) {
    const a = 4 + k * 0.1;
    const s = stats(file, a, 0.1);
    // RMS of a ramp g(t) = (t − 4) over [a, a + 0.1] relative to full level
    const g0 = a - 4;
    const g1 = g0 + 0.1;
    const meanSq = (g1 ** 3 - g0 ** 3) / (3 * 0.1);
    fadeRows.push({ t: a, measured: rms(s) - rms(ref), expected: 10 * Math.log10(meanSq) });
  }
  const afterFade = rms(stats(file, 5.2, 0.6)) - rms(ref);

  const normI = ebur128(file, 6.3, 3.4);
  const normSrcI = ebur128(media.quiet, 0.3, 3.4);

  const fill = stats(file, 10.3, 1.4);
  const nofill = stats(file, 12.3, 1.4);

  // reduce noise: gaps 0.6–0.95 s after each beep (after the gate's 1.5 s learning), and the beeps
  const gap = (start: number) => [2, 3].map((k) => rms(stats(file, start + k + 0.6, 0.35)));
  const beep = (start: number) => rms(stats(file, start + 2 + 0.04, 0.12));
  const nrGaps = gap(14);
  const rawGaps = gap(18);
  const nrBeep = beep(14);
  const rawBeep = beep(18);

  const zcr = (s: Stats) => s['1']!['Zero crossings rate']!;
  const zRef = zcr(ref);
  const zChip = zcr(stats(file, 22.3, 1.4));
  const zFast = zcr(stats(file, 24.15, 0.7));
  const zFastPitch = zcr(stats(file, 25.15, 0.7));

  const report = {
    refRmsDb: rms(ref),
    volRmsDb: rms(vol),
    volDiffDb: volDiff,
    volumedetect: { ref: vdRef, minus6: vd },
    fade: fadeRows,
    afterFadeDb: afterFade,
    normalize: { sourceLUFS: normSrcI, exportedLUFS: normI, target: -23 },
    fill: { L: rms(fill, '1'), R: rms(fill, '2') },
    noFill: { L: rms(nofill, '1'), R: rms(nofill, '2') },
    reduceNoise: { gapsOn: nrGaps, gapsOff: rawGaps, beepOn: nrBeep, beepOff: rawBeep },
    zeroCrossings: { ref: zRef, chipmunk: zChip, speed2keepPitch: zFast, speed2changePitch: zFastPitch },
  };
  console.log('AUDIO MEASUREMENTS', JSON.stringify(report, null, 1));

  // −6 dB really is −6 dB
  expect(Math.abs(volDiff + 6)).toBeLessThan(0.2);
  expect(Math.abs(vd.max - vdRef.max + 6)).toBeLessThan(0.3);
  // the fade-in ramps: monotonic, each window within 1 dB of the ideal linear ramp, full level after
  for (let i = 1; i < fadeRows.length; i++) expect(fadeRows[i]!.measured).toBeGreaterThan(fadeRows[i - 1]!.measured);
  for (const r of fadeRows) expect(Math.abs(r.measured - r.expected), `fade @${r.t}`).toBeLessThan(1);
  expect(Math.abs(afterFade)).toBeLessThan(0.2);
  // normalize lands on −23 LUFS ±1 LU (source was ≈ −38)
  expect(normSrcI).toBeLessThan(-35);
  expect(Math.abs(normI + 23)).toBeLessThan(1);
  // fill channel copies the left channel to the right
  expect(Math.abs(report.fill.L - report.fill.R)).toBeLessThan(0.3);
  expect(Math.abs(report.fill.L - rms(ref, '1'))).toBeLessThan(0.3);
  expect(report.noFill.R).toBeLessThan(-60);
  // reduce noise: ≥ 15 dB less hiss in the pauses, the beeps untouched (±1 dB)
  for (let i = 0; i < nrGaps.length; i++) expect(rawGaps[i]! - nrGaps[i]!).toBeGreaterThan(15);
  expect(Math.abs(nrBeep - rawBeep)).toBeLessThan(1);
  // chipmunk 100 doubles the pitch; 2× speed keeps the pitch unless "Change audio pitch" is on
  expect(zChip / zRef).toBeGreaterThan(1.85);
  expect(zChip / zRef).toBeLessThan(2.15);
  expect(zFast / zRef).toBeGreaterThan(0.9);
  expect(zFast / zRef).toBeLessThan(1.1);
  expect(zFastPitch / zRef).toBeGreaterThan(1.9);
  expect(zFastPitch / zRef).toBeLessThan(2.1);

  expect(consoleErrors.real(), consoleErrors.real().join('\n')).toEqual([]);
});
