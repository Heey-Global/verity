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
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
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
  it('surfaces an oversized event without advancing or retrying', async () => {
    const { client, fetch } = clientFor({
      contract: page.contract,
      kind: 'oversized-event',
      seq: 42,
      snapshotSeq: 42,
      requiredBytes: 300000,
      maxBytes: 262144,
    });
    await expect(client.getBoundedHistory('s')).rejects.toThrow('No events were skipped');
    expect(fetch).toHaveBeenCalledTimes(1);
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
