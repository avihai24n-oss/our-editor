import { renderFrame } from './renderFrame';
import { renderOfflineMix, demoClips } from './offlineMix';
import { exportMp4, probeCodecs, downloadBlob, ExportCanceled } from './exportMp4';
import { exportWebm } from './exportWebmFallback';

const W = 1080, H = 1920, FPS = 30;
const DURATION_US = Math.round(Number(new URLSearchParams(location.search).get('dur') ?? 3) * 1e6); // ?dur=<seconds>
const VIDEO_BPS = 12_000_000, AUDIO_BPS = 192_000;

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => { $('log').textContent += s + '\n'; console.log('[spike]', s); };

interface SpikeResult {
  ok: boolean; path?: 'mp4' | 'webm'; canceled?: boolean; error?: string;
  mimeType?: string; bytes?: number; mixMs?: number; encodeMs?: number; totalMs?: number;
  codecs?: { video: string | null; audio: string | null };
}
declare global { interface Window { __spike: { run(opts?: { cancelAtFrame?: number }): Promise<SpikeResult>; result?: SpikeResult } } }

let controller: AbortController | null = null;

async function run(opts: { cancelAtFrame?: number } = {}): Promise<SpikeResult> {
  const q = new URLSearchParams(location.search);
  const force = q.get('force');
  const impulseAt = q.has('sync') ? 1.5 : undefined; // ?sync=1 adds a click at exactly t=1.5s
  const audioStartSec = q.has('prime') ? -Number(q.get('prime')) / 48000 : undefined; // ?prime=<samples>
  controller = new AbortController();
  ($('go') as HTMLButtonElement).disabled = true;
  ($('cancel') as HTMLButtonElement).disabled = false;
  const tStart = performance.now();
  let res: SpikeResult;
  try {
    const codecs = await probeCodecs({ width: W, height: H, fps: FPS, videoBitrate: VIDEO_BPS, audioBitrate: AUDIO_BPS });
    log(`codecs: video=${codecs.video} audio=${codecs.audio} VideoEncoder=${typeof VideoEncoder !== 'undefined'}`);

    const tMix = performance.now();
    const audio = await renderOfflineMix(demoClips(DURATION_US / 1e6), DURATION_US / 1e6, impulseAt);
    const mixMs = performance.now() - tMix;
    log(`offline mix: ${audio.numberOfChannels}ch ${audio.sampleRate}Hz ${audio.duration}s in ${mixMs.toFixed(0)}ms`);

    const common = {
      width: W, height: H, fps: FPS, durationUs: DURATION_US, videoBitrate: VIDEO_BPS, audioBitrate: AUDIO_BPS,
      render: renderFrame, audio, audioStartSec, signal: controller.signal,
      onProgress: ({ frame, frames, fraction }: { frame: number; frames: number; fraction: number }) => {
        ($('bar') as HTMLProgressElement).value = fraction;
        $('pct').textContent = `${frame}/${frames}`;
        if (opts.cancelAtFrame !== undefined && frame >= opts.cancelAtFrame) controller!.abort();
      },
    };

    const useMp4 = force !== 'webm' && codecs.video !== null;
    if (useMp4) {
      const r = await exportMp4(common);
      downloadBlob(r.blob, 'spike.mp4');
      res = { ok: true, path: 'mp4', mimeType: r.mimeType, bytes: r.blob.size, mixMs, encodeMs: r.encodeMs, codecs };
    } else {
      log('falling back to MediaRecorder WebM (real time)');
      const r = await exportWebm(common);
      downloadBlob(r.blob, 'spike.webm');
      res = { ok: true, path: 'webm', mimeType: r.mimeType, bytes: r.blob.size, mixMs, encodeMs: r.encodeMs, codecs };
    }
  } catch (e) {
    res = e instanceof ExportCanceled ? { ok: false, canceled: true } : { ok: false, error: String((e as Error)?.stack ?? e) };
  }
  res.totalMs = performance.now() - tStart;
  log(JSON.stringify(res));
  window.__spike.result = res;
  ($('go') as HTMLButtonElement).disabled = false;
  ($('cancel') as HTMLButtonElement).disabled = true;
  return res;
}

window.__spike = { run };
$('go').addEventListener('click', () => void run());
$('cancel').addEventListener('click', () => controller?.abort());
