/**
 * Inbox placements (src/import/inbox.ts + scripts/add-media.sh): an agent puts pool clips on the
 * timeline — after the last clip of a track, and on a NEW track directly above ("$prev"). The
 * request goes to this server's own inbox (~/.our-editor/inbox/<port>/), like the script does.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importMedia, mediaPath, openApp } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('place clips after a track end and on a new track above', async ({ page, baseURL }) => {
  const port = new URL(baseURL!).port;
  const dir = path.join(os.homedir(), '.our-editor/inbox', port);
  fs.mkdirSync(dir, { recursive: true });
  await openApp(page);
  await importMedia(page, [mediaPath('v-landscape-4s.mp4'), mediaPath('v-vertical-5s.mp4')]);
  const { name, overlay } = await page.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.setProjectName('Inbox place test');
    const a = Object.values(s.project.assets).find((x: any) => x.name === 'v-landscape-4s.mp4') as any;
    const id = (window as any).__oe.getState().addClip(a.id, { at: 1_000_000, kind: 'overlay' });
    const p = (window as any).__oe.getState().project;
    return { name: p.name, overlay: p.tracks.find((t: any) => t.clips.some((c: any) => c.id === id)).id };
  });
  const id = `req-test-${Date.now()}`;
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      project: name,
      files: [],
      place: [
        { asset: 'v-vertical-5s.mp4', track: overlay, at: { afterTrackEnd: overlay } },
        { asset: 'v-landscape-4s', track: { newAbove: '$prev' }, at: '$prevStart' },
        { asset: 'v-landscape-4s.mp4', track: overlay, at: { afterTrackEnd: overlay } },
        { asset: 'nope.mp4' },
      ],
    }),
  );
  const done = path.join(dir, 'done', `${id}.json`);
  await expect.poll(() => fs.existsSync(done), { timeout: 15_000 }).toBe(true);
  const { result } = JSON.parse(fs.readFileSync(done, 'utf8'));
  fs.rmSync(done);
  expect(result.placed).toHaveLength(3);
  const [b, c, d] = result.placed;
  expect(d).toMatchObject({ trackId: overlay, start: 10 }); // afterTrackEnd is evaluated when placed
  expect(b).toMatchObject({ asset: 'v-vertical-5s.mp4', trackId: overlay, start: 5 }); // after the 1–5 s clip
  expect(c.start).toBe(5); // "$prevStart": stacked on b for comparison
  expect(c.trackIndex).toBe(b.trackIndex + 1); // a NEW track directly above
  expect(c.trackId).not.toBe(overlay);
  expect(result.errors.join(' ')).toMatch(/nope\.mp4" is not in the media pool/);
  // one undo per placement
  await page.evaluate(() => (window as any).__oe.getState().undo());
  const ids = await page.evaluate(() => (window as any).__oe.getState().project.tracks.flatMap((t: any) => t.clips.map((x: any) => x.id)));
  expect(ids).toContain(c.clipId);
  expect(ids).not.toContain(d.clipId);
});
