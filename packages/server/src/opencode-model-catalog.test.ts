import { describe, expect, it, vi } from 'vitest';
import { fetchOpenCodeModels } from './opencode-model-catalog.js';

const catalogFetch = (body: unknown) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));

describe('fetchOpenCodeModels', () => {
  it('discovers all IDs in provider order and deduplicates them', async () => {
    const fetchImpl = catalogFetch({ data: [{ id: 'org/a' }, { id: 'b' }, { id: 'org/a' }] });
    await expect(
      fetchOpenCodeModels('https://provider.test/v1', 'secret', fetchImpl),
    ).resolves.toEqual(['org/a', 'b']);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toEqual(new URL('https://provider.test/v1/models'));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
    // Following a provider redirect would forward the discovery request outside its configured origin.
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts an empty catalog and an existing trailing slash', async () => {
    const fetchImpl = catalogFetch({ data: [] });
    await expect(
      fetchOpenCodeModels('https://provider.test/v1/', 'secret', fetchImpl),
    ).resolves.toEqual([]);
    expect(fetchImpl.mock.calls[0]![0]).toEqual(new URL('https://provider.test/v1/models'));
  });

  it.each([{}, { data: null }, { data: [{}] }, { data: [{ id: '' }] }, { data: [{ id: 'a\nb' }] }])(
    'rejects malformed catalogs %j',
    async (body) => {
      await expect(
        fetchOpenCodeModels('https://provider.test/v1', 'secret', catalogFetch(body)),
      ).rejects.toThrow('invalid model catalog');
    },
  );

  it.each([302, 401, 500])('reports HTTP %i without exposing the response body', async (status) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret upstream details', { status }));
    await expect(
      fetchOpenCodeModels('https://provider.test/v1', 'secret', fetchImpl),
    ).rejects.toThrow(`HTTP ${String(status)}`);
  });

  it('sanitizes transport errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret'));
    await expect(
      fetchOpenCodeModels('https://provider.test/v1', 'secret', fetchImpl),
    ).rejects.toThrow('Check the API base URL and connectivity.');
  });

  it('bounds the response size', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(
      fetchOpenCodeModels('https://provider.test/v1', 'secret', fetchImpl),
    ).rejects.toThrow('invalid model catalog');
  });

  it('rejects insecure endpoints before sending credentials', async () => {
    const fetchImpl = catalogFetch({ data: [] });
    await expect(
      fetchOpenCodeModels('http://provider.test/v1', 'secret', fetchImpl),
    ).rejects.toThrow('upstream URL is invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
