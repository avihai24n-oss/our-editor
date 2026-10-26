/**
 * Trim preview (CapCut): dragging a clip's edge shows that edge's frame in the player, live — the new
 * last frame (right edge) or the new first frame (left edge, also with the magnet ripple) — and the
 * player goes back to the playhead's frame on release. Frame-coded media identifies the exact frame.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { importMedia, mediaPath, openApp } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test.beforeAll(() => {
  const a = mediaPath('v-framecode-12s.mp4');
  if (!fs.existsSync(a))
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=12', '-vf', "geq=lum='if(lt(Y,300), 255*mod(floor(N/pow(2,floor(X/64))),2), 128)':cb=128:cr=128", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', a]);
});

/** The frame number the player shows (polls until it settles on a decodable frame). */
const shown = (page: Page) =>
  page.evaluate(() => {
    const cv = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
    const row = cv.getContext('2d')!.getImageData(0, Math.floor(cv.height * 0.4), cv.width, 1).data;
    let n = 0;
    for (let b = 0; b < 10; b++) if (row[Math.floor(((b + 0.5) / 10) * cv.width) * 4]! > 128) n |= 1 << b;
    return n;
  });

const clipState = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips)[0])));

test('dragging an edge previews its frame; release returns to the playhead', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [mediaPath('v-framecode-12s.mp4')]);
  await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.setAspectRatio('16:9');
    s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'overlay' });
    s.setPlayhead(1_000_000); // frame 30
  });
  await expect.poll(() => shown(page)).toBe(30);
  const clip = page.locator('[data-testid="timeline-clip"]');

  for (const edge of ['right', 'left'] as const) {
    const h = (await clip.locator(`.tl-clip__handle--${edge}`).boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const dx of edge === 'right' ? [-60, -120, -180] : [40, 90]) {
      await page.mouse.move(x + dx, y, { steps: 4 });
      const c = await clipState(page);
      // the edge frame in SOURCE frames: right = inPoint + duration − 1 frame; left = inPoint
      const want = edge === 'right' ? Math.round((c.inPoint + c.duration) / (1e6 / 30)) - 1 : Math.round(c.inPoint / (1e6 / 30));
      await expect.poll(() => shown(page), { message: `${edge} edge, dx ${dx}` }).toBe(want);
    }
    await page.mouse.up();
    // back on the playhead (frame at 1 s; after the left trim the clip content moved under it)
    const c = await clipState(page);
    const playheadFrame = Math.round((c.inPoint + (1_000_000 - c.start)) / (1e6 / 30));
    await expect.poll(() => shown(page), { message: `${edge}: back to the playhead` }).toBe(playheadFrame);
    expect(await page.evaluate(() => (window as any).__oe.getState().previewTime)).toBeNull();
  }
});
