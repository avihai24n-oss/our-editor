import { describe, expect, it } from 'vitest';
import { applyMatrix, correctionMatrix, elementMatrix, intendedMatrix, webCodecsMatrix, type ColorTags } from './colorMatrix';

const tags = (matrix: string | null, full: boolean, width: number, height: number): ColorTags => ({ matrix, primaries: full ? 'bt709' : null, transfer: full ? 'bt709' : null, width, height });

describe('decoder matrix rules (measured in Chromium)', () => {
  it('HD tagged BT.601 matrix only: <video> shows 709, WebCodecs 601, intended 601', () => {
    const t = tags('bt470bg', false, 1920, 1080);
    expect([intendedMatrix(t), elementMatrix(t), webCodecsMatrix(t)]).toEqual(['bt601', 'bt709', 'bt601']);
  });
  it('untagged SD: <video> 601, WebCodecs 709, intended 601', () => {
    const t = tags(null, false, 640, 360);
    expect([intendedMatrix(t), elementMatrix(t), webCodecsMatrix(t)]).toEqual(['bt601', 'bt601', 'bt709']);
  });
  it('fully tagged or untagged HD (incl. portrait 540×960): everyone agrees', () => {
    for (const t of [tags(null, false, 540, 960), tags('bt709', true, 640, 360), tags('smpte170m', true, 1920, 1080), tags(null, false, 1920, 1080)]) {
      expect(new Set([intendedMatrix(t), elementMatrix(t), webCodecsMatrix(t)]).size).toBe(1);
    }
  });
  it('BT.2020 is left alone', () => {
    expect(correctionMatrix(elementMatrix(tags('bt2020-ncl', true, 3840, 2160)), intendedMatrix(tags('bt2020-ncl', true, 3840, 2160)))).toBeNull();
  });
});

describe('correctionMatrix', () => {
  it('saturated red decoded with the wrong matrix comes back to the reference', () => {
    // smptebars 75 % red: ffmpeg BT.601 decode 191,0,1; read as BT.709 by <video>: 208,19,1
    const px = new Uint8ClampedArray([208, 19, 1, 255]);
    applyMatrix(px, correctionMatrix('bt709', 'bt601')!);
    expect(Math.abs(px[0]! - 191)).toBeLessThanOrEqual(2);
    expect(px[1]!).toBeLessThanOrEqual(2);
    expect(px[2]!).toBeLessThanOrEqual(4); // the 709 read already clipped a negative blue to 1
  });
  it('round trip is identity and greys are untouched', () => {
    const a = correctionMatrix('bt709', 'bt601')!;
    const b = correctionMatrix('bt601', 'bt709')!;
    const px = new Uint8ClampedArray([120, 60, 200, 255, 128, 128, 128, 255]);
    applyMatrix(px, a);
    expect([px[4], px[5], px[6]]).toEqual([128, 128, 128]);
    applyMatrix(px, b);
    for (const [i, v] of [120, 60, 200].entries()) expect(Math.abs(px[i]! - v)).toBeLessThanOrEqual(1);
  });
  it('no correction when the matrices agree', () => {
    expect(correctionMatrix('bt601', 'bt601')).toBeNull();
  });
});
