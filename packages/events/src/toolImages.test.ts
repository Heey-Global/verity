import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_IMAGE_REF_TYPE,
  extractToolResultImages,
  externalizeToolResultImages,
} from './toolImages.js';

const inlineImage = (data: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data },
});
const refImage = (id: string, mediaType = 'image/png') => ({
  type: 'image',
  source: { type: TOOL_IMAGE_REF_TYPE, media_type: mediaType, id },
});
const textBlock = (text: string) => ({ type: 'text', text });

describe('extractToolResultImages', () => {
  it('returns nothing for non-array / text / JSON results', () => {
    expect(extractToolResultImages('a plain string')).toEqual([]);
    expect(extractToolResultImages({ ok: true })).toEqual([]);
    expect(extractToolResultImages(null)).toEqual([]);
    expect(extractToolResultImages([textBlock('hi')])).toEqual([]);
  });

  it('lifts inline base64 images in document order', () => {
    const images = extractToolResultImages([
      textBlock('here you go'),
      inlineImage('AAAA'),
      inlineImage('BBBB', 'image/jpeg'),
    ]);
    expect(images).toEqual([
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/jpeg', data: 'BBBB' },
    ]);
  });

  it('lifts externalized ref images (id, no data)', () => {
    expect(extractToolResultImages([refImage('deadbeef')])).toEqual([
      { mediaType: 'image/png', id: 'deadbeef' },
    ]);
  });

  it('handles a mix of inline and ref blocks', () => {
    expect(extractToolResultImages([inlineImage('AAAA'), refImage('cafe')])).toEqual([
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/png', id: 'cafe' },
    ]);
  });

  it('ignores image blocks missing data/id or media_type', () => {
    expect(
      extractToolResultImages([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'image' },
      ]),
    ).toEqual([]);
  });

  it('rejects unrenderable or active-content media types', async () => {
    const unsafe = inlineImage('PHN2Zz4=', 'image/svg+xml');
    expect(extractToolResultImages([unsafe])).toEqual([]);
    const store = vi.fn(async () => 'id');
    await expect(externalizeToolResultImages([unsafe], store)).resolves.toEqual({
      output: [unsafe],
      changed: false,
    });
    expect(store).not.toHaveBeenCalled();
  });
});

describe('externalizeToolResultImages', () => {
  it('replaces inline base64 with content-addressed refs, without mutating the input', async () => {
    const store = vi.fn(async (_mediaType: string, data: string) => `hash-${data}`);
    const output = [textBlock('caption'), inlineImage('AAAA'), inlineImage('BBBB', 'image/jpeg')];
    const before = JSON.parse(JSON.stringify(output));

    const result = await externalizeToolResultImages(output, store);

    expect(result.changed).toBe(true);
    expect(result.output).toEqual([
      textBlock('caption'),
      refImage('hash-AAAA'),
      refImage('hash-BBBB', 'image/jpeg'),
    ]);
    expect(store).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledWith('image/png', 'AAAA');
    // The original array/objects are untouched — the caller can still broadcast the
    // inline event to live clients.
    expect(output).toEqual(before);
  });

  it('is a no-op for results with no inline images (already-ref, text, non-array)', async () => {
    const store = vi.fn(async () => 'nope');
    for (const output of [
      [refImage('cafe')],
      [textBlock('just text')],
      'a string result',
      { ok: true },
    ]) {
      const result = await externalizeToolResultImages(output, store);
      expect(result.changed).toBe(false);
      expect(result.output).toBe(output);
    }
    expect(store).not.toHaveBeenCalled();
  });
});
