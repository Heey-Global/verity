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

it('addresses requests to the person a turn runs for, and secret prompts to Code holders', async () => {
  // One shared load serves everyone; whom a request is for must still be decided
  // per requester, or a member's Home fills with every colleague's questions.
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    const user = request.headers['x-user'];
    if (typeof user === 'string') request.localUserId = user;
  });
  const summaries = [
    // Mara's turn asks for a secret she cannot allow, and asks a question.
    {
      sessionId: 'turn',
      projectId: 'p',
      requestInitiator: 'mara',
      pendingPermissions: ['secret', 'bash'],
      pendingPermissionRequests: [
        { toolUseId: 'secret', tool: 'mcp__verity__verity_secret_run', riskClass: 'ask' },
        { toolUseId: 'bash', tool: 'Bash', riskClass: 'ask' },
      ],
    },
    // No turn names anyone: the session's creator owns its requests.
    { sessionId: 'idle', projectId: 'p', pendingPermissions: [] },
  ] as unknown as SessionSummary[];
  const hasProjectPermission = vi.fn(
    async (user: string, _project: string, permission: string) =>
      permission === 'code' && user === 'alex',
  );
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [],
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summarizeSessions: async () => summaries.map((summary) => ({ ...summary })),
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
    requestAddressing: {
      store: {
        sessionPeople: { owners: async () => new Map([['idle', 'alex']]) } as never,
        isActiveAdministrator: async () => false,
        hasProjectPermission,
      },
    },
  });
  const read = async (user?: string) => {
    const result = await app.inject({
      url: '/sessions',
      ...(user === undefined ? {} : { headers: { 'x-user': user } }),
    });
    return Object.fromEntries(
      (result.json() as SessionSummary[]).map((s) => [
        s.sessionId,
        {
          session: s.addressedToViewer,
          requests: s.pendingPermissionRequests?.map((r) => r.addressedToViewer),
          initiator: s.requestInitiator,
        },
      ]),
    );
  };
  try {
    expect(await read('mara')).toEqual({
      turn: { session: true, requests: [false, true], initiator: undefined },
      idle: { session: false, requests: undefined, initiator: undefined },
    });
    expect(await read('alex')).toEqual({
      turn: { session: false, requests: [true, false], initiator: undefined },
      idle: { session: true, requests: undefined, initiator: undefined },
    });
    // Without accounts there is one operator, and nothing is narrowed.
    expect(await read()).toEqual({
      turn: { session: undefined, requests: [undefined, undefined], initiator: undefined },
      idle: { session: undefined, requests: undefined, initiator: undefined },
    });
  } finally {
    await app.close();
  }
});
