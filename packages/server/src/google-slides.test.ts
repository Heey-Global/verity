import { describe, expect, it } from 'vitest';

import type { GoogleFetch, GoogleHttpResponse } from './google-drive.js';
import {
  GoogleSlidesError,
  getSlidesPresentation,
  slidesRequestsAreSupported,
  slidesRequestsNeedRevision,
  updateSlidesPresentation,
} from './google-slides.js';

function response(body: unknown, status = 200): GoogleHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

describe('Google Slides client', () => {
  it('guards offset and observed-state writes without serializing additive requests', () => {
    expect(slidesRequestsNeedRevision([{ insertText: { objectId: 'box', text: 'hello' } }])).toBe(
      false,
    );
    expect(
      slidesRequestsNeedRevision([
        { insertText: { objectId: 'box', insertionIndex: 4, text: 'hello' } },
      ]),
    ).toBe(true);
    expect(
      slidesRequestsNeedRevision([
        { updateTextStyle: { textRange: { type: 'FIXED_RANGE', startIndex: 1, endIndex: 2 } } },
      ]),
    ).toBe(true);
    expect(slidesRequestsNeedRevision([{ updatePageProperties: { objectId: 'slide' } }])).toBe(
      true,
    );
    expect(slidesRequestsNeedRevision([{ createSlide: {} }])).toBe(false);
    expect(slidesRequestsNeedRevision([{ createSlide: { insertionIndex: 2 } }])).toBe(true);
  });

  it('keeps image insertion on the managed upload path', () => {
    expect(slidesRequestsAreSupported([{ insertText: { objectId: 'box', text: 'hello' } }])).toBe(
      true,
    );
    expect(
      slidesRequestsAreSupported([{ createImage: { url: 'https://example.com/a.png' } }]),
    ).toBe(false);
    expect(slidesRequestsAreSupported([{ createShape: {}, deleteObject: {} }])).toBe(false);
  });

  it('reads only the metadata needed to assign a deck', async () => {
    const calls: string[] = [];
    const fetch: GoogleFetch = (url) => {
      calls.push(url);
      return Promise.resolve(
        response({
          presentationId: 'deck-1',
          title: 'Q3 review',
          revisionId: 'rev-1',
          slides: [{ objectId: 'slide-1' }],
        }),
      );
    };
    await expect(getSlidesPresentation('token', 'deck-1', { fetch })).resolves.toEqual({
      presentationId: 'deck-1',
      title: 'Q3 review',
      revisionId: 'rev-1',
      slideIds: ['slide-1'],
    });
    expect(calls[0]).toContain('fields=presentationId,title,revisionId,slides.objectId');
  });

  it('sends requiredRevisionId with a guarded batch', async () => {
    let body = '';
    const fetch: GoogleFetch = (_url, init) => {
      body = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(
        response({ replies: [], writeControl: { requiredRevisionId: 'rev-2' } }),
      );
    };
    await updateSlidesPresentation('token', 'deck-1', [{ deleteText: {} }], 'rev-1', {
      fetch,
    });
    expect(JSON.parse(body)).toEqual({
      requests: [{ deleteText: {} }],
      writeControl: { requiredRevisionId: 'rev-1' },
    });
  });

  it('guards fixed-range paragraph bullet changes', () => {
    expect(
      slidesRequestsNeedRevision([
        {
          createParagraphBullets: {
            objectId: 'shape-1',
            textRange: { type: 'FIXED_RANGE', startIndex: 2, endIndex: 8 },
          },
        },
      ]),
    ).toBe(true);
  });

  it('redacts Google error bodies to a stable reason', async () => {
    const fetch: GoogleFetch = () =>
      Promise.resolve(
        response({ error: { status: 'PERMISSION_DENIED', message: 'private detail' } }, 403),
      );
    await expect(getSlidesPresentation('token', 'deck-1', { fetch })).rejects.toMatchObject({
      name: 'GoogleSlidesError',
      reason: 'http_403_PERMISSIONDENIED',
    } satisfies Partial<GoogleSlidesError>);
  });
});
