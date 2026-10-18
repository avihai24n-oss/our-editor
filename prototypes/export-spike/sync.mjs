// A/V sync check: export with a 1-sample click at exactly t=1.5s, decode the MP4's audio with ffmpeg
// (which honours the edit list), and report where the click actually lands.
// Usage: node sync.mjs [primeSamples]
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const prime = process.argv[2];
const query = `?sync=1${prime ? `&prime=${prime}` : ''}`;
const configs = [
  { name: 'chromium-headless-shell', launch: { headless: true } },
  { name: 'chrome-headless', launch: { headless: true, channel: 'chrome' } },
];

function clickPosition(file) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  // the click sits on top of two tones; find the largest sample-to-sample jump between 1.3s and 1.7s
  let best = 0, at = 0;
  for (let i = Math.floor(1.3 * 48000); i < 1.7 * 48000; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > best) { best = d; at = i; }
  }
  return { sample: at, offsetSamples: at - 72000, offsetMs: ((at - 72000) / 48).toFixed(2), totalSamples: x.length };
}

const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: here, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => vite.stdout.on('data', (d) => d.toString().includes('Local') && r()));
try {
  for (const cfg of configs) {
    const browser = await chromium.launch(cfg.launch);
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto('http://localhost:5199/' + query);
    const dl = page.waitForEvent('download');
    const res = await page.evaluate(() => window.__spike.run());
    const file = join(outDir, `sync-${cfg.name}-prime${prime ?? 0}.mp4`);
    await (await dl).saveAs(file);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration', '-of', 'csv=p=0', file]).toString().trim().replace(/\n/g, ' | ');
    console.log(cfg.name, `prime=${prime ?? 0}`, res.ok ? 'ok' : res.error, JSON.stringify(clickPosition(file)), probe);
    await browser.close();
  }
} finally {
  vite.kill();
}
