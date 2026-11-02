import { describe, expect, it, vi } from 'vitest';

import { VerityClient } from './api.js';

const summary = {
  operationId: 'op-1',
  kind: 'build',
  status: 'succeeded',
  startedAt: '2026-10-27T14:12:03.000Z',
  finishedAt: '2026-10-27T14:19:41.000Z',
  project: { id: 'p1', label: 'org/repo' },
  initiator: { kind: 'session', sessionId: 's1', name: 'Fix login' },
  imageId: 'sha256:3f9a',
  failedWrites: null,
};

function client(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(url);
    return respond(url);
  });
  return { calls, client: new VerityClient({ baseUrl: 'http://host', fetch }) };
}

describe('audit client', () => {
  it('sends the filters and parses operations', async () => {
    const { calls, client: c } = client(
      () =>
        new Response(
          JSON.stringify({ operations: [summary], nextBefore: null, oldestRecordedAt: null }),
        ),
    );
    const window = { since: '2026-10-27T00:00:00Z', until: '2026-10-28T00:00:00Z' };
    const list = await c.auditOperations({
      domain: 'builds',
      search: ' 3f9a ',
      limit: 20,
      ...window,
    });
    expect(list?.operations).toEqual([summary]);
    expect(calls[0]?.pathname).toBe('/audit/operations');
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
      ...window,
      domain: 'builds',
      q: '3f9a',
      limit: '20',
    });
  });

  // A member's device, or a Server without the trail, must hide the entry rather
  // than show an error screen.
  it.each([403, 404])('returns null when the trail is unavailable (%i)', async (status) => {
    const { client: c } = client(() => new Response(JSON.stringify({ error: 'nope' }), { status }));
    expect(await c.auditOperations()).toBeNull();
    expect(await c.auditHealth()).toBeNull();
  });

  // Server and app ship separately: one entry of a kind this app does not know must
  // not take the whole list down with it.
  it('skips entries of unknown kinds instead of failing the page', async () => {
    const { client: c } = client(
      () =>
        new Response(
          JSON.stringify({
            operations: [summary, { ...summary, operationId: 'op-2', kind: 'secret_used' }],
            nextBefore: null,
            oldestRecordedAt: null,
          }),
        ),
    );
    expect((await c.auditOperations())?.operations.map((o) => o.operationId)).toEqual(['op-1']);
  });

  it('reads one operation and the audit health', async () => {
    const { calls, client: c } = client((url) =>
      url.pathname === '/audit/health'
        ? new Response(JSON.stringify({ status: 'degraded', pendingFailedWrites: 3 }))
        : new Response(
            JSON.stringify({
              operation: {
                ...summary,
                server: { release: '4.57.3', generation: 14 },
                build: null,
                imageRef: null,
                gapWindow: null,
                events: [],
              },
            }),
          ),
    );
    expect((await c.auditOperation('op/1')).server.generation).toBe(14);
    expect(calls[0]?.pathname).toBe('/audit/operations/op%2F1');
    expect(await c.auditHealth()).toEqual({ status: 'degraded', pendingFailedWrites: 3 });
  });
});

it('requests individual event pages with their filters and preserves unknown event kinds', async () => {
  const event = {
    eventId: 'e1',
    operationId: 'op1',
    kind: 'future.kind',
    recordedAt: '2026-10-29T12:00:00Z',
    domain: 'builds',
    project: null,
    imageId: null,
    payload: {},
  };
  const { calls, client: c } = client(
    () =>
      new Response(JSON.stringify({ events: [event], nextBefore: 'next', oldestRecordedAt: null })),
  );
  expect(
    (
      await c.auditEvents({
        domain: 'builds',
        search: ' build ',
        before: 'cursor',
        limit: 1,
        since: '2026-10-29T00:00:00Z',
      })
    )?.events,
  ).toEqual([event]);
  expect(calls[0]?.pathname).toBe('/audit/events');
  expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
    domain: 'builds',
    q: 'build',
    before: 'cursor',
    limit: '1',
    since: '2026-10-29T00:00:00Z',
  });
});
