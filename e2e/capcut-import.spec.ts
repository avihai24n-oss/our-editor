/**
 * CapCut import end to end: `/?importCapcut=1018` reads the real CapCut draft (episode 7) through
 * the dev server's read-only /__local endpoints, loads its media and builds the project.
 * Needs the draft at ~/Movies/CapCut/User Data/Projects/com.lveditor.draft/1018 (skipped otherwise).
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DRAFT = path.join(os.homedir(), 'Movies/CapCut/User Data/Projects/com.lveditor.draft/1018/draft_info.json');

test('imports CapCut draft 1018 from the URL', async ({ page }) => {
  test.skip(!fs.existsSync(DRAFT), 'CapCut draft 1018 not on this machine');
  test.setTimeout(180_000);
  await page.goto('/?importCapcut=1018');
  await page.waitForFunction(() => !!(window as any).__oe);
  await expect(page.getByTestId('capcut-import-report')).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId('capcut-import-report')).toContainText('Imported 29 clips');

  const s = await page.evaluate(() => {
    const st = (window as any).__oe.getState();
    const p = st.project;
    const end = Math.max(...p.tracks.flatMap((t: any) => t.clips.map((c: any) => c.start + c.duration)));
    return {
      kinds: p.tracks.map((t: any) => t.kind),
      counts: p.tracks.map((t: any) => t.clips.length),
      types: p.tracks[0].clips.map((c: any) => c.type),
      starts: p.tracks[0].clips.map((c: any) => c.start),
      end,
      missing: Object.values(p.assets).filter((a: any) => a.missing).length,
      assets: Object.keys(p.assets).length,
      url: location.search,
      violations: (window as any).__oeCheck(),
    };
  });
  expect(s.kinds).toEqual(['main', 'audio', 'audio']);
  expect(s.counts).toEqual([29, 1, 1]);
  expect(s.types.filter((t: string) => t === 'video')).toHaveLength(24);
  expect(s.end).toBe(182_100_000);
  expect(s.assets).toBe(23);
  expect(s.missing).toBe(0);
  expect(s.url).toBe('');
  expect(s.violations).toEqual([]);
  const draft = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
  draft.tracks[0].segments.forEach((seg: any, i: number) => expect(Math.abs(s.starts[i] - seg.target_timerange.start)).toBeLessThanOrEqual(33_334));
  // the timeline shows them (it only renders the clips in view)
  await page.getByTestId('capcut-import-close').click();
  await expect.poll(() => page.getByTestId('timeline-clip').count(), { timeout: 15_000 }).toBeGreaterThan(3);
  await page.screenshot({ path: 'screens/capcut-import-1018.png' });
});
