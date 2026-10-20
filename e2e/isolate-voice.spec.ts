/**
 * Voice isolation (DSP), end to end: the clip-menu slot sets the clip's audio field, the inspector
 * row edits it (undoable), the preview runs the oe-isolate worklet with the clip's measured noise
 * profile, and the exported MP4 is MEASURED with ffmpeg astats.
 *
 * Media (ffmpeg, temp folder), mono 48 kHz, 4 s:
 *   clean.wav  test-media/a-speech-like.wav × 0.25 (600 Hz beeps every 0.5 s, 1 kHz beep at .6 s)
 *   noisy.wav  clean + pink noise whose RMS equals the 600 Hz beep's RMS (0 dB SNR)
 * Timeline (one audio track): 0–4 noisy + Isolate voice 100 · 4–8 noisy (no effect) ·
 *   8–12 clean (reference beep level) · 12–16 clean + Remove vocals 100 (mono → speech-band notch)
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConsoleErrors, expectMediaFile, importMedia, openApp, pressShortcut, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MEDIA_DIR = path.join(os.tmpdir(), 'oe-isolate-voice-media');
const SPEECH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-media', 'a-speech-like.wav');

function ffmpegStderr(args: string[]): string {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-1500)}`);
  return r.stderr;
}

/** Overall RMS dB of [ss, ss+t) (astats). */
function rmsDb(file: string, ss: number, t: number): number {
  const err = ffmpegStderr(['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'pan=mono|c0=0.5*c0+0.5*c1,astats=metadata=0', '-f', 'null', '-']);
  const overall = err.slice(err.lastIndexOf('Overall'));
  const m = overall.match(/RMS level dB: (-?[\d.]+|-inf)/);
  if (!m) throw new Error(`no astats:\n${err.slice(-1500)}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}
const rmsMono = (file: string, ss: number, t: number): number => {
  const err = ffmpegStderr(['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-af', 'astats=metadata=0', '-f', 'null', '-']);
  return Number(err.slice(err.lastIndexOf('Overall')).match(/RMS level dB: (-?[\d.]+)/)![1]);
};

function makeMedia(): { clean: string; noisy: string } {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const clean = path.join(MEDIA_DIR, 'clean.wav');
  const pink = path.join(MEDIA_DIR, 'pink.wav');
  const noisy = path.join(MEDIA_DIR, 'noisy.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', SPEECH, '-af', 'volume=0.25', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', clean]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.5:seed=7:sample_rate=48000:duration=4', '-ac', '1', '-c:a', 'pcm_f32le', pink]);
  // 0 dB SNR: pink RMS = RMS inside a 600 Hz beep
  const beep = rmsMono(clean, 0.02, 0.11);
  const noise = rmsMono(pink, 0, 4);
  const gain = Math.pow(10, (beep - noise) / 20);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clean, '-i', pink, '-filter_complex', `[1:a]volume=${gain.toFixed(6)}[n];[0:a][n]amix=inputs=2:normalize=0:duration=first`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', noisy]);
  return { clean, noisy };
}

const S = (s: number) => Math.round(s * 1e6);

async function clipAudio(page: Page, id: string): Promise<any> {
  return page.evaluate((cid) => {
    const p = (window as any).__oe.getState().project;
    for (const t of p.tracks) for (const c of t.clips) if (c.id === cid) return c.audio;
    return null;
  }, id);
}

/** Runs submenu item `index` of the registered "isolateVoice" slot on `ids` (the menu UI's job). */
async function runMenu(page: Page, ids: string[], index: number) {
  await page.evaluate(
    ({ ids, index }) => {
      const item = (window as any).__oeMenu.getSlot('isolateVoice');
      const ctx = { clipIds: ids, primaryId: ids[0], trackId: '', time: 0 };
      if (item.disabled?.(ctx)) throw new Error('menu item disabled');
      item.submenu(ctx)[index].run(ctx);
    },
    { ids, index },
  );
}

test('Voice isolation (DSP): menu + inspector set it, preview runs it, export measures it', async ({ page }) => {
  test.setTimeout(240_000);
  const media = makeMedia();
  const consoleErrors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, [media.clean, media.noisy]);

  const ids: Record<string, string> = await page.evaluate((plan) => {
    const out: Record<string, string> = {};
    for (const p of plan) {
      const s = (window as any).__oe.getState();
      const asset = Object.values(s.project.assets as Record<string, any>).find((a: any) => a.name === p.file)!;
      const id = s.addClip(asset.id, { at: p.at * 1e6 });
      (window as any).__oe.getState().trimEnd(id, (p.at + 4) * 1e6);
      out[p.key] = id;
    }
    return out;
  }, [
    { key: 'iso', file: 'noisy.wav', at: 0 },
    { key: 'raw', file: 'noisy.wav', at: 4 },
    { key: 'clean', file: 'clean.wav', at: 8 },
    { key: 'rem', file: 'clean.wav', at: 12 },
  ]);

  // ---- the menu slot: label, tag, and it writes the field (one undo step)
  const slot = await page.evaluate(() => {
    const it = (window as any).__oeMenu.getSlot('isolateVoice');
    return { label: it.label, tag: it.tag };
  });
  expect(slot).toEqual({ label: 'Isolate voice', tag: 'Free' });
  await runMenu(page, [ids.iso!], 0);
  expect((await clipAudio(page, ids.iso!)).voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });
  await runMenu(page, [ids.rem!], 1);
  expect((await clipAudio(page, ids.rem!)).voiceIsolation).toEqual({ mode: 'remove', strength: 100 });

  // ---- the inspector row is enabled, labelled DSP, and edits the same field (undoable)
  await page.evaluate((cid) => (window as any).__oe.getState().select([cid]), ids.iso!);
  await expect(page.getByTestId('inspector-audio')).toBeVisible();
  const row = page.getByTestId('section-audio-isolate');
  await expect(row).toContainText('DSP');
  await expect(row.getByRole('checkbox', { name: 'Enable Isolate voice' })).toBeChecked();
  const box = row.getByLabel('Strength value', { exact: true });
  await box.click();
  await box.fill('40');
  await box.press('Enter');
  expect((await clipAudio(page, ids.iso!)).voiceIsolation).toEqual({ mode: 'isolate', strength: 40 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressShortcut(page, 'Mod+Z');
  expect((await clipAudio(page, ids.iso!)).voiceIsolation).toEqual({ mode: 'isolate', strength: 100 });

  // ---- preview: the worklet runs with the measured noise profile
  await page.evaluate((us) => {
    const st = (window as any).__oe.getState();
    st.setPlayhead(us);
    st.play();
  }, S(0.5));
  let stages: string[] = [];
  try {
    await expect
      .poll(
        async () => {
          const v = (await page.evaluate(() => (window as any).__oeAudio.voices())).find((x: any) => x.clipId === ids.iso);
          stages = v?.stages ?? [];
          return stages.includes('isolate:100:profile');
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await page.evaluate(() => (window as any).__oe.getState().pause());
  }
  console.log('preview stages', stages.join(' → '));
  expect(stages).toEqual(['input', 'isolate:100:profile', 'gain']);

  // ---- export
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 180_000);
  expectMediaFile(file, { hasAudio: true, hasVideo: true, duration: 16, durationTolerance: 0.25 });

  // windows (s, relative to the clip start) that hold for the dry clips AND for the isolated one,
  // which comes out 1024 samples (21 ms) late
  const pauses = [1, 2, 3].map((k) => k + 0.2);
  const pauseLen = 0.28;
  const beep600 = [1, 2, 3].map((k) => k + 0.04);
  const beep1k = [1, 2, 3].map((k) => k + 0.68);
  const at = (clip: number, list: number[], len: number) => list.map((t) => rmsDb(file, clip + t, len));
  const r = {
    pauseIso: at(0, pauses, pauseLen),
    pauseRaw: at(4, pauses, pauseLen),
    beep600Iso: at(0, beep600, 0.09),
    beep600Raw: at(4, beep600, 0.09),
    beep600Clean: at(8, beep600, 0.09),
    beep1kIso: at(0, beep1k, 0.06),
    beep1kClean: at(8, beep1k, 0.06),
    beep600Removed: at(12, beep600, 0.09),
  };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const summary = {
    noiseDropDb: pauses.map((_, i) => r.pauseRaw[i]! - r.pauseIso[i]!),
    beep600ChangeVsCleanDb: beep600.map((_, i) => r.beep600Iso[i]! - r.beep600Clean[i]!),
    beep1kChangeVsCleanDb: beep1k.map((_, i) => r.beep1kIso[i]! - r.beep1kClean[i]!),
    noisyBeepVsCleanDb: mean(r.beep600Raw) - mean(r.beep600Clean),
    removeVocalsBeepDropDb: mean(r.beep600Clean) - mean(r.beep600Removed),
  };
  console.log('ISOLATE MEASUREMENTS', JSON.stringify({ ...r, ...summary }, null, 1));
  for (const d of summary.noiseDropDb) expect(d).toBeGreaterThanOrEqual(15);
  for (const d of [...summary.beep600ChangeVsCleanDb, ...summary.beep1kChangeVsCleanDb]) expect(Math.abs(d)).toBeLessThan(2);
  expect(summary.removeVocalsBeepDropDb).toBeGreaterThan(20);

  expect(consoleErrors.real(), consoleErrors.real().join('\n')).toEqual([]);
});
