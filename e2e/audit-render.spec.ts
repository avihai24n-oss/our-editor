/**
 * FUNCTIONAL AUDIT of the player and the render engine: does the preview canvas really show
 * what the project says? Every check reads pixels from the real player canvas and compares
 * them with a number derived from the document (or with ffmpeg reference frames).
 * Results are summarised in docs/AUDIT-render.md.
 *
 * Media is synthetic and built by ffmpeg on first run (e2e/audit-media/, git-ignored).
 * Run alone: E2E_PORT=5170 npx playwright test audit-render.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { waitForDownload } from './helpers';
import {
  RENDER_AM as AM,
  CODE,
  DECODE_SRC,
  canvasRGB,
  canvasInfo,
  colorStats,
  COLORS,
  near,
  pixel,
  store,
  ensureRenderMedia as ensureAuditMedia,
  mae,
  refFrame,
  seek,
  settle,
  setupAudit,
  shownFrame,
} from './audit-helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FPS = 30;
const fr = (n: number) => Math.round((n * 1e6) / FPS);

test.beforeAll(() => ensureAuditMedia());
test.describe.configure({ mode: 'serial' });

/** Source frame index the document says must be on screen at t (main track). */
async function expectedFrame(page: Page, t: number): Promise<{ frame: number; id: string; sourceTime: number } | null> {
  return page.evaluate(async (t) => {
    const { getFrameState } = await import('/src/engine/frameState.ts' as any);
    const s = (window as any).__oe.getState();
    const fs = getFrameState(s.project, t);
    const op = fs.ops.find((o: any) => o.kind === 'media');
    if (!op) return null;
    const name = s.project.assets[op.assetId].name as string;
    const id = name.includes('code-a') ? 'A' : name.includes('code-b') ? 'B' : 'S';
    return { frame: Math.floor((op.sourceTime * 30) / 1e6 + 0.01), id, sourceTime: op.sourceTime };
  }, t);
}

async function checkFrames(page: Page, label: string, times: number[], log: string[]) {
  const bad: string[] = [];
  for (const t of times) {
    await seek(page, t);
    const want = await expectedFrame(page, t);
    const got = await shownFrame(page);
    const ok = !!want && got.frame === want.frame && got.id === want.id;
    log.push(`${label} t=${(t / 1e6).toFixed(4)}s want ${want?.id}#${want?.frame} got ${got.id}#${got.frame} ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) bad.push(`t=${t}: want ${want?.id}#${want?.frame} got ${got.id}#${got.frame}`);
  }
  return bad;
}

test('frame accuracy after seek: plain, split, trim-left, speed (code strip + ffmpeg refs)', async ({ page }) => {
  test.setTimeout(240_000);
  const ids = await setupAudit(page, [AM.codeA]);
  const a = ids[AM.codeA]!;
  const log: string[] = [];
  page.on('close', () => console.log(log.join('\n')));
  const clipId = await page.evaluate((a) => (window as any).__oe.getState().addClip(a, { at: 0 }), a);

  // ---- plain
  const times = [0, fr(1), fr(2), fr(15), fr(29), fr(30), fr(31), fr(100), fr(211), fr(359)];
  let bad = await checkFrames(page, 'plain', times, log);

  // ---- ffmpeg reference: the canvas must be closest to the expected source frame
  const W = 108;
  const H = 160; // testsrc2 part only: rows 0..400 of 480 → canvas 0..5/6
  for (const n of [7, 45, 200]) {
    await seek(page, fr(n));
    const got = await canvasRGB(page, W, H, { y0: 0, y1: CODE.picH / CODE.h });
    const errs: Record<number, number> = {};
    for (let m = n - 2; m <= n + 2; m++) {
      const ref = refFrame(AM.codeA, m, W, H, CODE.picH);
      errs[m] = mae(got, ref);
    }
    const best = Number(Object.entries(errs).sort((x, y) => x[1] - y[1])[0]![0]);
    log.push(`ffmpeg-ref n=${n} best=${best} mae=${JSON.stringify(Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, +v.toFixed(2)])))}`);
    if (best !== n) bad.push(`ffmpeg ref: frame ${n} looks like ${best}`);
    // colour conversion + scaler differences leave a floor of ~10; the neighbours must be clearly worse
    const others = Object.entries(errs).filter(([m]) => Number(m) !== n).map(([, v]) => v);
    expect(errs[n]!).toBeLessThan(Math.min(...others) * 0.92);
  }

  // ---- split at 4 s
  await page.evaluate(({ id, t }) => (window as any).__oe.getState().splitClip(id, t), { id: clipId, t: 4_000_000 });
  bad = bad.concat(await checkFrames(page, 'split', [fr(119), fr(120), fr(121), fr(200)], log));

  // ---- trim-left of the second piece by 1 s (main track ripples it back to 4 s)
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    const c = s.project.tracks[0].clips[1];
    s.trimStart(c.id, c.start + 1_000_000);
  });
  const piece = await page.evaluate(() => {
    const c = (window as any).__oe.getState().project.tracks[0].clips[1];
    return { start: c.start, inPoint: c.inPoint, duration: c.duration };
  });
  log.push(`after trim-left: ${JSON.stringify(piece)}`);
  expect(piece.inPoint).toBe(5_000_000);
  bad = bad.concat(await checkFrames(page, 'trim-left', [piece.start, piece.start + fr(1), piece.start + fr(37)], log));

  // ---- speed 2× and 0.5× on the first piece
  await page.evaluate((id) => (window as any).__oe.getState().setSpeed(id, 2), clipId);
  bad = bad.concat(await checkFrames(page, 'speed2', [0, fr(1), fr(7), fr(33), fr(59)], log));
  await page.evaluate((id) => (window as any).__oe.getState().setSpeed(id, 0.5), clipId);
  bad = bad.concat(await checkFrames(page, 'speed0.5', [fr(1), fr(2), fr(3), fr(101), fr(239)], log));
  await page.evaluate((id) => (window as any).__oe.getState().setSpeed(id, 10), clipId);
  bad = bad.concat(await checkFrames(page, 'speed10', [fr(1), fr(2), fr(3), fr(13)], log));
  // non-integer speed: 1.5×
  await page.evaluate((id) => (window as any).__oe.getState().setSpeed(id, 1.5), clipId);
  bad = bad.concat(await checkFrames(page, 'speed1.5', [fr(1), fr(2), fr(3), fr(41)], log));

  expect(bad, bad.join('\n')).toEqual([]);
});

/** Main track: A[0,4s) src 0..4 · B[4,8s) src 2..6 · A[8,12s) src 6..10 (two cuts, two assets). */
async function buildCutProject(page: Page, ids: Record<string, string>) {
  await page.evaluate(({ a, b }) => {
    const s = (window as any).__oe.getState();
    const id = s.addClip(a, { at: 0 });
    const p = structuredClone((window as any).__oe.getState().project);
    const main = p.tracks[0];
    const tpl = main.clips.find((c: any) => c.id === id);
    const mk = (n: number, assetId: string, start: number, inPoint: number) => ({
      ...structuredClone(tpl),
      id: `cut${n}`,
      assetId,
      name: assetId === a ? 'code-a.mp4' : 'code-b.mp4',
      start,
      inPoint,
      duration: 4_000_000,
    });
    main.clips = [mk(1, a, 0, 0), mk(2, b, 4_000_000, 2_000_000), mk(3, a, 8_000_000, 6_000_000)];
    s.setProject(p);
  }, { a: ids[AM.codeA]!, b: ids[AM.codeB]! });
}

interface Sample {
  t: number;
  ctx: number;
  got: number;
  gotId: string;
  want: number;
  wantId: string;
  luma: number;
  audioDrift: number | null;
}

/** Records one sample per rendered playback frame (the engine's renderAt is wrapped). */
async function recordPlayback(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate(
    async ({ ms, src }) => {
      const { activePreviewEngine } = await import('/src/player/PreviewEngine.ts' as any);
      const { getFrameState } = await import('/src/engine/frameState.ts' as any);
      const eng = activePreviewEngine();
      const decode = (0, eval)(src);
      const c = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
      const out: any[] = [];
      const orig = eng.renderAt.bind(eng);
      eng.renderAt = (t: number, playing: boolean) => {
        orig(t, playing);
        if (!playing) return;
        const s = (window as any).__oe.getState();
        const fs = getFrameState(s.project, t);
        const op = fs.ops.find((o: any) => o.kind === 'media');
        const d = decode(c, s.project.settings.width);
        let audioDrift: number | null = null;
        const aop = fs.audio[0];
        const v = aop ? eng.audio.voices.get(aop.clipId) : null;
        if (v && !v.el.paused && !v.el.seeking) audioDrift = v.el.currentTime - aop.sourceTime / 1e6;
        const ve = op ? eng.pool.videos.get(op.clipId) : null;
        out.push({
          elDrift: ve ? (ve.el.currentTime - op.sourceTime / 1e6) * 30 : null,
          t,
          ctx: eng.audio.ctx?.currentTime ?? -1,
          got: d.frame,
          gotId: d.id,
          want: op ? Math.floor((op.sourceTime * 30) / 1e6 + 0.01) : -1,
          wantId: op ? (s.project.assets[op.assetId].name.includes('code-a') ? 'A' : 'B') : '-',
          luma: d.luma,
          audioDrift,
        });
      };
      await new Promise((r) => setTimeout(r, ms));
      eng.renderAt = orig;
      return out;
    },
    { ms, src: DECODE_SRC },
  );
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50: q(0.5), p95: q(0.95), min: s[0] ?? NaN, max: s[s.length - 1] ?? NaN };
};

test('playback: A/V clock drift over 10 s, cuts without black or wrong frames', async ({ page }) => {
  test.setTimeout(120_000);
  const ids = await setupAudit(page, [AM.codeA, AM.codeB]);
  await buildCutProject(page, ids);
  await seek(page, 0);
  // warm-up: the first play creates the AudioContext; measure a clean second run
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(500);
  await page.getByTestId('play-button').click();
  await seek(page, 0);
  await page.getByTestId('play-button').click();
  const samples = await recordPlayback(page, 10_500);
  await page.getByTestId('play-button').click();

  const playing = samples.filter((s) => s.ctx >= 0);
  const driftFrames = playing.map((s) => s.got - s.want);
  const audio = playing.map((s) => s.audioDrift).filter((v): v is number => v !== null);
  const black = playing.filter((s) => s.luma < 8);
  const wrongClip = playing.filter((s) => s.gotId !== s.wantId);
  const span = (playing.at(-1)!.t - playing[0]!.t) / 1e6;
  const ctxSpan = playing.at(-1)!.ctx - playing[0]!.ctx;
  // around each cut (4 s, 8 s): frames within ±0.3 s
  const nearCut = playing.filter((s) => [4e6, 8e6].some((c) => Math.abs(s.t - c) < 300_000));
  const report = {
    renderedFrames: playing.length,
    timelineSpan: +span.toFixed(3),
    audioClockSpan: +ctxSpan.toFixed(3),
    videoDriftFrames: stats(driftFrames),
    elementCurrentTimeDriftFrames: stats(playing.map((s: any) => s.elDrift).filter((v: any) => v !== null)),
    audioDriftMs: stats(audio.map((v) => v * 1000)),
    blackFrames: black.length,
    wrongClipFrames: wrongClip.map((s) => `${(s.t / 1e6).toFixed(3)} want ${s.wantId}#${s.want} got ${s.gotId}#${s.got}`),
    nearCut: nearCut.map((s) => `${(s.t / 1e6).toFixed(3)}:${s.wantId}${s.want}/${s.gotId}${s.got}`).join(' '),
  };
  console.log('PLAYBACK', JSON.stringify(report, null, 1));
  expect(span).toBeGreaterThan(9.5);
  // the timeline clock IS the audio clock: 10 s of timeline = 10 s of AudioContext time
  expect(Math.abs(span - ctxSpan)).toBeLessThan(0.05);
  expect(black).toHaveLength(0);
  expect(report.wrongClipFrames).toEqual([]);
  // picture vs clock (was p50 −2 frames / element −1.44 frames before the rate nudge)
  expect(report.videoDriftFrames.p50).toBeGreaterThanOrEqual(-1);
  expect(Math.abs(report.elementCurrentTimeDriftFrames.p50)).toBeLessThan(0.75);
  expect(report.videoDriftFrames.max).toBeLessThanOrEqual(1); // never ahead of the clock
  expect(report.videoDriftFrames.min).toBeGreaterThanOrEqual(-4);
  // the first frame after each cut is the new clip's first frame (was 5 frames ahead: preload parking)
  for (const cut of [4e6, 8e6]) {
    const first = playing.find((s) => s.t >= cut)!;
    expect(first.got - first.want, `first frame after cut ${cut}`).toBeLessThanOrEqual(0);
    expect(first.got - first.want).toBeGreaterThanOrEqual(-1);
  }
  // sound vs clock
  expect(Math.abs(report.audioDriftMs.p50)).toBeLessThan(20);
});

test('pause / scrub while playing / end of timeline / play again from the end', async ({ page }) => {
  test.setTimeout(120_000);
  const ids = await setupAudit(page, [AM.codeA, AM.codeB]);
  await buildCutProject(page, ids);
  const log: string[] = [];
  const st = () => page.evaluate(() => {
    const s = (window as any).__oe.getState();
    return { playing: s.playing as boolean, playhead: s.playhead as number };
  });

  // ---- pause: the frame on screen after pausing is the frame of the stored playhead
  await seek(page, 1_000_000);
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(1500);
  const beforePause = await shownFrame(page);
  await page.getByTestId('play-button').click();
  await settle(page);
  const p1 = await st();
  const shown = await shownFrame(page);
  const want = await expectedFrame(page, p1.playhead);
  log.push(`pause: playhead ${p1.playhead} want ${want!.frame} shown ${shown.frame} (last playing frame ${beforePause.frame})`);
  expect(p1.playing).toBe(false);
  expect(shown.frame).toBe(want!.frame);
  // no jump backwards on pause (the store playhead lagged the clock by up to 33 ms)
  expect(shown.frame).toBeGreaterThanOrEqual(beforePause.frame);
  expect(shown.frame - beforePause.frame).toBeLessThanOrEqual(2);

  // ---- scrub while playing: the clock re-anchors and the picture follows
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__oe.getState().setPlayhead(6_000_000));
  await page.waitForTimeout(700);
  const sc = await st();
  const scShown = await shownFrame(page);
  log.push(`scrub to 6 s while playing → playhead ${sc.playhead} shown ${scShown.id}#${scShown.frame}`);
  expect(sc.playing).toBe(true);
  expect(sc.playhead).toBeGreaterThan(6_400_000);
  expect(sc.playhead).toBeLessThan(7_200_000);
  expect(scShown.id).toBe('B');
  // B at 6.6 s ≈ src 4.6 s ≈ frame 138 (±6 frames of playback progress / latency)
  expect(Math.abs(scShown.frame - Math.round(((sc.playhead - 4e6 + 2e6) * 30) / 1e6))).toBeLessThanOrEqual(6);
  await page.getByTestId('play-button').click();

  // ---- end of timeline: playback stops at the end, the last frame stays on screen
  await seek(page, 11_000_000);
  await page.getByTestId('play-button').click();
  await expect.poll(async () => (await st()).playing, { timeout: 4000 }).toBe(false);
  await settle(page);
  const end = await st();
  const endShown = await shownFrame(page);
  log.push(`end: playhead ${end.playhead} shown ${endShown.id}#${endShown.frame} luma ${endShown.luma.toFixed(1)}`);
  expect(end.playhead).toBe(12_000_000);
  expect(endShown.id).toBe('A');
  expect(endShown.frame).toBe(299); // A src 6 s + 4 s − 1 frame
  await expect(page.getByTestId('timecode')).toContainText('00:00:12:00 / 00:00:12:00');

  // ---- Play at the end starts again from 0 (v1 has no loop toggle)
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(300);
  const again = await st();
  log.push(`play at end → playing ${again.playing} playhead ${again.playhead}`);
  expect(again.playing).toBe(true);
  expect(again.playhead).toBeLessThan(600_000);
  await page.getByTestId('play-button').click();
  console.log(log.join('\n'));
});

// ================================================================ pixels: transform, layers, colour

const add = (page: Page, assetId: string, opts: Record<string, unknown> = {}) =>
  page.evaluate(({ assetId, opts }) => (window as any).__oe.getState().addClip(assetId, opts), { assetId, opts }) as Promise<string>;
const upd = (page: Page, id: string, patch: Record<string, unknown>) =>
  page.evaluate(({ id, patch }) => (window as any).__oe.getState().updateClip(id, patch), { id, patch });
const results: string[] = [];
/** Pixel assertion with a tolerance; logs `label: want → got` for the audit report. */
async function expectPx(page: Page, label: string, x: number, y: number, want: readonly number[], tol = 3) {
  const got = await pixel(page, x, y);
  const ok = near(got, want, tol);
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}: want [${want.map((v) => Math.round(v))}] got [${got}]`);
  expect(ok, `${label}: want ${JSON.stringify(want.map((v) => Math.round(v)))} got ${JSON.stringify(got)}`).toBe(true);
}
test.afterAll(() => {
  if (results.length) console.log(results.join('\n'));
});

const A = COLORS.a;
const B = COLORS.b;
const mix = (x: readonly number[], y: readonly number[], p: number) => x.map((v, i) => v * (1 - p) + y[i]! * p);
const scaleC = (x: readonly number[], k: number) => x.map((v) => v * k);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

test('layering: overlay above main, text on top, hidden tracks and disabled clips not drawn', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA, AM.imgB]);
  await add(page, ids[AM.imgA]!, { at: 0 });
  const ov = await add(page, ids[AM.imgB]!, { at: 0, kind: 'overlay' });
  await upd(page, ov, { transform: { scale: 0.5 } }); // B box: x 270..810, y 480..1440
  const tx = await page.evaluate(() => (window as any).__oe.getState().addTextClip({ at: 0, content: 'MMMM' }));
  await upd(page, tx, { text: { fontSize: 120, color: '#00ff00', background: { enabled: true, color: '#ff00ff', opacity: 1 } } });
  await seek(page, 1_000_000);
  // text block: 1 line × 120 × 1.2 + 2 × 36 padding = 216 → y 852..1068
  await expectPx(page, 'layer main corner', 60, 60, A);
  await expectPx(page, 'layer overlay above main', 540, 600, B);
  await expectPx(page, 'layer text bg on top of overlay', 540, 860, [255, 0, 255]);
  const green = await colorStats(page, [0, 255, 0], 40, { x0: 200, y0: 852, x1: 880, y1: 1068 });
  results.push(`text glyph pixels (green) in the text box: ${green.count}`);
  expect(green.count).toBeGreaterThan(200);

  const trackOf = (clipId: string) => page.evaluate((id) => (window as any).__oe.getState().project.tracks.find((t: any) => t.clips.some((c: any) => c.id === id)).id, clipId);
  const setTrack = (trackId: string, patch: object) => page.evaluate(({ trackId, patch }) => (window as any).__oe.getState().setTrack(trackId, patch), { trackId, patch });
  await setTrack(await trackOf(tx), { hidden: true });
  await settle(page);
  await expectPx(page, 'hidden text track → overlay shows', 540, 860, B);
  await setTrack(await trackOf(ov), { hidden: true });
  await settle(page);
  await expectPx(page, 'hidden overlay track → main shows', 540, 600, A);
  await setTrack(await trackOf(ov), { hidden: false });
  await upd(page, ov, { disabled: true });
  await settle(page);
  await expectPx(page, 'disabled overlay clip → main shows', 540, 600, A);
});

test('transform: scale, position, rotation, opacity, mirror (white square on black)', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgWhite, AM.imgQuad]);
  const c = await add(page, ids[AM.imgWhite]!, { at: 0 });
  await seek(page, 500_000);
  const W = [255, 255, 255];
  const K = [0, 0, 0];
  // scale 1: 1080×1080 box, y 420..1500
  await expectPx(page, 'scale 1 inside top edge', 540, 430, W);
  await expectPx(page, 'scale 1 above top edge', 540, 410, K);
  await upd(page, c, { transform: { scale: 0.5 } }); // 540 box: x 270..810, y 690..1230
  await settle(page);
  let st = await colorStats(page, W, 10);
  results.push(`scale 0.5 white bbox: x ${st.minX.toFixed(1)}..${st.maxX.toFixed(1)} y ${st.minY.toFixed(1)}..${st.maxY.toFixed(1)}`);
  for (const [got, want] of [[st.minX, 270], [st.maxX, 810], [st.minY, 690], [st.maxY, 1230]] as const) expect(Math.abs(got - want)).toBeLessThanOrEqual(6);
  await upd(page, c, { transform: { x: 200, y: -300 } }); // x 470..1010, y 390..930
  await settle(page);
  st = await colorStats(page, W, 10);
  results.push(`position (+200, −300) bbox: x ${st.minX.toFixed(1)}..${st.maxX.toFixed(1)} y ${st.minY.toFixed(1)}..${st.maxY.toFixed(1)}`);
  for (const [got, want] of [[st.minX, 470], [st.maxX, 1010], [st.minY, 390], [st.maxY, 930]] as const) expect(Math.abs(got - want)).toBeLessThanOrEqual(6);
  await upd(page, c, { transform: { x: 0, y: 0, rotation: 45 } }); // diamond |dx|+|dy| ≤ 381.8
  await settle(page);
  await expectPx(page, 'rotate 45 tip inside (0,−370)', 540, 960 - 370, W);
  await expectPx(page, 'rotate 45 old corner now outside (−250,−250)', 540 - 250, 960 - 250, K);
  // width of the diamond across its middle row = the diagonal 540√2 = 763.7
  // (the preview canvas is ~0.27× project resolution: one canvas px ≈ 3.7 project px, and the tips are anti-aliased)
  st = await colorStats(page, W, 10, { x0: 0, y0: 958, x1: 1080, y1: 962 });
  results.push(`rotate 45 middle-row width ${(st.maxX - st.minX).toFixed(1)} (want 763.7)`);
  expect(Math.abs(st.maxX - st.minX - 540 * Math.SQRT2)).toBeLessThanOrEqual(16);
  await upd(page, c, { transform: { rotation: 0, opacity: 0.5 } });
  await settle(page);
  await expectPx(page, 'opacity 50% white over black', 540, 960, [127.5, 127.5, 127.5], 2);
  await upd(page, c, { blendEnabled: false });
  await settle(page);
  await expectPx(page, 'Blend checkbox off → 100% opacity', 540, 960, W);

  // mirror with the quadrant image (TL red, TR green, BL blue, BR white)
  await page.evaluate((id) => (window as any).__oe.getState().deleteClips([id]), c);
  const q = await add(page, ids[AM.imgQuad]!, { at: 0 });
  await seek(page, 500_000);
  await expectPx(page, 'quad TL red', 200, 300, [255, 0, 0]);
  await upd(page, q, { transform: { flipH: true } });
  await settle(page);
  await expectPx(page, 'mirror H: TL shows green', 200, 300, [0, 255, 0]);
  await upd(page, q, { transform: { flipH: false, flipV: true } });
  await settle(page);
  await expectPx(page, 'mirror V: TL shows blue', 200, 300, [0, 0, 255]);
  await upd(page, q, { transform: { flipV: false, rotation: 90 } });
  await settle(page);
  // rotate 90° CW: the source TL quadrant moves to the top-right of the box (box is 1080×1920 → 1920×1080 rotated, clipped)
  await expectPx(page, 'rotate 90 CW: right of centre, above → red (old TL)', 700, 900, [255, 0, 0]);
});

/** W3C compositing formulas, channel values 0..255 (Cb = backdrop, Cs = source). */
const BLEND: Record<string, (cb: number, cs: number) => number> = {
  multiply: (b, s) => (b * s) / 255,
  screen: (b, s) => 255 - ((255 - b) * (255 - s)) / 255,
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  overlay: (b, s) => (b <= 127.5 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255),
  'hard-light': (b, s) => (s <= 127.5 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255),
  'color-dodge': (b, s) => (b === 0 ? 0 : s === 255 ? 255 : Math.min(255, (b / (255 - s)) * 255)),
  'color-burn': (b, s) => (b === 255 ? 255 : s === 0 ? 0 : 255 - Math.min(255, ((255 - b) / s) * 255)),
  'soft-light': (b0, s0) => {
    const b = b0 / 255;
    const s = s0 / 255;
    const D = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return 255 * (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (D - b));
  },
};

test('blend modes match the W3C formulas on known colours (A under B)', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA, AM.imgB]);
  await add(page, ids[AM.imgA]!, { at: 0 });
  const ov = await add(page, ids[AM.imgB]!, { at: 0, kind: 'overlay' });
  await seek(page, 500_000);
  for (const [mode, f] of Object.entries(BLEND)) {
    await upd(page, ov, { blend: mode });
    await settle(page);
    await expectPx(page, `blend ${mode}`, 540, 960, A.map((b, i) => f(b, B[i]!)), 3);
  }
  await upd(page, ov, { blend: 'multiply', transform: { opacity: 0.5 } });
  await settle(page);
  await expectPx(page, 'blend multiply at 50% opacity', 540, 960, mix(A, A.map((b, i) => BLEND.multiply!(b, B[i]!)), 0.5), 3);
  await upd(page, ov, { blendEnabled: false });
  await settle(page);
  await expectPx(page, 'Blend section off → normal 100%', 540, 960, B, 2);
});

test('filters and adjust change pixels by the documented amount', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA]);
  const c = await add(page, ids[AM.imgA]!, { at: 0 });
  await seek(page, 500_000);
  const neutral = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, fade: 0, vignette: 0, sharpen: 0 };
  const lum = 0.2126 * A[0] + 0.7152 * A[1] + 0.0722 * A[2];
  // Since the Adjust tab (tab-adjust) every adjustment runs through the shared colour pipeline
  // (WebGL2 in the player, the same maths on the CPU in engine/color/math.ts). The documented
  // amount is that pipeline's output for the clip's colour ops; the direction of each control is
  // checked against the source colour as well.
  const pipeline = (clipId: string): Promise<number[]> =>
    page.evaluate(
      ({ clipId, A }) => {
        const { color, frame } = (window as any).__oeColorLab;
        const clip = (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === clipId);
        const params = color.gradeParams(frame.colorOps(clip), 0);
        if (!params) return [...A];
        return color.gradePixel(A.map((v: number) => v / 255), params, { u: 0.5, v: 0.5, aspect: 9 / 16 }).map((v: number) => v * 255);
      },
      { clipId, A: [...A] },
    );
  await page.waitForFunction(() => !!(window as any).__oeColorLab);
  const sum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!;
  const spread = (c: readonly number[]) => Math.max(...c) - Math.min(...c);
  const cases: [string, Record<string, unknown>, (want: number[]) => boolean, number][] = [
    ['brightness +50 brightens', { adjust: { ...neutral, brightness: 50 } }, (w) => sum(w) > sum(A) + 30, 3],
    ['brightness −50 darkens', { adjust: { ...neutral, brightness: -50 } }, (w) => sum(w) < sum(A) - 30, 3],
    ['exposure +50 brightens', { adjust: { ...neutral, exposure: 50 } }, (w) => sum(w) > sum(A) + 30, 3],
    ['contrast +50 spreads the channels', { adjust: { ...neutral, contrast: 50 } }, (w) => spread(w) > spread(A), 3],
    ['saturation −50 desaturates', { adjust: { ...neutral, saturation: -50 } }, (w) => spread(w) < spread(A) * 0.8, 4],
    ['temperature +50 warms (R up vs B)', { adjust: { ...neutral, temperature: 50 } }, (w) => w[0]! - w[2]! > A[0] - A[2], 3],
    ['tint −50 → green', { adjust: { ...neutral, tint: -50 } }, (w) => w[1]! - (w[0]! + w[2]!) / 2 > A[1] - (A[0] + A[2]) / 2, 3],
    ['fade 100 lifts toward grey', { adjust: { ...neutral, fade: 100 } }, (w) => spread(w) < spread(A), 3],
    ['Adjust checkbox off ignores brightness +50', { adjust: { ...neutral, brightness: 50 }, adjustEnabled: false }, (w) => w.every((v, i) => Math.abs(v - A[i]!) < 1), 2],
    ['filter B&W 100% is grey', { adjust: neutral, adjustEnabled: true, filter: { id: 'mono', intensity: 1 } }, (w) => spread(w) < 2 && Math.abs(w[0]! - lum) < 12, 4],
    ['filter B&W 50%', { filter: { id: 'mono', intensity: 0.5 } }, (w) => spread(w) < spread(A) * 0.7 && spread(w) > 2, 4],
  ];
  for (const [label, patch, direction, tol] of cases) {
    await upd(page, c, { filter: null, ...patch });
    await settle(page);
    const want = await pipeline(c);
    expect(direction(want), `${label}: the pipeline moves the colour the documented way (A=[${A}] → [${want.map(Math.round)}])`).toBe(true);
    await expectPx(page, label, 540, 960, want, tol);
  }
  // vignette: centre untouched, corners darkened by up to 85 %
  await upd(page, c, { filter: null, adjust: { ...neutral, vignette: 100 } });
  await settle(page);
  await expectPx(page, 'vignette 100 centre', 540, 960, A, 3);
  const corner = await pixel(page, 8, 8);
  results.push(`vignette 100 corner: [${corner}] (A = [${A}])`);
  expect(corner[0]).toBeLessThan(A[0] * 0.4);
  // highlights / shadows / sharpen are documented v1 approximations: they must move pixels the right way
  // (sharpen is a real unsharp mask in the colour pass now: a flat colour has no edges, so it must
  // leave it unchanged — dir 0)
  for (const [key, dir] of [['highlights', 1], ['shadows', 1], ['sharpen', 0]] as const) {
    await upd(page, c, { adjust: { ...neutral, [key]: key === 'sharpen' ? 100 : 50 } });
    await settle(page);
    const got = await pixel(page, 540, 960);
    const changed = got.some((v, i) => Math.abs(v - A[i]!) >= 2);
    results.push(`${key} +: [${got}] changed=${changed}`);
    expect(changed, `${key} changes the picture`).toBe(dir === 1);
  }
});

test('text style: colour, stroke, background + opacity, alignment', async ({ page }) => {
  await setupAudit(page, [AM.imgA]);
  const tx = await page.evaluate(() => (window as any).__oe.getState().addTextClip({ at: 0, content: 'MMMMMMMM\nI' }));
  await upd(page, tx, { text: { fontSize: 100, color: '#ff0000' } });
  await seek(page, 500_000);
  const red = await colorStats(page, [255, 0, 0], 30);
  results.push(`text colour red: ${red.count} px, bbox x ${red.minX.toFixed(0)}..${red.maxX.toFixed(0)} y ${red.minY.toFixed(0)}..${red.maxY.toFixed(0)}`);
  expect(red.count).toBeGreaterThan(500);
  // centred on the canvas centre
  expect(Math.abs((red.minX + red.maxX) / 2 - 540)).toBeLessThan(25);
  expect(Math.abs((red.minY + red.maxY) / 2 - 960)).toBeLessThan(40);
  await upd(page, tx, { text: { color: '#0000ff' } });
  await settle(page);
  expect((await colorStats(page, [255, 0, 0], 30)).count).toBe(0);
  expect((await colorStats(page, [0, 0, 255], 30)).count).toBeGreaterThan(500);

  // stroke: yellow ring around the glyphs, glyph fill stays blue
  await upd(page, tx, { text: { stroke: { enabled: true, color: '#ffff00', width: 8 } } });
  await settle(page);
  const yel = await colorStats(page, [255, 255, 0], 40);
  const blue = await colorStats(page, [0, 0, 255], 30);
  results.push(`stroke 8 yellow: ${yel.count} px; fill blue still ${blue.count} px; stroke bbox extends ${(blue.minX - yel.minX).toFixed(1)} px left of fill`);
  expect(yel.count).toBeGreaterThan(300);
  expect(blue.count).toBeGreaterThan(300);
  expect(blue.minX - yel.minX).toBeGreaterThan(4);
  expect(blue.minX - yel.minX).toBeLessThan(14);
  await upd(page, tx, { text: { stroke: { enabled: false } } });

  // background: block = content + 0.3 × fontSize padding; colour × opacity over black
  await upd(page, tx, { text: { background: { enabled: true, color: '#00ff00', opacity: 1 } } });
  await settle(page);
  const bg = await colorStats(page, [0, 255, 0], 10);
  results.push(`background green 100%: bbox x ${bg.minX.toFixed(0)}..${bg.maxX.toFixed(0)} y ${bg.minY.toFixed(0)}..${bg.maxY.toFixed(0)} (height want 2×120+60=300)`);
  expect(Math.abs(bg.maxY - bg.minY - 300)).toBeLessThan(6);
  await upd(page, tx, { text: { background: { opacity: 0.5 } } });
  await settle(page);
  await expectPx(page, 'text background 50% over black', bg.minX + 10, bg.minY + 10, [0, 127.5, 0], 3);
  await upd(page, tx, { text: { background: { enabled: false } } });

  // alignment: the short second line sits at the left / centre / right of the block
  const lineTwo = async () => colorStats(page, [0, 0, 255], 30, { x0: 0, y0: 975, x1: 1080, y1: 1070 });
  const block = await colorStats(page, [0, 0, 255], 30, { x0: 0, y0: 850, x1: 1080, y1: 960 });
  const xs: Record<string, number> = {};
  for (const align of ['left', 'center', 'right']) {
    await upd(page, tx, { text: { align } });
    await settle(page);
    const l = await lineTwo();
    xs[align] = (l.minX + l.maxX) / 2;
  }
  results.push(`align: line-2 centre x left ${xs.left!.toFixed(0)} centre ${xs.center!.toFixed(0)} right ${xs.right!.toFixed(0)} (line 1 spans ${block.minX.toFixed(0)}..${block.maxX.toFixed(0)})`);
  expect(Math.abs(xs.center! - 540)).toBeLessThan(10);
  expect(xs.left! - block.minX).toBeLessThan(40);
  expect(block.maxX - xs.right!).toBeLessThan(40);
});

test('animation in / out at known progress', async ({ page }) => {
  // Since tab-animation the catalogue (src/engine/animations.ts) defines each animation's curve;
  // the documented amount is what the frame state says (opacity, offset, scale) at that time, and
  // the drawn pixels must match it.
  const ids = await setupAudit(page, [AM.imgA]);
  const c = await add(page, ids[AM.imgA]!, { at: 0 }); // 5 s
  const anim = (phase: 'in' | 'out', type: string | null) =>
    page.evaluate(({ c, phase, type }) => (window as any).__oe.getState().setAnimation(c, phase, type, 1_000_000), { c, phase, type });
  /** Expected colour at (x, y) at time t from the frame state; null within 4 px of the clip edge. */
  const wantAt = (t: number, x: number, y: number) =>
    page.evaluate(
      async ({ t, x, y, A }) => {
        const { getFrameState } = await import('/src/engine/frameState.ts' as any);
        const s = (window as any).__oe.getState();
        const W = s.project.settings.width;
        const H = s.project.settings.height;
        const op = getFrameState(s.project, t).ops.find((o: any) => o.kind === 'media');
        if (!op) return { want: [0, 0, 0], tf: null };
        const tf = op.transform;
        const sx = (tf.scaleX ?? tf.scale) * (op.fx?.sx ?? 1);
        const sy = (tf.scaleY ?? tf.scale) * (op.fx?.sy ?? 1);
        const cx = W / 2 + tf.x;
        const cy = H / 2 + tf.y;
        const dx = Math.abs(x - cx) - (op.fitWidth * sx) / 2;
        const dy = Math.abs(y - cy) - (op.fitHeight * sy) / 2;
        if (Math.abs(dx) < 4 || Math.abs(dy) < 4) return { want: null, tf };
        const inside = dx < 0 && dy < 0;
        return { want: inside ? A.map((v: number) => v * tf.opacity) : [0, 0, 0], tf: { ...tf, fx: op.fx } };
      },
      { t, x, y, A: [...A] },
    );
  const check = async (label: string, t: number, pts: [number, number][], expectChange: (tf: any) => boolean) => {
    await seek(page, t);
    await settle(page);
    for (const [x, y] of pts) {
      const { want, tf } = await wantAt(t, x, y);
      expect(tf && expectChange(tf), `${label}: the animation is active at t=${t} (${JSON.stringify(tf)})`).toBe(true);
      if (want) await expectPx(page, `${label} (${x},${y})`, x, y, want, 3);
    }
  };
  await anim('in', 'fade');
  await check('fade in p=0.5', 500_000, [[540, 960]], (tf) => tf.opacity > 0.05 && tf.opacity < 0.95);
  await check('fade in p=0.25', 250_000, [[540, 960]], (tf) => tf.opacity > 0.05 && tf.opacity < 0.95);
  await anim('in', 'slide-left');
  await check('slide-left in p=0.5', 500_000, [[125, 960], [145, 960], [540, 960], [1000, 960]], (tf) => Math.abs(tf.x) > 10);
  await anim('in', 'zoom-in');
  await check('zoom-in p=0.5', 500_000, [[25, 960], [45, 960], [540, 960]], (tf) => Math.abs((tf.scaleX ?? tf.scale) * (tf.fx?.sx ?? 1) - 1) > 0.01);
  await anim('in', null);
  await anim('out', 'fade');
  await check('fade out p=0.5', 4_500_000, [[540, 960]], (tf) => tf.opacity > 0.05 && tf.opacity < 0.95);
  await check('fade out p=0.75', 4_750_000, [[540, 960]], (tf) => tf.opacity > 0.01 && tf.opacity < 0.95);
  await anim('out', 'slide-down');
  await check('slide-down out p=0.5', 4_500_000, [[540, 950], [540, 975], [540, 1800], [540, 200]], (tf) => Math.abs(tf.y) > 10);
});

test('transitions at 25 / 50 / 75 %', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA, AM.imgB]);
  const a = await add(page, ids[AM.imgA]!, { at: 0 });
  await add(page, ids[AM.imgB]!, { at: 5_000_000 });
  const tr = await page.evaluate((a) => (window as any).__oe.getState().addTransition(a, 'mix', 1_000_000), a);
  const setType = (type: string) => page.evaluate(({ tr, type }) => (window as any).__oe.getState().updateTransition(tr, { type }), { tr, type });
  const at = (p: number) => 4_500_000 + Math.round(p * 1_000_000);
  for (const p of [0.25, 0.5, 0.75]) {
    await seek(page, at(p));
    await expectPx(page, `mix p=${p}`, 540, 960, mix(A, B, p), 3);
  }
  await setType('fade-black');
  for (const [p, want] of [[0.25, scaleC(A, 0.5)], [0.5, [0, 0, 0]], [0.75, scaleC(B, 0.5)]] as const) {
    await seek(page, at(p));
    await expectPx(page, `black fade p=${p}`, 540, 960, want, 3);
  }
  await setType('fade-white');
  await seek(page, at(0.5));
  await expectPx(page, 'white flash p=0.5', 540, 960, [255, 255, 255], 3);
  await setType('wipe-right');
  for (const p of [0.25, 0.5, 0.75]) {
    await seek(page, at(p));
    const edge = easeInOutCubic(p) * 1080;
    await expectPx(page, `wipe-right p=${p} left of ${edge.toFixed(1)}`, edge - 12, 960, B, 3);
    await expectPx(page, `wipe-right p=${p} right of edge`, edge + 12, 960, A, 3);
  }
  await setType('slide-left');
  await seek(page, at(0.5));
  await expectPx(page, 'slide-left p=0.5 left half = from', 520, 960, A, 3);
  await expectPx(page, 'slide-left p=0.5 right half = to', 560, 960, B, 3);
  await setType('slide-up');
  await seek(page, at(0.25)); // from dy = −120, to dy = 1800
  await expectPx(page, 'slide-up p=0.25 from', 540, 1785, A, 3);
  await expectPx(page, 'slide-up p=0.25 to', 540, 1815, B, 3);
  await setType('blur');
  await seek(page, at(0.5));
  await expectPx(page, 'blur p=0.5 centre = 50/50 mix', 540, 960, mix(A, B, 0.5), 4);
  await setType('zoom');
  await seek(page, at(0.75)); // to: alpha e = 0.9375 on top of the scaled-up from
  await expectPx(page, 'zoom p=0.75 centre', 540, 960, mix(A, B, easeInOutCubic(0.75)), 4);
  // outside the window: only one clip
  await seek(page, at(-0.1));
  await expectPx(page, 'before the window', 540, 960, A, 2);
  await seek(page, at(1.05));
  await expectPx(page, 'after the window', 540, 960, B, 2);
});

test('ratios 9:16 16:9 1:1 4:5 3:4 letterbox / pillarbox the media', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA, AM.imgLand]);
  const c = await add(page, ids[AM.imgA]!, { at: 0 });
  await seek(page, 500_000);
  for (const [aspect, W, H] of [['9:16', 1080, 1920], ['16:9', 1920, 1080], ['1:1', 1080, 1080], ['4:5', 1080, 1350], ['3:4', 1080, 1440]] as const) {
    await page.evaluate((a) => (window as any).__oe.getState().setAspectRatio(a), aspect);
    await settle(page);
    const info = await canvasInfo(page);
    expect(info.W).toBe(W);
    expect(info.H).toBe(H);
    expect(Math.abs(info.cw / info.ch - W / H)).toBeLessThan(0.01);
    // 9:16 media contain-fit: height H, width H × 9/16, centred
    const w = Math.min(W, (H * 9) / 16);
    const x0 = (W - w) / 2;
    const st = await colorStats(page, A, 4);
    results.push(`ratio ${aspect}: canvas ${info.cw}×${info.ch}; media x ${st.minX.toFixed(1)}..${st.maxX.toFixed(1)} (want ${x0.toFixed(1)}..${(x0 + w).toFixed(1)}), y ${st.minY.toFixed(1)}..${st.maxY.toFixed(1)}`);
    expect(Math.abs(st.minX - x0)).toBeLessThanOrEqual(5);
    expect(Math.abs(st.maxX - (x0 + w))).toBeLessThanOrEqual(5);
    expect(st.minY).toBeLessThanOrEqual(4);
    expect(st.maxY).toBeGreaterThanOrEqual(H - 4);
    if (x0 > 10) await expectPx(page, `ratio ${aspect} pillar bar black`, x0 / 2, H / 2, [0, 0, 0], 1);
  }
  // landscape media in 9:16: letterbox top / bottom, height 607.5 centred
  await page.evaluate((a) => (window as any).__oe.getState().setAspectRatio(a), '9:16');
  await page.evaluate((id) => (window as any).__oe.getState().deleteClips([id]), c);
  await add(page, ids[AM.imgLand]!, { at: 0 });
  await seek(page, 500_000);
  const st = await colorStats(page, COLORS.land, 4);
  results.push(`landscape in 9:16: y ${st.minY.toFixed(1)}..${st.maxY.toFixed(1)} (want 656.3..1263.8)`);
  expect(Math.abs(st.minY - 656.25)).toBeLessThanOrEqual(5);
  expect(Math.abs(st.maxY - 1263.75)).toBeLessThanOrEqual(5);
  await expectPx(page, 'letterbox bar black', 540, 300, [0, 0, 0], 1);
});

test('audio-only regions are black; clips without audio play silently', async ({ page }) => {
  const ids = await setupAudit(page, [AM.tone, AM.codeSilent]);
  await add(page, ids[AM.tone]!, { at: 0 }); // 4 s on an audio track; main empty
  await seek(page, 1_000_000);
  let st = await colorStats(page, [0, 0, 0], 1);
  results.push(`audio-only frame: ${(st.frac * 100).toFixed(1)} % black`);
  expect(st.frac).toBe(1);
  const s0 = await page.evaluate(async () => {
    const { getFrameState } = await import('/src/engine/frameState.ts' as any);
    const fs = getFrameState((window as any).__oe.getState().project, 1_000_000);
    return { ops: fs.ops.length, audio: fs.audio.length };
  });
  expect(s0).toEqual({ ops: 0, audio: 1 });
  // main video shorter than the audio: after it ends the picture is black, sound continues
  await add(page, ids[AM.codeSilent]!, { at: 0 }); // 3 s, no audio stream
  await seek(page, 3_500_000);
  st = await colorStats(page, [0, 0, 0], 1);
  expect(st.frac).toBe(1);
  const s1 = await page.evaluate(async () => {
    const { getFrameState } = await import('/src/engine/frameState.ts' as any);
    const fs = getFrameState((window as any).__oe.getState().project, 1_000_000);
    return { ops: fs.ops.length, audio: fs.audio.map((a: any) => a.assetId) };
  });
  results.push(`silent clip + tone at 1 s: ${s1.ops} draw op, ${s1.audio.length} audio op (tone only)`);
  expect(s1.audio).toEqual([ids[AM.tone]]);
  // play over the silent clip: frames advance, no voice for the silent clip
  await seek(page, 0);
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(1200);
  const f = await shownFrame(page);
  const voices = await page.evaluate(async () => {
    const { activePreviewEngine } = await import('/src/player/PreviewEngine.ts' as any);
    return [...activePreviewEngine().audio.voices.keys()];
  });
  await page.getByTestId('play-button').click();
  results.push(`silent clip playing: shown ${f.id}#${f.frame}; voices ${voices.length}`);
  expect(f.id).toBe('S');
  expect(f.frame).toBeGreaterThan(20);
  expect(voices).toHaveLength(1); // the tone only
});

test('on-canvas selection box: drag-to-move and corner-scale write the right transform', async ({ page }) => {
  const ids = await setupAudit(page, [AM.imgA, AM.imgWhite]);
  await add(page, ids[AM.imgA]!, { at: 0 });
  const ov = await add(page, ids[AM.imgWhite]!, { at: 0, kind: 'overlay' });
  await upd(page, ov, { transform: { scale: 0.5 } });
  await seek(page, 500_000);
  const canvas = (await page.getByTestId('player-canvas').boundingBox())!;
  const k = canvas.width / 1080; // css px per project px
  const sx = (x: number) => canvas.x + x * k;
  const sy = (y: number) => canvas.y + y * k;

  // click selects the topmost clip; the box matches the drawn pixels
  await page.mouse.click(sx(540), sy(960));
  const sel = page.getByTestId('player-selection');
  await expect(sel).toBeVisible();
  const box = (await sel.boundingBox())!;
  const white = await colorStats(page, [255, 255, 255], 10);
  results.push(`selection box css ${box.width.toFixed(1)}×${box.height.toFixed(1)} vs drawn ${((white.maxX - white.minX) * k).toFixed(1)}×${((white.maxY - white.minY) * k).toFixed(1)}`);
  expect(Math.abs(box.width - 540 * k)).toBeLessThan(2);
  expect(Math.abs(box.x - sx(270))).toBeLessThan(2);

  // drag the body by (+90, +60) css px → transform += (90, 60) / k project px
  await page.mouse.move(sx(540), sy(960));
  await page.mouse.down();
  await page.mouse.move(sx(540) + 45, sy(960) + 30, { steps: 4 });
  await page.mouse.move(sx(540) + 90, sy(960) + 60, { steps: 4 });
  await page.mouse.up();
  const t1 = await page.evaluate((id) => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id).transform, ov);
  results.push(`drag (+90,+60) css → x ${t1.x} y ${t1.y} (want ${(90 / k).toFixed(1)}, ${(60 / k).toFixed(1)})`);
  expect(Math.abs(t1.x - 90 / k)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(t1.y - 60 / k)).toBeLessThanOrEqual(1.5);
  await settle(page);
  const moved = await colorStats(page, [255, 255, 255], 10);
  expect(Math.abs(moved.minX - (270 + t1.x))).toBeLessThanOrEqual(5);

  // corner-scale: drag the SE handle outwards; scale = 0.5 × |p1 − c| / |p0 − c|
  const se = (await page.locator('.player__handle--se').boundingBox())!;
  const p0 = { x: se.x + se.width / 2, y: se.y + se.height / 2 };
  const c = { x: sx(540 + t1.x), y: sy(960 + t1.y) };
  const p1 = { x: p0.x + 40, y: p0.y + 25 };
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p1.x, p1.y, { steps: 6 });
  await page.mouse.up();
  const want = 0.5 * (Math.hypot(p1.x - c.x, p1.y - c.y) / Math.hypot(p0.x - c.x, p0.y - c.y));
  const t2 = await page.evaluate((id) => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id).transform, ov);
  results.push(`corner-scale → scale ${t2.scale} (want ${want.toFixed(3)}); position unchanged ${t2.x},${t2.y}`);
  expect(Math.abs(t2.scale - want)).toBeLessThan(0.01);
  expect(t2.x).toBe(t1.x);
  expect(t2.y).toBe(t1.y);
  await settle(page);
  const scaled = await colorStats(page, [255, 255, 255], 10);
  const half = (1080 * t2.scale) / 2;
  const visible = Math.min(1080, 540 + t2.x + half) - Math.max(0, 540 + t2.x - half); // clipped by the canvas edge
  expect(Math.abs(scaled.maxX - scaled.minX - visible)).toBeLessThanOrEqual(6);
  expect(Math.abs(scaled.maxY - scaled.minY - 2 * half)).toBeLessThanOrEqual(6);
  // the gesture is one undo step each
  await page.evaluate(() => (window as any).__oe.getState().undo());
  const t3 = await page.evaluate((id) => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id).transform, ov);
  expect(t3.scale).toBe(0.5);
});

test('export picks the same source frames as the preview (speed 10×, every frame decoded)', async ({ page }) => {
  test.setTimeout(180_000);
  const ids = await setupAudit(page, [AM.codeA]);
  const c = await add(page, ids[AM.codeA]!, { at: 0 });
  await page.evaluate((id) => (window as any).__oe.getState().setSpeed(id, 10), c); // 12 s → 1.2 s, 36 frames
  // preview, a few frames
  const preview: number[] = [];
  for (const n of [1, 2, 3, 17, 35]) {
    await seek(page, fr(n));
    preview.push((await shownFrame(page)).frame);
  }
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-resolution').selectOption('720p');
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click(), 150_000);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${CODE.w}:${CODE.h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 });
  const size = CODE.w * CODE.h * 3;
  const frames: number[] = [];
  for (let off = 0; off + size <= raw.length; off += size) {
    let n = 0;
    for (let b = 0; b < CODE.bits; b++) {
      const x = Math.round(b * CODE.cell + CODE.cell / 2);
      const i = off + (CODE.bitsY * CODE.w + x) * 3;
      if ((raw[i]! + raw[i + 1]! + raw[i + 2]!) / 3 > 128) n |= 1 << b;
    }
    frames.push(n);
  }
  const want = frames.map((_, k) => 10 * k);
  const wrong = frames.map((f, k) => (f === want[k] ? null : `${k}: ${f} (want ${want[k]})`)).filter(Boolean);
  results.push(`export 10×: ${frames.length} frames, wrong ${wrong.length}: ${wrong.slice(0, 6).join(', ')}; preview ${preview.join(',')} (want 10,20,30,170,350)`);
  expect(frames).toHaveLength(36);
  expect(wrong).toEqual([]);
  expect(preview).toEqual([10, 20, 30, 170, 350]);
});
