/**
 * Voice changer audition (src/player/audition.ts): picking a voice filter tile restarts the
 * selected clip from its start and plays it to its end, with the preview graph already switched to
 * the new filter when the sound starts; another tile restarts it; the "Auto-play on change" switch
 * turns it off; Space playback is unaffected (runs on past the clip).
 *
 * Timeline: a-speech-like.wav (4 s) at 2–6 s, a-tone-6s.mp3 at 7–13 s.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsoleErrors, importMedia, openApp, pressShortcut, screenshot } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const S = (s: number) => Math.round(s * 1e6);

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__oe.getState();
    return { playing: s.playing as boolean, playhead: s.playhead as number };
  });

/** Starts sampling (store playhead, the clip's live voice) every animation frame. */
async function startSampling(page: Page, clipId: string) {
  await page.evaluate((cid) => {
    const w = window as any;
    w.__samples = [];
    w.__sampling = true;
    const step = () => {
      if (!w.__sampling) return;
      const s = w.__oe.getState();
      const v = w.__oeAudio.voices().find((x: any) => x.clipId === cid) ?? null;
      w.__samples.push({ playhead: s.playhead, playing: s.playing, paused: v ? v.paused : true, stages: v ? v.stages : [] });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, clipId);
}
async function stopSampling(page: Page): Promise<{ playhead: number; playing: boolean; paused: boolean; stages: string[] }[]> {
  return page.evaluate(() => {
    const w = window as any;
    w.__sampling = false;
    return w.__samples;
  });
}

test('Voice changer: a tile click auditions the clip with the new filter, start to end', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  await openApp(page);
  await importMedia(page, ['a-speech-like.wav', 'a-tone-6s.mp3']);
  const ids: { speech: string; tone: string } = await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const by = (n: string) => Object.values(s.project.assets as Record<string, any>).find((a: any) => a.name === n)!.id;
    const speech = s.addClip(by('a-speech-like.wav'), { at: 2e6 });
    const tone = (window as any).__oe.getState().addClip(by('a-tone-6s.mp3'), { at: 7e6 });
    return { speech, tone };
  });
  const clip = await page.evaluate((id) => {
    for (const t of (window as any).__oe.getState().project.tracks) for (const c of t.clips) if (c.id === id) return { start: c.start, end: c.start + c.duration };
    return null;
  }, ids.speech);
  expect(clip).toEqual({ start: S(2), end: S(6) });
  // the asset URLs are ready
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__oe.getState().project.assets).every((a: any) => !a.missing)), { timeout: 15_000 }).toBe(true);

  await page.evaluate((id) => {
    const s = (window as any).__oe.getState();
    s.select([id]);
    s.setPlayhead(0);
  }, ids.speech);
  await expect(page.getByTestId('inspector-audio')).toBeVisible();
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Voice changer' }).click();
  const autoplay = page.getByRole('switch', { name: 'Auto-play on change' });
  await expect(autoplay).toHaveAttribute('aria-checked', 'true');
  await screenshot(page, 'voice-audition-panel');

  // ---- 1. paused, playhead at 0: Robot → plays from the clip start, robot already in the graph
  await startSampling(page, ids.speech);
  await page.getByTestId('voice-filter-robot').click();
  await expect.poll(async () => (await state(page)).playing).toBe(true);
  await expect.poll(async () => (await page.evaluate((cid) => (window as any).__oeAudio.voices().find((v: any) => v.clipId === cid)?.paused ?? true, ids.speech)), { timeout: 10_000 }).toBe(false);
  let samples = await stopSampling(page);
  expect(samples.filter((x) => x.playing)[0]!.playhead).toBeGreaterThanOrEqual(S(2));
  expect(samples.filter((x) => x.playing)[0]!.playhead).toBeLessThan(S(2.2));
  const firstSound = samples.find((x) => !x.paused)!;
  console.log('first sounding sample', JSON.stringify(firstSound));
  expect(firstSound.stages.some((st) => st.startsWith('voice:robot'))).toBe(true);
  // every sounding sample carries the robot
  for (const x of samples.filter((y) => !y.paused)) expect(x.stages.some((st) => st.startsWith('voice:robot'))).toBe(true);
  await screenshot(page, 'voice-audition-playing');

  // ---- 2. it stops by itself at the clip end (6 s), not the project end (13 s)
  await expect.poll(async () => (await state(page)).playing, { timeout: 10_000 }).toBe(false);
  expect((await state(page)).playhead).toBe(S(6));

  // ---- 3. while playing, another tile restarts from the clip start with the new filter
  await page.getByTestId('voice-filter-phone').click();
  await expect.poll(async () => (await state(page)).playhead, { timeout: 10_000 }).toBeGreaterThan(S(3.2));
  expect((await state(page)).playing).toBe(true);
  const before = (await state(page)).playhead;
  await startSampling(page, ids.speech);
  await page.getByTestId('voice-filter-cathedral').click();
  await expect.poll(async () => (await state(page)).playhead).toBeLessThan(before);
  await page.waitForTimeout(400);
  samples = await stopSampling(page);
  const reseek = samples.findIndex((x) => x.playhead < before);
  expect(reseek).toBeGreaterThanOrEqual(0);
  expect(samples[reseek]!.playhead).toBeGreaterThanOrEqual(S(2));
  expect(samples[reseek]!.playhead).toBeLessThan(S(2.3));
  for (const x of samples.slice(reseek)) if (!x.paused) expect(x.stages.some((st) => st.startsWith('voice:cathedral'))).toBe(true);
  console.log('after restart', JSON.stringify(samples[reseek + 2] ?? samples[reseek]));
  expect((await state(page)).playing).toBe(true);
  // a Strength drag does not restart (the graph follows it live)
  const ph = (await state(page)).playhead;
  const box = page.getByTestId('voice-strength-row').getByLabel('Strength value', { exact: true });
  await box.click();
  await box.fill('80');
  await box.press('Enter');
  await page.waitForTimeout(200);
  expect((await state(page)).playhead).toBeGreaterThan(ph);
  await expect.poll(async () => (await state(page)).playing, { timeout: 10_000 }).toBe(false);
  expect((await state(page)).playhead).toBe(S(6));

  // ---- 4. a Mixer preset auditions too
  await page.getByTestId('mixer-preset-clean-vo').click();
  await expect.poll(async () => (await state(page)).playing).toBe(true);
  expect((await state(page)).playhead).toBeLessThan(S(2.5));
  await page.evaluate(() => (window as any).__oe.getState().pause());

  // ---- 5. switch off: a tile changes the filter but nothing plays or moves
  await autoplay.click();
  await expect(autoplay).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(4.5e6));
  await page.getByTestId('voice-filter-none').click();
  await page.waitForTimeout(300);
  expect(await state(page)).toEqual({ playing: false, playhead: S(4.5) });
  expect(await page.evaluate((id) => {
    for (const t of (window as any).__oe.getState().project.tracks) for (const c of t.clips) if (c.id === id) return c.audio.voiceFilter;
  }, ids.speech)).toBeNull();
  await screenshot(page, 'voice-audition-off');

  // ---- 6. Space playback is normal: it runs on past the clip end
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(5e6));
  await pressShortcut(page, 'Space');
  await expect.poll(async () => (await state(page)).playhead, { timeout: 10_000 }).toBeGreaterThan(S(6.6));
  expect((await state(page)).playing).toBe(true);
  await pressShortcut(page, 'Space');
  await expect.poll(async () => (await state(page)).playing).toBe(false);

  // the switch is remembered
  await page.reload();
  await openApp(page);
  await page.evaluate((id) => (window as any).__oe.getState().select([id]), ids.speech);
  await page.getByTestId('inspector-audio').getByRole('tab', { name: 'Voice changer' }).click();
  await expect(page.getByRole('switch', { name: 'Auto-play on change' })).toHaveAttribute('aria-checked', 'false');
  expect(errors.real()).toEqual([]);
});
