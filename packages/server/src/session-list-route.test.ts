import Fastify from 'fastify';
import { SESSION_SUMMARY_FIELDS } from '@verity/events';
import { sharedRow } from './live/summary-events.js';
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
    {
      sessionId: 'idle',
      projectId: 'p',
      pendingPermissions: [],
      openChoices: { question: 'Ship it?', options: [{ label: 'Yes' }] },
    },
    // Its turn ran for someone who has since left the project, and so did its
    // creator: the project creator answers.
    {
      sessionId: 'left',
      projectId: 'p',
      requestInitiator: 'gone',
      pendingPermissions: [],
      openChoices: { question: 'Which?', options: [{ label: 'A' }] },
    },
    // Nobody left to own it: general prompts are for everyone, a secret only for
    // whoever can allow it.
    {
      sessionId: 'orphan',
      projectId: 'p',
      requestInitiator: 'gone',
      pendingPermissions: ['secret', 'bash'],
      pendingPermissionRequests: [
        { toolUseId: 'secret', tool: 'mcp__verity__verity_secret_run', riskClass: 'ask' },
        { toolUseId: 'bash', tool: 'Bash', riskClass: 'ask' },
      ],
    },
  ] as unknown as SessionSummary[];
  const hasProjectPermission = vi.fn(async (user: string, _project: string, permission: string) =>
    permission === 'read' ? user === 'alex' || user === 'mara' : user === 'alex',
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
        sessionPeople: {
          owners: async () =>
            new Map([
              ['idle', ['alex']],
              // The creator left too; the project creator is next in line.
              ['left', ['gone-too', 'mara']],
            ]),
        } as never,
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
      result.json<SessionSummary[]>().map((s) => [
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
      left: { session: true, requests: undefined, initiator: undefined },
      orphan: { session: true, requests: [false, true], initiator: undefined },
    });
    expect(await read('alex')).toEqual({
      turn: { session: false, requests: [true, false], initiator: undefined },
      idle: { session: true, requests: undefined, initiator: undefined },
      left: { session: false, requests: undefined, initiator: undefined },
      orphan: { session: true, requests: [true, true], initiator: undefined },
    });
    // Without accounts there is one operator, and nothing is narrowed.
    expect(await read()).toEqual({
      turn: { session: undefined, requests: [undefined, undefined], initiator: undefined },
      idle: { session: undefined, requests: undefined, initiator: undefined },
      left: { session: undefined, requests: undefined, initiator: undefined },
      orphan: { session: undefined, requests: [undefined, undefined], initiator: undefined },
    });
  } finally {
    await app.close();
  }
});

it('keeps the list up and shows every request when a rights check fails', async () => {
  // Addressing only narrows Home. A failing rights query that took the list down
  // would leave every device without its sessions.
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.localUserId = 'mara';
  });
  // Alex's rights read fine, so the secret prompt goes to Code holders; reading
  // the requester's own rights then fails.
  const rights =
    (allowed: (permission?: string) => boolean) =>
    async (user: string, _project?: string, permission?: string): Promise<boolean> => {
      if (user === 'mara') throw new Error('offline');
      return allowed(permission);
    };
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [],
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summarizeSessions: async () =>
      [
        {
          sessionId: 'turn',
          projectId: 'p',
          requestInitiator: 'alex',
          pendingPermissions: ['secret'],
          pendingPermissionRequests: [
            { toolUseId: 'secret', tool: 'mcp__verity__verity_secret_run', riskClass: 'ask' },
          ],
        },
      ] as unknown as SessionSummary[],
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
    requestAddressing: {
      store: {
        sessionPeople: { owners: async () => new Map() } as never,
        isActiveAdministrator: rights(() => false),
        hasProjectPermission: rights((permission) => permission === 'read'),
      },
    },
  });
  try {
    const result = await app.inject({ url: '/sessions' });
    expect(result.statusCode).toBe(200);
    const [session] = result.json<SessionSummary[]>();
    expect(session?.addressedToViewer).toBe(false);
    // Unknown rights show the prompt rather than hide it from someone who may allow it.
    expect(session?.pendingPermissionRequests?.[0]?.addressedToViewer).toBe(true);
  } finally {
    await app.close();
  }
});

it('lists a submission for review to members with Code until one of them writes', async () => {
  // Every device polls this list: a submission addressed to everyone would keep
  // sitting on Home for colleagues after someone took the review on.
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-user']);
  });
  let writers: string[] = [];
  const submittedAt = new Date(1_000);
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [],
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summarizeSessions: async () =>
      [{ sessionId: 's1', projectId: 'p', pendingPermissions: [] }] as unknown as SessionSummary[],
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
    requestAddressing: {
      store: {
        sessionPeople: { owners: async () => new Map() } as never,
        isActiveAdministrator: async () => false,
        hasProjectPermission: async (user: string, _project: string, permission: string) =>
          permission === 'read' || user === 'alex' || user === 'kim',
      },
    },
    changeSubmissions: {
      store: {
        changeSubmissions: {
          open: async () =>
            new Map([
              [
                's1',
                {
                  sessionId: 's1',
                  submittedBy: 'mara',
                  submittedAt,
                  revision: null,
                  state: 'submitted',
                },
              ],
            ]),
          writersSince: async () => new Map([['s1', writers]]),
        } as never,
        isActiveAdministrator: async () => false,
        hasProjectPermission: async (user: string, _project: string, permission: string) =>
          permission === 'code' && (user === 'alex' || user === 'kim'),
        userDisplayNames: async () => new Map([['mara', 'Mara']]),
      },
    },
  });
  const read = async (user: string) => {
    const result = await app.inject({ url: '/sessions', headers: { 'x-user': user } });
    return result.json<SessionSummary[]>()[0]?.changeSubmission;
  };
  try {
    expect(await read('alex')).toMatchObject({
      status: 'waiting',
      submittedBy: { id: 'mara', name: 'Mara' },
      addressedToViewer: true,
    });
    expect((await read('kim'))?.addressedToViewer).toBe(true);
    expect((await read('mara'))?.addressedToViewer).toBe(false);
    writers = ['alex'];
    expect(await read('alex')).toMatchObject({ status: 'checking', addressedToViewer: true });
    expect((await read('kim'))?.addressedToViewer).toBe(false);
  } finally {
    await app.close();
  }
});

// A row taken after a session.summary was published must say so, or a view
// replays that older row over the newer read; one published while the read
// is computed may be newer than it, so the revision is the one at the start.
it('marks each row with the summary revision from before it was read', async () => {
  const app = Fastify();
  let revision = 5;
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [{ sessionId: 's1' }, { sessionId: 's2' }] as never,
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summaryRevision: (id) => (id === 's1' ? revision : undefined),
    summarizeSessions: async (sessions) => {
      // Published while the rows are being computed.
      revision = 6;
      return sessions.map(({ sessionId }) => ({ sessionId })) as unknown as SessionSummary[];
    },
    collectAttention: async () => [],
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
  });
  try {
    const rows = (await app.inject({ url: '/sessions' })).json<
      Array<{ sessionId: string; summaryRev?: number }>
    >();
    expect(rows.find((row) => row.sessionId === 's1')?.summaryRev).toBe(5);
    expect(rows.find((row) => row.sessionId === 's2')).not.toHaveProperty('summaryRev');
  } finally {
    await app.close();
  }
});

// `session.summary` carries the shared fields as `summarizeSessions` gives
// them, and a view drops one its row lacks. Were this route to add or change a
// shared field after summarizing, every event would undo it on Home.
it('leaves every field session.summary carries as summarizeSessions gives it', async () => {
  const app = Fastify();
  const summary: Record<string, unknown> = { sessionId: 's1', planningPlan: 'plan text' };
  for (const field of SESSION_SUMMARY_FIELDS) summary[field] = { marker: field };
  summary.planning = 'active';
  delete summary.planningPresented;
  registerSessionListRoute(app, {
    store: {
      listSessions: async () => [{ sessionId: 's1' }] as never,
      linkedSessionIds: async () => new Set(),
      sessionSortOrders: async () => new Map(),
      viewState: { sessionViews: async () => new Map() } as never,
    },
    summarizeSessions: async () => [{ ...summary }] as unknown as SessionSummary[],
    collectAttention: async () => [{ kind: 'server-level' }] as never,
    prunePrSummaryCache: () => {},
    pruneBranchCache: () => {},
  });
  try {
    const [listed] = (await app.inject({ url: '/sessions?envelope=1' })).json<{
      sessions: Record<string, unknown>[];
    }>().sessions;
    const row = sharedRow(summary as unknown as SessionSummary);
    for (const field of SESSION_SUMMARY_FIELDS)
      expect([field, listed![field]]).toEqual([field, row[field]]);
  } finally {
    await app.close();
  }
});
