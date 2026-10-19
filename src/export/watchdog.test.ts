import { describe, expect, it } from 'vitest';
import { SequentialReader, type TimedFrame } from './frameSource';
import { createWatchdog, ExportStalled, withTimeout } from './watchdog';

const frame = (ts: number): TimedFrame => ({ canvas: { width: 1, height: 1 } as TimedFrame['canvas'], timestamp: ts });
const never = () => new Promise<never>(() => undefined);

/** A frame stream at 10 fps that hangs forever before frame `hangAt` on its first `hangOpens` opens. */
function stalling(hangAt: number, hangOpens: number) {
  const opens: number[] = [];
  const open = (start: number) => {
    opens.push(start);
    const hang = opens.length <= hangOpens;
    return (async function* () {
      for (let i = Math.max(0, Math.floor(start * 10 + 1e-9)); i < 100; i++) {
        if (hang && i === hangAt) await never();
        yield frame(i / 10);
      }
    })();
  };
  return { open, opens };
}

describe('export watchdog', () => {
  it('withTimeout passes a settled promise through and rejects a stuck one', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, () => new Error('x'))).resolves.toBe(7);
    await expect(withTimeout(never(), 20, () => new ExportStalled('stuck'))).rejects.toThrow('stuck');
  });

  it('names the frame and what the source was waiting for', async () => {
    const dog = createWatchdog(20, () => 'decoding "clip.mp4" at 2.083 s');
    const err = await dog.guard(never(), 'video frame 125 / 300').catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExportStalled);
    expect((err as Error).message).toMatch(/video frame 125 \/ 300.*decoding "clip\.mp4" at 2\.083 s/);
  });
});

describe('SequentialReader: a stalled decoder', () => {
  it('recovers once by reopening the stream at the wanted time', async () => {
    const s = stalling(13, 1);
    const r = new SequentialReader(s.open, 30);
    for (let i = 0; i < 12; i++) expect((await r.frameAt(i / 10 + 1e-4))!.timestamp).toBeCloseTo(i / 10, 9);
    // frame 12 needs frame 13 as "next": the first stream hangs there → reopen at 1.2 s
    expect((await r.frameAt(1.2001))!.timestamp).toBeCloseTo(1.2, 9);
    expect(r.recoveries).toBe(1);
    expect(s.opens.at(-1)).toBeCloseTo(1.2001, 9);
    for (let i = 13; i < 30; i++) expect((await r.frameAt(i / 10 + 1e-4))!.timestamp).toBeCloseTo(i / 10, 9);
  });

  it('fails loudly (ExportStalled) when the reopened decoder stalls too', async () => {
    const s = stalling(5, 99);
    const r = new SequentialReader(s.open, 20);
    for (let i = 0; i < 4; i++) await r.frameAt(i / 10 + 1e-4);
    await expect(r.frameAt(0.4001)).rejects.toBeInstanceOf(ExportStalled);
    await r.close(); // bounded, does not hang on the stuck generator
  });
});
