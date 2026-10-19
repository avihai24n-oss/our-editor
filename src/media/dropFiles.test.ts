import { describe, expect, it } from 'vitest';
import { DND_ASSET_MIME, DND_MIME } from '../timeline/dnd';
import { isOsFileDrag, kindOfFile, partitionFiles, skippedMessage } from './dropFiles';

const f = (name: string, type = '') => ({ name, type });

describe('kindOfFile (drop type filter)', () => {
  it('uses the MIME type first', () => {
    expect(kindOfFile(f('clip', 'video/mp4'))).toBe('video');
    expect(kindOfFile(f('x', 'audio/mpeg'))).toBe('audio');
    expect(kindOfFile(f('x', 'image/png'))).toBe('image');
  });
  it('falls back to the extension (Finder often sends an empty type for .mov / .mkv)', () => {
    expect(kindOfFile(f('Holiday.MOV'))).toBe('video');
    expect(kindOfFile(f('a.mkv', 'application/octet-stream'))).toBe('video');
    expect(kindOfFile(f('voice.m4a'))).toBe('audio');
    expect(kindOfFile(f('photo.JPEG'))).toBe('image');
  });
  it('rejects everything else', () => {
    expect(kindOfFile(f('notes.pdf', 'application/pdf'))).toBeNull();
    expect(kindOfFile(f('readme.txt', 'text/plain'))).toBeNull();
    expect(kindOfFile(f('noextension'))).toBeNull();
    expect(kindOfFile(f('archive.zip', 'application/zip'))).toBeNull();
  });
});

describe('partitionFiles', () => {
  it('keeps the drop order and splits accepted / skipped', () => {
    const files = [f('a.mp4', 'video/mp4'), f('b.pdf', 'application/pdf'), f('c.png', 'image/png'), f('d.txt', 'text/plain'), f('e.wav')];
    const { accepted, skipped } = partitionFiles(files);
    expect(accepted.map((x) => x.name)).toEqual(['a.mp4', 'c.png', 'e.wav']);
    expect(skipped.map((x) => x.name)).toEqual(['b.pdf', 'd.txt']);
  });
});

describe('isOsFileDrag', () => {
  it('is true for files from the OS only', () => {
    expect(isOsFileDrag(['Files'])).toBe(true);
    expect(isOsFileDrag(['Files', 'text/uri-list'])).toBe(true);
  });
  it('ignores internal drags (asset tiles, presets) even when Chrome adds Files', () => {
    expect(isOsFileDrag([DND_MIME, 'Files'])).toBe(false);
    expect(isOsFileDrag([DND_ASSET_MIME])).toBe(false);
    expect(isOsFileDrag(['text/plain'])).toBe(false);
    expect(isOsFileDrag(undefined)).toBe(false);
  });
});

describe('skippedMessage', () => {
  it('lists what was skipped', () => {
    expect(skippedMessage([])).toBeNull();
    expect(skippedMessage(['a.pdf'])).toMatch(/Skipped 1 unsupported file: a\.pdf/);
    expect(skippedMessage(['a.pdf', 'b.txt', 'c.doc', 'd.zip'])).toMatch(/Skipped 4 unsupported files: a\.pdf, b\.txt, c\.doc and 1 more/);
    expect(skippedMessage([], ['Cannot read x.mp4'])).toMatch(/Cannot read x\.mp4/);
  });
});
