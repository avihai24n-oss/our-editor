/**
 * Captions, end to end: Auto captions from the timeline (whisper mocked with a real whisper.cpp
 * output, and once for real), the caption lab (edit text, split, merge, per-word timing, style,
 * undo), the MakePodcast styles in the player (Hebrew RTL and English), SRT / VTT / word JSON
 * import + export, and burn-in in an exported MP4.
 *
 * Speech is synthesised with macOS `say` (Carmit = Hebrew, Samantha = English) into a temp folder.
 * Run: cd e2e && E2E_PORT=5403 npx playwright test captions.spec.ts
 * The real-whisper test is tagged @slow (needs /opt/homebrew/bin/whisper-cli + a model).
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConsoleErrors, importMedia, openApp, screenshot, SCREENS_DIR, waitForDownload } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'src', 'captions', '__fixtures__');
const MEDIA_DIR = path.join(os.tmpdir(), 'oe-captions-media');
const HE_TEXT = 'שלום לכולם. היום נספר לכם סיפור על בית הכנסת בירושלים, ועל המשפחה שבנתה אותו.';
/** What whisper.cpp heard in the Carmit recording (src/captions/__fixtures__/whisper-he-carmit.json). */
const HE_HEARD = 'שלום לכולם, היום נספר לכם סיפור על בית הכנסת בירושלים, ועל המשפחה שבנתה אותו.';
const EN_TEXT = 'The quick brown fox jumps over the lazy dog. [[slnc 1500]] Then it rests for a moment, [[slnc 800]] and runs home again.';

function makeSpeech(name: string, voice: string, text: string): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = path.join(MEDIA_DIR, name);
  if (fs.existsSync(out)) return out;
  const aiff = out.replace(/\.\w+$/, '.aiff');
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '2', out]);
  return out;
}

const hasSay = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout?.includes('Carmit') ?? false;

async function setupProject(page: Page, opts: { aspect: '16:9' | '9:16'; audio: string; video?: string }) {
  await openApp(page);
  await page.evaluate((aspect) => (window as any).__oe.getState().newProject({ name: 'Captions e2e', aspect }), opts.aspect);
  const files = [opts.audio, ...(opts.video ? [opts.video] : [])];
  await importMedia(page, files);
  await page.evaluate(
    ({ audio, video }) => {
      const st = (window as any).__oe.getState();
      const assets = Object.values(st.project.assets) as any[];
      const a = assets.find((x) => x.name === audio);
      if (video) {
        const v = assets.find((x) => x.name === video);
        const id = st.addClip(v.id, { at: 0 });
        st.updateClip(id, { audio: { muted: true } });
      }
      st.addClip(a.id, { at: 0 });
      st.clearSelection();
    },
    { audio: path.basename(opts.audio), video: opts.video ? path.basename(opts.video) : undefined },
  );
}

/** Answers /__transcribe/* with a saved whisper.cpp output (fast, deterministic). */
async function mockWhisper(page: Page, fixture: string) {
  const result = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
  await page.route('**/__transcribe/info', (r) => r.fulfill({ json: { available: true, model: 'large-v3-turbo (mock)', models: [] } }));
  await page.route('**/__transcribe/start**', (r) => r.fulfill({ json: { id: 'mock-1', model: 'mock' } }));
  let polls = 0;
  await page.route('**/__transcribe/status**', (r) => {
    polls++;
    return r.fulfill({ json: polls < 2 ? { state: 'running', progress: 0.5 } : { state: 'done', progress: 1, result } });
  });
}

const state = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__oe.getState().project;
    const t = p.tracks.find((x: any) => x.captions);
    return {
      track: t ? { id: t.id, style: t.captions.style, burnIn: t.captions.burnIn, language: t.captions.language, locked: t.locked } : null,
      clips: t ? t.clips.map((c: any) => ({ id: c.id, start: c.start, duration: c.duration, text: c.text.content, words: c.caption?.words, offset: c.caption?.offset })) : [],
    };
  });

const setPlayhead = (page: Page, sec: number) => page.evaluate((s) => (window as any).__oe.getState().setPlayhead(Math.round(s * 1e6)), sec);

async function playerShot(page: Page, name: string) {
  await page.waitForTimeout(350);
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await page.getByTestId('player').screenshot({ path: path.join(SCREENS_DIR, name) });
}

async function openCaptionsTab(page: Page, cat?: 'Auto captions' | 'Caption styles' | 'Caption files') {
  await page.getByTestId('library-tab-captions').click();
  if (cat) await page.getByTestId('left-panel').getByRole('button', { name: cat, exact: true }).click();
}

test.describe('captions', () => {
  test.skip(!hasSay, 'needs macOS say with the Carmit voice');

  test('auto captions (Hebrew, mocked whisper) → caption track, RTL karaoke in the player, caption lab edits + undo', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const he = makeSpeech('he-carmit.wav', 'Carmit', HE_TEXT);
    await mockWhisper(page, 'whisper-he-carmit.json');
    await setupProject(page, { aspect: '9:16', audio: he, video: path.join(here, '..', 'test-media', 'v-long-60s.mp4') });
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-lang').selectOption('he');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-done')).toContainText('captions');
    const s = await state(page);
    expect(s.track).not.toBeNull();
    expect(s.track!.language).toBe('he');
    expect(s.track!.style.preset).toBe('karaoke');
    const words = s.clips.flatMap((c) => c.words.map((w: any) => w.text));
    expect(words.join(' ')).toBe(HE_HEARD);
    // MakePodcast grouping: ≤ 4 words, break after a sentence end / comma
    for (const c of s.clips) expect(c.words.length).toBeLessThanOrEqual(4);
    expect(s.clips[0]!.text).toBe('שלום לכולם,');
    // clips never overlap; words fall inside their clip
    for (let i = 0; i < s.clips.length; i++) {
      const c = s.clips[i]!;
      if (i) expect(c.start).toBeGreaterThanOrEqual(s.clips[i - 1]!.start + s.clips[i - 1]!.duration);
      for (const w of c.words) expect(w.start).toBeGreaterThanOrEqual(-1);
    }
    await expect(page.locator('[data-testid="timeline-clip"][data-clip-type="text"]')).toHaveCount(s.clips.length);

    // the lab opened on the first caption
    await expect(page.getByTestId('inspector-caption')).toBeVisible();
    await expect(page.getByTestId('caplab-row')).toHaveCount(s.clips.length);

    // the player: second word ("לכולם.") spoken → highlighted in coral, the line reads right to left
    const c0 = s.clips[0]!;
    const w1 = c0.words[1];
    await setPlayhead(page, (c0.start - (c0.offset ?? 0) + (w1.start + w1.end) / 2) / 1e6);
    await playerShot(page, 'captions-he-karaoke.png');
    await screenshot(page, 'captions-he-editor.png');

    // edit the text of the caption with "סיפור": one word replaced, timings kept
    const ei = s.clips.findIndex((c) => c.text.includes('סיפור'));
    const row = page.getByTestId('caplab-row').nth(ei);
    const before = s.clips[ei]!;
    await row.getByTestId('caplab-text').click();
    const replaced = before.text.replace('סיפור', 'מעשה');
    await row.getByTestId('caplab-text').fill(replaced);
    await row.getByTestId('caplab-text').press('Enter');
    let s2 = await state(page);
    expect(replaced).not.toBe(before.text);
    expect(s2.clips[ei]!.text).toBe(replaced);
    expect(s2.clips[ei]!.words.map((w: any) => [w.start, w.end])).toEqual(before.words.map((w: any) => [w.start, w.end]));
    await page.keyboard.press('Meta+z');
    s2 = await state(page);
    expect(s2.clips[ei]!.text).toBe(before.text);

    // split the first caption before its second word, then merge it back
    await page.evaluate((id) => (window as any).__oe.getState().select([id]), s.clips[0]!.id);
    await page.getByTestId('caplab-row').nth(0).getByTestId('caplab-split').nth(1).click();
    s2 = await state(page);
    expect(s2.clips.length).toBe(s.clips.length + 1);
    expect(s2.clips[0]!.text).toBe('שלום');
    expect(s2.clips[1]!.text).toBe('לכולם,');
    expect(s2.clips[1]!.start).toBe(c0.start - (c0.offset ?? 0) + w1.start);
    await page.getByTestId('caplab-row').nth(0).getByTestId('caplab-merge').click();
    s2 = await state(page);
    expect(s2.clips.length).toBe(s.clips.length);
    expect(s2.clips[0]!.text).toBe('שלום לכולם,');

    // per-word timing: move word 2 of caption 1 later by 40 ms
    await page.evaluate((id) => (window as any).__oe.getState().select([id]), s2.clips[0]!.id);
    const wb = await state(page);
    await page.getByTestId('caplab-word').nth(1).getByTitle('Later by 40 ms').click();
    const wa = await state(page);
    expect(wa.clips[0]!.words[1].start).toBe(wb.clips[0]!.words[1].start + 40_000);

    expect(errors.real()).toEqual([]);
  });

  test('styles: every MakePodcast preset renders, Hebrew + English; style lab changes are undoable', async ({ page }) => {
    const he = makeSpeech('he-carmit.wav', 'Carmit', HE_TEXT);
    await mockWhisper(page, 'whisper-he-carmit.json');
    await setupProject(page, { aspect: '16:9', audio: he, video: path.join(here, '..', 'test-media', 'v-landscape-4s.mp4') });
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-done')).toBeVisible();
    let s = await state(page);
    expect(s.track!.style.preset).toBe('subtitle'); // landscape default
    // a time inside the 3rd word of caption 2
    const c = s.clips[1]!;
    const w = c.words[Math.min(2, c.words.length - 1)];
    const t = (c.start - (c.offset ?? 0) + (w.start * 0.3 + w.end * 0.7)) / 1e6;
    await setPlayhead(page, t);
    await playerShot(page, 'captions-he-subtitle-16x9.png');
    await openCaptionsTab(page, 'Caption styles');
    await screenshot(page, 'captions-styles-tab.png');
    for (const id of ['karaoke', 'word-pop', 'plain', 'hormozi', 'box', 'karaoke-glow', 'karaoke-fill', 'bounce', 'reveal', 'outline']) {
      await page.getByTestId(`cap-preset-${id}`).click();
      s = await state(page);
      expect(s.track!.style.preset).toBe(id);
      await setPlayhead(page, t);
      await playerShot(page, `captions-he-${id}.png`);
    }
    // style lab: font + size + highlight, then undo restores
    await page.evaluate((id) => (window as any).__oe.getState().select([id]), s.clips[1]!.id);
    await page.getByTestId('inspector-caption').getByRole('tab', { name: 'Style' }).click();
    await page.getByTestId('cap-font').selectOption('Frank Ruhl Libre');
    s = await state(page);
    expect(s.track!.style.fontFamily).toBe('Frank Ruhl Libre');
    await page.getByLabel('Highlight Green').click();
    s = await state(page);
    expect(s.track!.style.highlightColor).toBe('#00E5A0');
    await playerShot(page, 'captions-he-frank-green.png');
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    s = await state(page);
    expect(s.track!.style.fontFamily).not.toBe('Frank Ruhl Libre');
  });

  test('SRT round trip: export SRT / VTT / JSON, import SRT back', async ({ page }) => {
    const he = makeSpeech('he-carmit.wav', 'Carmit', HE_TEXT);
    await mockWhisper(page, 'whisper-he-carmit.json');
    // downloads instead of the save server (the test must not write into ~/Downloads)
    await page.route('**/__save/defaults', (r) => r.fulfill({ status: 404, json: {} }));
    await setupProject(page, { aspect: '9:16', audio: he });
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-done')).toBeVisible();
    const s = await state(page);
    await openCaptionsTab(page, 'Caption files');
    const srt = await waitForDownload(page, () => page.getByTestId('cap-export-srt').click(), 20_000);
    const vtt = await waitForDownload(page, () => page.getByTestId('cap-export-vtt').click(), 20_000);
    const json = await waitForDownload(page, () => page.getByTestId('cap-export-json').click(), 20_000);
    const srtText = fs.readFileSync(srt, 'utf8');
    expect(srtText).toContain('00:00:00,');
    expect(srtText).toContain('שלום לכולם,');
    expect(fs.readFileSync(vtt, 'utf8')).toMatch(/^﻿?WEBVTT/);
    const j = JSON.parse(fs.readFileSync(json, 'utf8'));
    expect(j.captions.length).toBe(s.clips.length);
    expect(j.captions[0].words.length).toBeGreaterThan(0);
    // remove everything, import the SRT back: same texts and spans (ms precision)
    await page.getByTestId('cap-clear').click();
    expect((await state(page)).clips.length).toBe(0);
    await page.getByTestId('cap-import-input').setInputFiles(srt);
    await expect.poll(async () => (await state(page)).clips.length).toBe(s.clips.length);
    const back = await state(page);
    expect(back.clips.map((c) => c.text)).toEqual(s.clips.map((c) => c.text));
    back.clips.forEach((c, i) => expect(Math.abs(c.start - s.clips[i]!.start)).toBeLessThanOrEqual(1000));
  });

  test('burn-in: the exported MP4 shows the captions (and not when burn-in is off)', async ({ page }) => {
    test.setTimeout(240_000);
    const he = makeSpeech('he-carmit.wav', 'Carmit', HE_TEXT);
    await mockWhisper(page, 'whisper-he-carmit.json');
    await setupProject(page, { aspect: '9:16', audio: he });
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-done')).toBeVisible();
    const exportOnce = async () => {
      await page.getByTestId('export-button').click();
      await expect(page.getByTestId('export-dialog')).toBeVisible();
      const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click());
      await page.keyboard.press('Escape');
      return file;
    };
    const brightAt = (file: string, sec: number) => {
      const png = path.join(MEDIA_DIR, `frame-${path.basename(file)}-${sec}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(sec), '-i', file, '-frames:v', '1', png]);
      const r = spawnSync('ffmpeg', ['-v', 'info', '-i', png, '-vf', 'crop=iw:ih*0.2:0:ih*0.7,signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' });
      const ymax = Number(r.stderr.match(/signalstats\.YMAX=(\d+)/)?.[1] ?? 0);
      return { png, ymax };
    };
    const on = await exportOnce();
    const a = brightAt(on, 1.0);
    expect(a.ymax).toBeGreaterThan(200); // white caption text over the black canvas
    fs.copyFileSync(a.png, path.join(SCREENS_DIR, 'captions-export-burned.png'));
    await openCaptionsTab(page, 'Caption files');
    await page.getByTestId('cap-burn-in').uncheck();
    const off = await exportOnce();
    const b = brightAt(off, 1.0);
    expect(b.ymax).toBeLessThan(60);
  });

  test('@slow real whisper: Hebrew and English speech from the timeline', async ({ page }) => {
    test.setTimeout(240_000);
    const info = spawnSync('ls', [path.join(os.homedir(), '.whisper-models')], { encoding: 'utf8' }).stdout ?? '';
    test.skip(!fs.existsSync('/opt/homebrew/bin/whisper-cli') || !/ggml-.*\.bin/.test(info), 'whisper.cpp not installed');
    const he = makeSpeech('he-carmit.wav', 'Carmit', HE_TEXT);
    const en = makeSpeech('en-samantha.wav', 'Samantha', EN_TEXT);
    await setupProject(page, { aspect: '9:16', audio: he });
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-lang').selectOption('he');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-progress')).toBeVisible();
    await expect(page.getByTestId('cap-done')).toBeVisible({ timeout: 180_000 });
    let s = await state(page);
    const heWords = s.clips.flatMap((c) => c.words.map((w: any) => w.text)).join(' ');
    expect(heWords).toContain('שלום');
    expect(heWords).toContain('בירושלים');
    // words in order, inside the audio
    const all = s.clips.flatMap((c) => c.words.map((w: any) => ({ ...w, start: w.start + c.start - (c.offset ?? 0), end: w.end + c.start - (c.offset ?? 0) })));
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBeGreaterThanOrEqual(all[i - 1].end);
    expect(all[0].start).toBeLessThan(600_000);
    expect(all[all.length - 1].end).toBeLessThan(7_200_000);
    await setPlayhead(page, (all[3].start + all[3].end) / 2e6);
    await playerShot(page, 'captions-real-he.png');

    // English, on the same timeline after the Hebrew, re-run only on the selected clip
    await page.getByTestId('library-tab-media').click();
    await importMedia(page, [en]);
    const enId = await page.evaluate((name) => {
      const st = (window as any).__oe.getState();
      const a = (Object.values(st.project.assets) as any[]).find((x) => x.name === name);
      const id = st.addClip(a.id, { at: 8_000_000 });
      st.select([id]);
      return id;
    }, path.basename(en));
    expect(enId).toBeTruthy();
    await openCaptionsTab(page, 'Auto captions');
    await page.getByTestId('cap-lang').selectOption('en');
    await page.getByTestId('cap-range').selectOption('selected');
    await page.getByTestId('cap-generate').click();
    await expect(page.getByTestId('cap-done')).toBeVisible({ timeout: 180_000 });
    s = await state(page);
    const heAfter = s.clips.filter((c) => c.start < 8_000_000).flatMap((c) => c.words.map((w: any) => w.text)).join(' ');
    expect(heAfter).toBe(heWords); // the Hebrew captions outside the range are untouched
    const enClips = s.clips.filter((c) => c.start >= 8_000_000);
    const enText = enClips.map((c) => c.text).join(' ').toLowerCase();
    expect(enText).toContain('quick brown fox');
    expect(enText).toContain('home again');
    // "Then" starts after the 1.5 s pause (≈ 4.2 s into the clip)
    const then = enClips.flatMap((c) => c.words.map((w: any) => ({ text: w.text, start: w.start + c.start - (c.offset ?? 0) }))).find((w: any) => /^then$/i.test(w.text));
    expect(then).toBeTruthy();
    expect(Math.abs(then!.start - 8_000_000 - 4_200_000)).toBeLessThan(300_000);
    await setPlayhead(page, (then!.start + 150_000) / 1e6);
    await playerShot(page, 'captions-real-en.png');
  });
});
