# 06 — e2e test harness

Playwright end-to-end harness for Our Editor. It lives in `e2e/` as a **separate npm package**
(own `package.json` / `node_modules`), so it never touches the app's dependencies.

## Layout

```
e2e/
  package.json          @playwright/test 1.64, typescript, @types/node
  playwright.config.ts  baseURL, webServer, Chromium flags
  tsconfig.json         typecheck with: npx tsc --noEmit -p e2e   (from project root)
  helpers.ts            reusable helpers (below)
  smoke.spec.ts         smoke test
  screens/              screenshots from helpers.screenshot()          (git-ignored)
  downloads/            exported files saved by waitForDownload()      (git-ignored)
  test-results/, playwright-report/   failure screenshots/videos/traces (git-ignored)
test-media/             synthetic input media, see test-media/README.md (git-ignored)
```

## How to run

```bash
cd e2e
npm install                     # once (already done)
npx playwright install chromium # once (already done)
npx playwright test             # all specs; starts `npm run dev -- --port 5173` in the project root
npx playwright test smoke.spec.ts
npx playwright test --headed    # watch it
npx playwright show-report      # HTML report with traces
npm run typecheck               # tsc --noEmit -p .
E2E_CHANNEL=chrome npx playwright test   # use the installed Google Chrome instead of bundled Chromium
E2E_PORT=5174 npx playwright test        # other port
```

The webServer entry has `reuseExistingServer: true`: if a dev server is already on 5173 it is used,
otherwise Playwright starts one (`--strictPort`) and stops it afterwards.

## Config highlights

- `baseURL` `http://localhost:5173`, viewport 1600x1000, 1 worker (media tests are heavy).
- Chromium args: `--autoplay-policy=no-user-gesture-required`, WebCodecs/SharedArrayBuffer features,
  fake media UI, GPU blocklist ignored.
- `acceptDownloads: true`, `downloadsPath` = `e2e/downloads/`.
- Screenshot `only-on-failure`, video and trace `retain-on-failure`.

**Codec check (18 Oct 2026):** Playwright's bundled Chromium 156 (headless shell) and the installed
Chrome 155 both report, on a secure origin: `<video>` H.264 + AAC "probably", `VideoDecoder` and
`VideoEncoder` avc1 supported, `AudioEncoder` mp4a.40.2 supported. WebCodecs is **undefined on
non-secure origins** (about:blank, plain http on a LAN IP) — `localhost` counts as secure, so always
test through `localhost`.

## Helpers (`e2e/helpers.ts`)

| Helper | What it does |
|---|---|
| `MEDIA`, `mediaPath(name)` | names of the test-media files; resolves to an absolute path |
| `openApp(page)` | `goto('/')` and wait for all five required regions |
| `importMedia(page, files[])` | `setInputFiles` on `media-import-input` (fallback: first `input[type=file]` in `left-panel`, then on the page); waits until every file shows as a `media-asset` |
| `assetLocator(page, name)` | `media-asset[data-asset-name=name]`, fallback by text |
| `dragAssetToTimeline(page, name, trackIndex?, xOffset=40)` | HTML5 `dragTo` onto `timeline-track[data-track-index]` (or the whole `timeline`); if no new `timeline-clip` appears within 3 s, retries with raw mouse events; asserts the clip count grew |
| `trackLocator`, `clipsLocator` | track row / all clips |
| `clickPlay(page)` | clicks `play-button` (fallback: button named Play/Pause inside `player`) |
| `pressShortcut(page, 'Mod+Z')` | `Mod` = Meta on macOS, Control elsewhere; blurs text inputs first unless `{keepFocus:true}` |
| `getTimecode(page)` / `getTimeSeconds(page, fps=30)` / `timecodeToSeconds(tc)` | read and parse `timecode` (`HH:MM:SS:FF`, `MM:SS.ms`, `a / b`) |
| `screenshot(page, name)` | full-page PNG into `e2e/screens/<name>.png`, returns the path |
| `collectConsoleErrors(page, ignore?)` | call before `goto`; `.errors` = all console errors + uncaught exceptions, `.real()` = minus known noise (favicon, React DevTools banner) |
| `waitForDownload(page, trigger)` | runs `trigger`, waits for the download (180 s default), saves to `e2e/downloads/`, returns the path |
| `ffprobe(file)` | `{duration, width, height, hasVideo, hasAudio, videoCodec, audioCodec, fps, sizeBytes}` via `child_process` |
| `expectMediaFile(file, {duration, durationTolerance=0.15, width, height, hasAudio, hasVideo})` | ffprobe + assertions |

Example export test:

```ts
import { test } from '@playwright/test';
import { MEDIA, openApp, importMedia, dragAssetToTimeline, waitForDownload, expectMediaFile } from './helpers';

test('export one vertical clip', async ({ page }) => {
  await openApp(page);
  await importMedia(page, [MEDIA.vertical]);
  await dragAssetToTimeline(page, MEDIA.vertical);
  await page.getByTestId('export-button').click();
  const file = await waitForDownload(page, () => page.getByTestId('export-confirm').click());
  expectMediaFile(file, { duration: 5, width: 1080, height: 1920, hasAudio: true });
});
```

## Selector / test-id contract

Full table and rules: [`docs/integration-notes/e2e-testids.md`](../integration-notes/e2e-testids.md).
Required regions: `left-panel`, `player`, `inspector`, `timeline`, `export-button`. QA flows also use
`media-import-input`, `media-asset[data-asset-name]`, `timeline-track[data-track-index]`,
`timeline-clip`, `play-button`, `timecode`, `playhead`, `export-dialog`, `export-confirm`.
Export must produce a real `<a download>` download.

## Test media

See `test-media/README.md` (with the regeneration commands).

| File | Content |
|---|---|
| `v-vertical-5s.mp4` | 1080x1920 30 fps 5 s, testsrc2, H.264 + AAC 440 Hz |
| `v-landscape-4s.mp4` | 1920x1080 30 fps 4 s, SMPTE bars, H.264 + AAC 880 Hz |
| `v-silent-3s.mp4` | 1080x1920 30 fps 3 s, mandelbrot, H.264, no audio |
| `img-square.png` | 1080x1080 gradient with "IMG" |
| `a-tone-6s.mp3` | 6 s 330 Hz sine, MP3 mono |
| `a-speech-like.wav` | 4 s beeps with silences, PCM mono 48 kHz |

## Status

`npx tsc --noEmit -p e2e` passes. The smoke test runs (dev server starts, page loads) and currently
fails at `missing data-testid="left-panel"` — expected until builders add the test ids.
