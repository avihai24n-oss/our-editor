/**
 * Persistence and the home screen:
 * - a refresh brings the project back as it was (clips, name, playhead, zoom, selection);
 * - closing the tab mid-edit does not lose the edit;
 * - the home screen lists every project and can open, create, rename, duplicate and delete them;
 * - leaving a project for the gallery saves it first.
 */
import { expect, test, type Page } from '@playwright/test';
import { clipsLocator, dragAssetToTimeline, importMedia, MEDIA, openApp, screenshot } from './helpers';

const doc = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __oe: { getState: () => Record<string, unknown> } };
    const s = w.__oe.getState() as {
      project: { id: string; name: string; tracks: { clips: unknown[] }[] };
      playhead: number;
      zoom: number;
      selection: { clipIds: string[] };
      saveStatus: { lastSavedAt: number | null };
    };
    return {
      id: s.project.id,
      name: s.project.name,
      clips: s.project.tracks.reduce((n, t) => n + t.clips.length, 0),
      playhead: s.playhead,
      zoom: s.zoom,
      selected: s.selection.clipIds.length,
      savedAt: s.saveStatus.lastSavedAt,
    };
  });

const renameOpenProject = async (page: Page, name: string) => {
  const input = page.getByLabel('Project name').first();
  await input.fill(name);
  await input.blur();
};

/** Waits until the autosave status line shows a write. */
const waitSaved = async (page: Page) => {
  await expect.poll(async () => (await doc(page)).savedAt, { timeout: 15_000 }).not.toBeNull();
};

test.describe('persistence + home screen', () => {
  test('a refresh brings the project back exactly as it was', async ({ page }) => {
    await openApp(page);
    await importMedia(page, [MEDIA.vertical]);
    await dragAssetToTimeline(page, MEDIA.vertical);
    await renameOpenProject(page, 'Refresh me');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // five frames in
    await page.evaluate(() => (window as unknown as { __oe: { getState: () => { setZoom: (n: number) => void } } }).__oe.getState().setZoom(123));
    const before = await doc(page);
    expect(before.clips).toBe(1);
    expect(before.playhead).toBeGreaterThan(0);
    expect(before.selected).toBe(1);
    expect(before.zoom).toBe(123);
    await waitSaved(page);

    await page.reload();
    await openApp(page);
    await expect.poll(async () => (await doc(page)).clips, { timeout: 15_000 }).toBe(1);
    const after = await doc(page);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('Refresh me');
    await expect.poll(async () => (await doc(page)).playhead, { timeout: 10_000 }).toBe(before.playhead);
    expect(after.zoom).toBe(123);
    expect((await doc(page)).selected).toBe(1); // the clip you had selected is still selected
    await expect(clipsLocator(page)).toHaveCount(1);
  });

  test('an edit made just before the tab closes is still there', async ({ page }) => {
    await openApp(page);
    await importMedia(page, [MEDIA.image]);
    await dragAssetToTimeline(page, MEDIA.image);
    await waitSaved(page);

    // rename and reload at once: the debounce has not fired, only the unload flush can save this
    await renameOpenProject(page, 'Typed then closed');
    await page.reload();
    await openApp(page);
    await expect.poll(async () => (await doc(page)).name, { timeout: 15_000 }).toBe('Typed then closed');
  });

  test('the home screen lists the project, opens it again, and duplicates and deletes it', async ({ page }) => {
    await openApp(page);
    await importMedia(page, [MEDIA.vertical]);
    await dragAssetToTimeline(page, MEDIA.vertical);
    await renameOpenProject(page, 'Gallery one');
    await waitSaved(page);
    const opened = await doc(page);

    await page.getByTestId('home-button').click();
    const card = page.getByTestId('project-card').filter({ has: page.getByText('Gallery one') });
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(card.getByText('1 clip')).toBeVisible();
    await screenshot(page, 'home-screen');

    // a new project from the gallery, then back into the first one
    await page.getByTestId('home-new-project').click();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect.poll(async () => (await doc(page)).clips).toBe(0);
    expect((await doc(page)).id).not.toBe(opened.id);

    await page.getByTestId('home-button').click();
    await expect(page.getByTestId('project-card')).toHaveCount(2);
    await card.getByTestId('project-open').click();
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect.poll(async () => (await doc(page)).id).toBe(opened.id);
    await expect(clipsLocator(page)).toHaveCount(1);

    // duplicate and delete from the ⋯ menu
    await page.getByTestId('home-button').click();
    await card.getByTestId('project-menu').click();
    await page.getByRole('menuitem', { name: /Duplicate/ }).click();
    const copy = page.getByTestId('project-card').filter({ has: page.getByText('Gallery one copy') });
    await expect(copy).toHaveCount(1);
    await copy.getByTestId('project-menu').click();
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    await page.getByTestId('confirm-delete').click();
    await expect(copy).toHaveCount(0);
  });

  test('leaving for the home screen saves the project first', async ({ page }) => {
    await openApp(page);
    await importMedia(page, [MEDIA.image]);
    await dragAssetToTimeline(page, MEDIA.image);
    await waitSaved(page);
    await renameOpenProject(page, 'Saved on the way out');
    await page.getByTestId('home-button').click(); // immediately: no debounce has fired
    await expect(page.getByTestId('project-card').filter({ has: page.getByText('Saved on the way out') })).toHaveCount(1);
  });
});
