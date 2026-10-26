/**
 * Cuts play clean (src/player/mediaPool.ts preload): playing across a cut, the frame after the cut
 * is the incoming clip's first frame — also on a second pass, when the incoming clip's <video> is
 * still alive from the first one (it used to show one frame ~1 s into the clip, then jump back).
 * The media carries its frame number in 10 binary blocks (made with ffmpeg geq if missing), so every
 * drawn preview frame is identified exactly. Same/two tracks × same/two assets; start 1 s and 0.1 s
 * before the cut.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { importMedia, mediaPath, openApp } from './helpers';

test.beforeAll(() => {
  const a = mediaPath('v-framecode-12s.mp4');
  if (!fs.existsSync(a))
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=12', '-vf', "geq=lum='if(lt(Y,300), 255*mod(floor(N/pow(2,floor(X/64))),2), 128)':cb=128:cr=128", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', a]);
  const b = mediaPath('v-framecode-b-12s.mp4');
  if (!fs.existsSync(b)) fs.copyFileSync(a, b);
});
/* eslint-disable @typescript-eslint/no-explicit-any */
const S = (s: number) => Math.round(s * 1e6);
for (const sc of ['same-track-same-asset', 'two-tracks-same-asset', 'two-tracks-two-assets', 'same-track-two-assets']) {
  test(sc, async ({ page }) => {
    await openApp(page);
    await importMedia(page, [mediaPath('v-framecode-12s.mp4'), mediaPath('v-framecode-b-12s.mp4')]);
    await page.evaluate(([sc, A, B, C]) => {
      const st = () => (window as any).__oe.getState();
      st().setAspectRatio('16:9');
      const by = (n: string) => (Object.values(st().project.assets) as any[]).find((x) => x.name === n).id;
      const a1 = by('v-framecode-12s.mp4');
      const a2 = sc.includes('two-assets') ? by('v-framecode-b-12s.mp4') : a1;
      const ca = st().addClip(a1, { at: 0, kind: 'overlay' });
      const tA = st().project.tracks.find((t: any) => t.clips.some((c: any) => c.id === ca)).id;
      st().trimEnd(ca, A);
      const cb = st().addClip(a2, { at: A, trackId: tA });
      st().trimEnd(cb, A + C);
      // B reads from 5 s (frame 150)
      st().editProject((d: any) => {
        const c = d.tracks.flatMap((t: any) => t.clips).find((x: any) => x.id === cb);
        c.inPoint = B;
      });
      if (sc.startsWith('two-tracks')) st().moveClip(cb, { start: A, trackId: tA, newTrack: 'above' });
    }, [sc, S(3), S(5), S(3)] as const);
    const layout = await page.evaluate(() => (window as any).__oe.getState().project.tracks.filter((t: any) => t.kind !== 'audio').map((t: any) => t.clips.map((c: any) => [c.start / 1e6, (c.start + c.duration) / 1e6, c.inPoint / 1e6])));
    expect(layout.flat().length).toBe(2);
    for (let run = 0; run < 6; run++) {
      const from = run < 3 ? 2_000_000 : 2_900_000;
      const frames: number[] = await page.evaluate(async (from) => {
        const s = (window as any).__oe.getState();
        s.pause();
        s.setPlayhead(from);
        await new Promise((r) => setTimeout(r, 400));
        const cv = document.querySelector('[data-testid="player-canvas"]') as HTMLCanvasElement;
        const out: number[] = [];
        s.play();
        const t0 = performance.now();
        await new Promise<void>((res) => {
          const tick = () => {
            const ctx = cv.getContext('2d')!;
            const y = Math.floor(cv.height * 0.4);
            const row = ctx.getImageData(0, y, cv.width, 1).data;
            let n = 0;
            for (let b = 0; b < 10; b++) {
              const x = Math.floor(((b + 0.5) / 10) * cv.width);
              if (row[x * 4]! > 128) n |= 1 << b;
            }
            out.push(n);
            if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
            else res();
          };
          requestAnimationFrame(tick);
        });
        s.pause();
        return out;
      }, from);
      // collapse repeats
      const seq: string[] = [];
      let prev = -1, rep = 0;
      for (const f of frames) { if (f === prev) rep++; else { if (prev >= 0) seq.push(rep ? `${prev}x${rep + 1}` : String(prev)); prev = f; rep = 0; } }
      seq.push(rep ? `${prev}x${rep + 1}` : String(prev));
      // clip A ends on frame 89, clip B enters on frame 150 (its in-point, 5 s)
      const n = seq.map((x) => parseInt(x));
      const firstB = n.findIndex((x) => x >= 150);
      const around = seq.slice(Math.max(0, firstB - 4), firstB + 6).join(' ');
      expect(n[firstB], `${sc} run ${run}: ${around}`).toBe(150);
      expect(n[firstB - 1], `${sc} run ${run}: ${around}`).toBe(89);
      for (let k = firstB + 1; k < n.length; k++) expect(n[k]! - n[k - 1]!, `${sc} run ${run}: ${seq.slice(firstB, k + 2).join(' ')}`).toBeGreaterThan(0);
    }
  });
}
