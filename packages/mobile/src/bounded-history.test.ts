import { describe, expect, it, vi } from 'vitest';
import { VerityClient } from './api.js';

const page = {
  contract: 'bounded-history-v1',
  kind: 'page',
  snapshotSeq: 42,
  beforeSeq: 42,
  hasMore: false,
  events: [{ seq: 42, event: { t: 'text', delta: '完整 🌍' } }],
};
function clientFor(body: unknown, status = 200) {
  const fetch = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  return { client: new VerityClient({ baseUrl: 'http://host', fetch }), fetch };
}
describe('bounded history contract', () => {
  it('uses only the versioned endpoint and propagates cursors and cancellation', async () => {
    const { client, fetch } = clientFor(page);
    const controller = new AbortController();
    expect(
      await client.getBoundedHistory('s', {
        snapshotSeq: 42,
        beforeSeq: 43,
        signal: controller.signal,
      }),
    ).toEqual(page);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      '/sessions/s/history/v1?beforeSeq=43&snapshotSeq=42',
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('requires an update on old Core without requesting legacy history', async () => {
    const { client, fetch } = clientFor({ error: 'Not Found' }, 404);
    await expect(client.getBoundedHistory('s')).rejects.toThrow('Update Core');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports a missing session without suggesting a Core update', async () => {
    const { client, fetch } = clientFor({ error: 'session s not found' }, 404);
    await expect(client.getBoundedHistory('s')).rejects.toThrow(
      'This session no longer exists. Return to the session list.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 503])('preserves HTTP %i errors', async (status) => {
    const { client, fetch } = clientFor({ error: 'server rejected history' }, status);
    await expect(client.getBoundedHistory('s')).rejects.toMatchObject({
      status,
      message: 'server rejected history',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves network failures', async () => {
    const failure = new TypeError('Network request failed');
    const { client, fetch } = clientFor(page);
    fetch.mockRejectedValueOnce(failure);
    await expect(client.getBoundedHistory('s')).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a response without explicit contract support', async () => {
    const { client } = clientFor({ events: page.events, hasMore: false });
    await expect(client.getBoundedHistory('s')).rejects.toThrow();
  });
  it('reports an update-required state for an older fallback HTML route', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<html>Old Core</html>'));
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    await expect(client.getBoundedHistory('s')).rejects.toThrow('Update Core');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails safely when Core does not support chunk recovery', async () => {
    const { client, fetch } = clientFor({
      contract: page.contract,
      kind: 'oversized-event',
      seq: 42,
      snapshotSeq: 42,
      requiredBytes: 300000,
      maxBytes: 262144,
    });
    await expect(client.getBoundedHistory('s')).rejects.toThrow('Update Core');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...page, beforeSeq: 41 },
    { ...page, snapshotSeq: 41 },
    { ...page, events: [], beforeSeq: null, hasMore: true },
    { ...page, events: [...page.events, ...page.events] },
  ])('rejects invalid continuation metadata', async (body) => {
    await expect(clientFor(body).client.getBoundedHistory('s')).rejects.toThrow(
      'invalid history cursors',
    );
  });
});

it('cancels stalled body reads and makes the deadline retryable', async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => new Promise(() => undefined) });
    const client = new VerityClient({ baseUrl: 'http://host', fetch });
    const result = expect(client.getBoundedHistory('s')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('propagates cancellation even when the transport ignores it', async () => {
  const fetch = vi.fn().mockReturnValue(new Promise(() => undefined));
  const client = new VerityClient({ baseUrl: 'http://host', fetch });
  const controller = new AbortController();
  const result = expect(
    client.getBoundedHistory('s', { signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  controller.abort();
  await result;
  expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
});

function chunkedClient(overrides: Record<string, unknown> = {}) {
  const recovered = {
    ...page,
    hasMore: true,
    events: [{ seq: 42, ts: 1234, event: { t: 'text', delta: '\u0000🌍界"\\'.repeat(40_000) } }],
  };
  const serialized = JSON.stringify(recovered);
  const fetch = vi.fn().mockImplementation(async (url: string) => {
    const offsetParam = new URL(url).searchParams.get('eventOffset');
    const body =
      offsetParam === null
        ? {
            contract: page.contract,
            kind: 'oversized-event',
            seq: 42,
            snapshotSeq: 42,
            requiredBytes: new TextEncoder().encode(serialized).byteLength,
            maxBytes: 262144,
          }
        : {
            contract: page.contract,
            kind: 'event-chunk',
            seq: 42,
            snapshotSeq: 42,
            offset: Number(offsetParam),
            totalChars: serialized.length,
            data: serialized.slice(Number(offsetParam), Number(offsetParam) + 16001),
            ...overrides,
          };
    return new Response(JSON.stringify(body));
  });
  return { client: new VerityClient({ baseUrl: 'http://host', fetch }), fetch, recovered };
}

it('reconstructs oversized events losslessly before advancing history', async () => {
  const { client, fetch, recovered } = chunkedClient();
  expect(await client.getBoundedHistory('s', { beforeSeq: 90, snapshotSeq: 42 })).toEqual(
    recovered,
  );
  expect(fetch.mock.calls.length).toBeGreaterThan(2);
  for (const [url] of fetch.mock.calls.slice(1)) {
    const params = new URL(String(url)).searchParams;
    expect(params.get('beforeSeq')).toBe('43');
    expect(params.get('snapshotSeq')).toBe('42');
  }
});
it.each([{ offset: 1 }, { seq: 41 }, { snapshotSeq: 43 }, { totalChars: 1 }, { data: '' }])(
  'rejects inconsistent chunks without returning partial events: %j',
  async (override) => {
    const { client } = chunkedClient(override);
    await expect(client.getBoundedHistory('s')).rejects.toThrow();
  },
);
it('cancels a chunk transfer with the original request signal', async () => {
  const { client, fetch } = chunkedClient();
  const controller = new AbortController();
  fetch.mockImplementationOnce(fetch.getMockImplementation()!).mockImplementationOnce(() => {
    queueMicrotask(() => controller.abort());
    return new Promise(() => undefined);
  });
  await expect(client.getBoundedHistory('s', { signal: controller.signal })).rejects.toThrow(
    'cancelled',
  );
});

it('keeps a single deadline across stalled chunk requests', async () => {
  vi.useFakeTimers();
  try {
    const { client, fetch } = chunkedClient();
    fetch
      .mockImplementationOnce(fetch.getMockImplementation()!)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const result = expect(client.getBoundedHistory('s')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
