// Headless proof: start vite, drive the page in several browser configs, capture the download, ffprobe it.
// Usage: node prove.mjs            (all configs)
//        node prove.mjs chromium   (configs whose name contains "chromium")
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const PORT = 5199;
const URL = `http://localhost:${PORT}/`;

const configs = [
  { name: 'chromium-headless-shell', launch: { headless: true } },
  { name: 'chromium-new-headless', launch: { headless: true, channel: 'chromium' } },
  { name: 'chrome-headless', launch: { headless: true, channel: 'chrome' } },
  { name: 'chrome-headed', launch: { headless: false, channel: 'chrome' } },
].filter((c) => !process.argv[2] || c.name.includes(process.argv[2]));

function ffprobe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    format: j.format.format_name, duration: +j.format.duration, videoDuration: +v?.duration, bytes: +j.format.size,
    video: v && { codec: v.codec_name, tag: v.codec_tag_string, profile: v.profile, w: v.width, h: v.height, fps: v.avg_frame_rate, frames: +v.nb_read_frames, pix: v.pix_fmt, bitrate: +v.bit_rate },
    audio: a && { codec: a.codec_name, tag: a.codec_tag_string, ch: a.channels, rate: +a.sample_rate, duration: +a.duration },
  };
}

function check(p) {
  const errs = [];
  // container duration = longest stream; AAC pads to a 1024-sample frame, so allow up to one video frame
  if (p.duration < 3 || p.duration - 3 > 1 / 30) errs.push(`duration ${p.duration}`);
  if (Math.abs(p.videoDuration - 3) > 1e-6) errs.push(`video duration ${p.videoDuration}`);
  if (!p.video || p.video.w !== 1080 || p.video.h !== 1920) errs.push('size');
  if (p.video?.codec !== 'h264' || p.video?.tag !== 'avc1') errs.push(`video ${p.video?.codec}/${p.video?.tag}`);
  if (p.video?.frames !== 90) errs.push(`frames ${p.video?.frames}`);
  if (p.audio?.codec !== 'aac') errs.push(`audio ${p.audio?.codec}`);
  if (p.audio?.ch !== 2) errs.push(`channels ${p.audio?.ch}`);
  return errs;
}

async function runOne(browser, cfg, { query = '', cancelAtFrame } = {}) {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('console', (m) => m.text().startsWith('[spike]') && console.log(`   ${m.text()}`));
  page.on('pageerror', (e) => console.log('   PAGEERROR', e.message));
  await page.goto(URL + query);
  const wall0 = Date.now();
  const dlPromise = cancelAtFrame === undefined ? page.waitForEvent('download', { timeout: 120_000 }) : null;
  const res = await page.evaluate((c) => window.__spike.run({ cancelAtFrame: c }), cancelAtFrame);
  const wallMs = Date.now() - wall0;
  let probe = null, file = null;
  if (dlPromise && res.ok) {
    const dl = await dlPromise;
    file = join(outDir, `${cfg.name}${query ? '-' + query.replace(/\W/g, '') : ''}-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    probe = ffprobe(file);
  }
  await page.close();
  return { res, wallMs, file, probe };
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: here, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => vite.stdout.on('data', (d) => d.toString().includes('Local') && r()));

const summary = [];
try {
  for (const cfg of configs) {
    console.log(`\n=== ${cfg.name}`);
    let browser;
    try {
      browser = await chromium.launch(cfg.launch);
    } catch (e) {
      console.log('   launch failed:', e.message.split('\n')[0]);
      summary.push({ cfg: cfg.name, launch: 'failed' });
      continue;
    }
    console.log('   version', browser.version());
    // 1. MP4 export
    const mp4 = await runOne(browser, cfg);
    const errs = mp4.probe ? check(mp4.probe) : ['no file'];
    console.log('   probe', JSON.stringify(mp4.probe));
    console.log(`   MP4 ${errs.length ? 'FAIL ' + errs.join(', ') : 'PASS'}  wall=${mp4.wallMs}ms`);
    // 2. Cancel mid-way
    const cancel = await runOne(browser, cfg, { cancelAtFrame: 30 });
    console.log(`   cancel at frame 30 -> ${JSON.stringify(cancel.res)}`);
    // 3. Forced WebM fallback
    const webm = await runOne(browser, cfg, { query: '?force=webm' });
    console.log('   webm probe', JSON.stringify(webm.probe));
    // 4. Throughput: 30 s export
    const perf = await runOne(browser, cfg, { query: '?dur=30' });
    const perfFps = perf.res.ok ? (900 / (perf.res.encodeMs / 1000)).toFixed(0) : 'n/a';
    console.log(`   30s export: encode ${Math.round(perf.res.encodeMs)}ms = ${perfFps} fps, frames=${perf.probe?.video?.frames}, ${perf.probe?.bytes} bytes`);
    summary.push({
      cfg: cfg.name, version: browser.version(),
      codecs: mp4.res.codecs, mp4: errs.length ? `FAIL ${errs.join(', ')}` : 'PASS',
      mp4Bytes: mp4.probe?.bytes, mixMs: Math.round(mp4.res.mixMs ?? 0), encodeMs: Math.round(mp4.res.encodeMs ?? 0), wallMs: mp4.wallMs,
      perf30s: `${Math.round(perf.res.encodeMs)}ms (${perfFps} fps)`,
      cancel: cancel.res.canceled ? `PASS (${Math.round(cancel.res.totalMs)}ms)` : 'FAIL',
      webm: webm.probe ? `${webm.probe.video?.codec}+${webm.probe.audio?.codec} ${webm.probe.video?.w}x${webm.probe.video?.h} frames=${webm.probe.video?.frames} dur=${webm.probe.duration} enc=${Math.round(webm.res.encodeMs)}ms` : `FAIL ${webm.res.error ?? ''}`,
    });
    await browser.close();
  }
} finally {
  vite.kill();
}
console.log('\n=== SUMMARY');
console.table(summary);
