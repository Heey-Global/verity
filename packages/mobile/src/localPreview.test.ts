import { describe, expect, it, vi } from 'vitest';
import { localPreviewReachable } from './localPreview.js';

describe('local preview reachability', () => {
  const share = { id: 'share-one', url: 'http://192.168.1.10:8100/' };
  it('requires the allocated edge identity rather than any open HTTP port', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ shareId: 'another-share' })));
    expect(await localPreviewReachable(share, fetcher)).toBe(false);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ shareId: share.id })));
    expect(await localPreviewReachable(share, fetcher)).toBe(true);
    const requestedUrl = fetcher.mock.calls[0]?.[0];
    expect(requestedUrl instanceof URL ? requestedUrl.href : requestedUrl).toBe(
      'http://192.168.1.10:8100/__verity/health',
    );
  });
  it('treats malformed responses and connection failures as unreachable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('not json'));
    expect(await localPreviewReachable(share, fetcher)).toBe(false);
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await localPreviewReachable(share, fetcher)).toBe(false);
  });
  it('bounds a probe that never connects', async () => {
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    expect(await localPreviewReachable(share, fetcher, 10)).toBe(false);
  });
});
