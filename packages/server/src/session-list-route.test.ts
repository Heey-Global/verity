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
      viewState: { sessionViews: async () => new Map() } as never,
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
    expect(a.json()).toEqual([
      { sessionId: 's1', sortOrder: null, lastSeenEventCount: null, inboxDismissed: [] },
    ]);
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

it('gives each person their own read mark and dismissed items from one shared load', async () => {
  // The load is shared between concurrent readers. Writing the requester's state
  // into the shared summaries instead of copies would hand one person's read
  // marks to whoever asked at the same moment.
  const app = Fastify();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-user']);
  });
  const views = new Map([
    ['a', new Map([['s1', { lastSeenEventCount: 3, inboxDismissed: ['question:s1'] }]])],
    ['b', new Map()],
  ]);
  const listSessions = vi.fn(async () => {
    await gate;
    return [];
  });
  registerSessionListRoute(app, {
    store: {
      listSessions,
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async (user: string) => views.get(user)! } as never,
    },
    summarizeSessions: async () =>
      [{ sessionId: 's1', lastSeenEventCount: 9 }] as unknown as SessionSummary[],
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
  });
  try {
    const a = app.inject({ url: '/sessions', headers: { 'x-user': 'a' } });
    const b = app.inject({ url: '/sessions', headers: { 'x-user': 'b' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect((await a).json()[0]).toMatchObject({
      lastSeenEventCount: 3,
      inboxDismissed: ['question:s1'],
    });
    expect((await b).json()[0]).toMatchObject({ lastSeenEventCount: null, inboxDismissed: [] });
    expect(listSessions).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

it('marks a plan awaiting approval without sending its text', async () => {
  // Every device polls this list; a plan's text would ride along with each poll,
  // and an overview that lost the flag would stop marking the session.
  const app = Fastify();
  const plan = '1. Step\n'.repeat(500);
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [],
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summarizeSessions: async () =>
      [
        { sessionId: 'presented', planning: 'active', planningRevision: 2, planningPlan: plan },
        { sessionId: 'drafting', planning: 'active', planningRevision: 3, planningPlan: null },
        { sessionId: 'done', planning: 'implemented', planningRevision: 2, planningPlan: plan },
      ] as SessionSummary[],
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
  });
  try {
    const list = (await app.inject('/sessions')).json<Record<string, unknown>[]>();
    expect(list.map((summary) => summary.planningPresented)).toEqual([true, undefined, undefined]);
    for (const summary of list) expect(summary).not.toHaveProperty('planningPlan');
    expect(list[0]).toMatchObject({ planning: 'active', planningRevision: 2 });
  } finally {
    await app.close();
  }
});
