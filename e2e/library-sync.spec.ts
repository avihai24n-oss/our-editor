/**
 * The on-disk project library (vite-plugins/projectStore.js + src/store/diskSync.ts): a project made
 * in one browser profile shows on the home screen of another (a fresh context = a fresh profile with
 * an empty IndexedDB), opens there with its media, and a delete in one removes it in the other.
 * The e2e server writes to a temp library (playwright.config.ts), never the user's, and only for
 * contexts with the opt-in cookie.
 */
const optIn = (c: BrowserContext) => c.addCookies([{ name: 'oe-library', value: '1', domain: 'localhost', path: '/' }]);
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { importMedia, mediaPath, openApp } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const st = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify({ id: (window as any).__oe.getState().project.id, name: (window as any).__oe.getState().project.name })));

test('a project made in one profile is on the home screen of another, with its media', async ({ browser }) => {
  const name = `Sync test ${Date.now()}`;
  // profile A: a project with one clip
  const a = await browser.newContext();
  await optIn(a);
  const pa = await a.newPage();
  await openApp(pa);
  await pa.evaluate((n) => (window as any).__oe.getState().setProjectName(n), name);
  await importMedia(pa, [mediaPath('v-landscape-4s.mp4')]);
  await pa.evaluate(() => {
    const s = (window as any).__oe.getState();
    s.addClip(Object.keys(s.project.assets)[0], { at: 0, kind: 'main' });
  });
  const { id } = await st(pa);
  // the mirror is written in the background: wait until the library has the project and its blob
  await expect
    .poll(async () => {
      const lib = await pa.evaluate(() => fetch('/__store/projects').then((r) => r.json()));
      const p = lib.projects.find((x: any) => x.id === id);
      if (!p || !p.tracks.some((t: any) => t.clips.length)) return false;
      const key = (Object.values(p.assets)[0] as any).blobKey;
      return pa.evaluate((k) => fetch(`/__store/blob?key=${k}`, { method: 'HEAD' }).then((r) => r.status === 200), key);
    }, { timeout: 20_000 })
    .toBe(true);

  // profile B: empty IndexedDB → opens straight into the newest project, media playable
  const b = await browser.newContext();
  await optIn(b);
  const pb = await b.newPage();
  await openApp(pb);
  await expect.poll(() => st(pb).then((x) => x.id)).toBe(id);
  await expect(pb.locator('[data-testid="timeline-clip"]')).toHaveCount(1);
  await expect(pb.locator('[data-testid="timeline-clip"]')).not.toHaveClass(/is-missing/);
  // and it is a card on B's home screen
  await pb.getByTestId('home-button').click();
  await expect(pb.locator(`[data-testid="project-card"][data-project-id="${id}"]`)).toBeVisible();

  // delete in B → gone from A after A's next boot
  const card = pb.locator(`[data-testid="project-card"][data-project-id="${id}"]`);
  await card.getByTestId('project-menu').click();
  await pb.getByRole('menuitem', { name: /delete/i }).click();
  await pb.getByTestId('confirm-delete').click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => pb.evaluate((pid) => fetch('/__store/projects').then((r) => r.json()).then((l) => !l.projects.some((x: any) => x.id === pid)), id))
    .toBe(true);
  await pa.reload();
  await pa.getByTestId('home-button').click();
  await expect(pa.locator('[data-testid="home-screen"]')).toBeVisible();
  await expect(pa.locator(`[data-testid="project-card"][data-project-id="${id}"]`)).toHaveCount(0);
  await a.close();
  await b.close();
});
