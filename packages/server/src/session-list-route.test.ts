import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerSessionListRoute } from './session-list-route.js';
import type { SessionSummary } from './server.js';

it('shares overlapping bare/envelope reads after authorization, then reads afresh', async () => {
  const app = Fastify();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const listSessions = vi.fn(async () => {
    started();
    await gate;
    return [];
  });
  const summarizeSessions = vi.fn(async () => [{ sessionId: 's1' }] as SessionSummary[]);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'allowed') return reply.code(401).send();
  });
  registerSessionListRoute(app, {
    store: {
      listSessions,
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
    },
    summarizeSessions,
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
  });
  try {
    const bare = app
      .inject({ url: '/sessions', headers: { authorization: 'allowed' } })
      .then((result) => result);
    await entered;
    const envelope = app
      .inject({ url: '/sessions?envelope=1', headers: { authorization: 'allowed' } })
      .then((result) => result);
    expect((await app.inject('/sessions')).statusCode).toBe(401);
    // Let the second authorized handler join the shared read before releasing it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([bare, envelope]);
    expect(a.json()).toEqual([{ sessionId: 's1', sortOrder: null }]);
    expect(b.json()).toEqual({ sessions: a.json(), sessionReordering: true });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(summarizeSessions).toHaveBeenCalledTimes(1);
    await app.inject({ url: '/sessions', headers: { authorization: 'allowed' } });
    expect(listSessions).toHaveBeenCalledTimes(2);
    listSessions.mockRejectedValueOnce(new Error('offline'));
    expect(
      (await app.inject({ url: '/sessions', headers: { authorization: 'allowed' } })).statusCode,
    ).toBe(500);
    expect(
      (await app.inject({ url: '/sessions', headers: { authorization: 'allowed' } })).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
