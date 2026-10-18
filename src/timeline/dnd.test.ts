import { describe, expect, it } from 'vitest';
import { acceptsDrag, DND_ASSET_MIME, DND_MIME, isFileDrag, parsePayloadJson, readPayload } from './dnd';

const dt = (data: Record<string, string>) => (type: string) => data[type] ?? '';

describe('library drag payload', () => {
  it('reads the SPEC json type', () => {
    expect(readPayload(dt({ [DND_MIME]: JSON.stringify({ kind: 'asset', assetId: 'a1' }) }))).toEqual({ kind: 'asset', assetId: 'a1' });
    expect(readPayload(dt({ [DND_MIME]: '{"kind":"text"}' }))).toEqual({ kind: 'text' });
    expect(readPayload(dt({ [DND_MIME]: '{"kind":"transition","type":"mix"}' }))).toEqual({ kind: 'transition', type: 'mix' });
  });
  it('reads the bare asset-id type', () => {
    expect(readPayload(dt({ [DND_ASSET_MIME]: 'abc' }))).toEqual({ kind: 'asset', assetId: 'abc' });
    expect(readPayload(dt({ [DND_ASSET_MIME]: '{"kind":"asset","assetId":"z"}' }))).toEqual({ kind: 'asset', assetId: 'z' });
  });
  it('rejects junk', () => {
    expect(parsePayloadJson('nope')).toBeNull();
    expect(parsePayloadJson('{"kind":"transition","type":"warp-drive"}')).toBeNull();
    expect(parsePayloadJson('{"kind":"asset"}')).toBeNull();
    expect(readPayload(dt({}))).toBeNull();
    expect(
      readPayload(() => {
        throw new Error('protected');
      }),
    ).toBeNull();
  });
  it('accepts our types and OS files', () => {
    expect(acceptsDrag([DND_MIME])).toBe(true);
    expect(acceptsDrag([DND_ASSET_MIME])).toBe(true);
    expect(acceptsDrag(['Files'])).toBe(true);
    expect(acceptsDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['Files', DND_MIME])).toBe(false);
  });
});
