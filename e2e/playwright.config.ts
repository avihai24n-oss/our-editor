import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const PORT = Number(process.env.E2E_PORT ?? 5173);
// Set E2E_CHANNEL=chrome to run against the installed Google Chrome instead of
// Playwright's bundled Chromium (both support H.264/AAC + WebCodecs on localhost).
const channel = process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.ts',
  outputDir: path.join(here, 'test-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: path.join(here, 'playwright-report'), open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        channel,
        launchOptions: {
          downloadsPath: path.join(here, 'downloads'),
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--enable-features=WebCodecs,SharedArrayBuffer',
            '--enable-blink-features=WebCodecs',
            '--use-fake-ui-for-media-stream',
            '--enable-unsafe-webgpu',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    cwd: projectRoot,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
