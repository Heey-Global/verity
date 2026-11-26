import { expect, it, vi } from 'vitest';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
  dispatchTurnWhenIdle,
  runWhenIdle,
} from './server-fixture.test-helper.js';
import { buildServer, type ServerDeps } from './server.js';

const failingPr = () => ({
  number: 119,
  title: 'Session PR',
  url: 'https://example.test/pr/119',
  phase: 'open' as const,
  headSha: 'new-sha',
  pipeline: 'failure' as const,
  mergeable: true,
  mergeState: 'clean' as const,
  checks: { completed: 1, total: 1, failed: 1, successful: 0, pending: 0 },
});
const serverDeps = () => ({
  eventStore: ctx.store,
  bus,
  conductor,
  branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
  branchPrStatus: vi.fn(async () => failingPr()),
});

it('returns branch metadata while repair reconciliation is waiting', async () => {
  await createExistingSession('s1');
  branchSvc.current.mockResolvedValue('feature');
  branchSvc.switchable.mockResolvedValue(['main']);
  let releaseRepair!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseRepair = resolve;
  });
  runWhenIdle.mockImplementation(async () => pending);
  const server = buildServer(serverDeps());
  const read = server.inject({ method: 'GET', url: '/sessions/s1/branches' }).then((res) => res);
  try {
    await vi.waitFor(() => expect(runWhenIdle).toHaveBeenCalled());
    let response: Awaited<typeof read> | undefined;
    void read.then((result) => {
      response = result;
    });
    await vi.waitFor(() => expect(response?.statusCode).toBe(200));
    expect(response?.json()).toMatchObject({
      current: 'feature',
      switchable: ['main'],
      currentPr: 119,
    });
    expect((await server.inject({ url: '/sessions/s1/branches' })).statusCode).toBe(200);
    expect(runWhenIdle).toHaveBeenCalledTimes(1);
  } finally {
    releaseRepair();
    await read;
    await server.close();
  }
});

it('returns branch metadata before a slow PR lookup and exposes the PR after it finishes', async () => {
  await createExistingSession('s1');
  branchSvc.current.mockResolvedValue('feature');
  branchSvc.switchable.mockResolvedValue(['main']);
  let releaseLookup!: (status: ReturnType<typeof failingPr>) => void;
  const pending = new Promise<ReturnType<typeof failingPr>>((resolve) => {
    releaseLookup = resolve;
  });
  const branchPrStatus = vi.fn(() => pending);
  const server = buildServer({ ...serverDeps(), branchPrStatus });
  const url = '/sessions/s1/branches';
  const read = server.inject({ url }).then((res) => res);
  try {
    let first: Awaited<typeof read> | undefined;
    void read.then((response) => {
      first = response;
    });
    await vi.waitFor(() => expect(first?.statusCode).toBe(200), { timeout: 2_000 });
    expect(first?.json()).toMatchObject({ current: 'feature', switchable: ['main'] });
    expect(first?.json()).not.toHaveProperty('currentPr');
    expect(branchPrStatus).toHaveBeenCalledTimes(1);

    releaseLookup(failingPr());
    const refreshed = await server.inject({ url });
    expect(refreshed.json()).toMatchObject({ current: 'feature', currentPr: 119 });
  } finally {
    releaseLookup(failingPr());
    await read;
    await server.close();
  }
});

it('marks cached checks and mergeability as unknown during a slow PR refresh', async () => {
  await createExistingSession('s1');
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.setSessionProject('s1', 'p1');
  branchSvc.current.mockResolvedValue('feature');
  branchSvc.switchable.mockResolvedValue(['main']);
  let now = 0;
  let releaseLookup!: (status: ReturnType<typeof failingPr>) => void;
  const pending = new Promise<ReturnType<typeof failingPr>>((resolve) => {
    releaseLookup = resolve;
  });
  const branchPrStatus = vi
    .fn()
    .mockResolvedValueOnce({
      ...failingPr(),
      pipeline: 'success',
      checks: { completed: 1, total: 1, failed: 0, successful: 1, pending: 0 },
    })
    .mockReturnValue(pending);
  const server = buildServer({
    ...serverDeps(),
    branchPrStatus,
    pullRequestCacheNow: () => now,
    projectPullRequests: {
      list: vi.fn().mockResolvedValue({ webUrl: '', pulls: [] }),
      status: vi.fn().mockResolvedValue(null),
      merge: vi.fn().mockResolvedValue(false),
    },
  });
  const url = '/sessions/s1/branches';
  try {
    expect((await server.inject({ url })).json()).toMatchObject({
      pullRequest: { pipeline: 'success', mergeable: true },
      pullRequests: [{ number: 119, pipeline: 'success', mergeable: true }],
    });
    now = 60_000;
    expect((await server.inject({ url })).json()).toMatchObject({
      pullRequest: { number: 119, pipeline: 'unknown', mergeable: null, observationFailed: true },
      pullRequests: [
        { number: 119, pipeline: 'unknown', mergeable: null, observationFailed: true },
      ],
    });
  } finally {
    releaseLookup(failingPr());
    await server.close();
  }
});

it('recovers a completed repair after task updates hide its completion from the projection tail', async () => {
  await createExistingSession('s1');
  await ctx.store.upsertProject({
    id: 'origin',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.setSessionProject('s1', 'origin');
  await ctx.store.repairs.registerSessionOrigin('origin', 'pr:119', 's1');
  const incident = await ctx.store.repairs.observe('origin', 'pr:119', 'old-sha', '{}');
  const claim = await ctx.store.repairs.claimSessionRepair(incident.id, 's1', 'ci:old-sha');
  await ctx.store.admitBackgroundDispatch(claim!.dispatch_id!, 's1', {
    t: 'prompt',
    text: 'repair',
  });
  const completed = await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
  await ctx.store.clearRunningTurn('s1');
  // Task lifecycle traffic can outlive the turn. A fixed projection tail loses
  // the only completion and leaves the old claim blocking every later revision.
  for (let i = 0; i < 25; i++)
    await ctx.store.appendEvent('s1', { t: 'task', id: `background-${i}`, phase: 'ended' });
  expect(await ctx.store.latestSessionTurnControlEvent('s1', completed.seq - 1)).toMatchObject({
    seq: completed.seq,
    event: { t: 'status', state: 'completed' },
  });
  expect(await ctx.store.latestSessionTurnControlEvent('s1', completed.seq)).toBeUndefined();
  dispatchTurnWhenIdle.mockImplementation(async (id, text, _opts, options) => {
    const opts = options as {
      durableDispatchId: string;
      validateSession: (
        session: NonNullable<Awaited<ReturnType<typeof ctx.store.getSession>>>,
      ) => Promise<boolean>;
    };
    if (!(await opts.validateSession((await ctx.store.getSession(id))!)))
      return { accepted: false };
    return {
      accepted: !!(await ctx.store.admitBackgroundDispatch(opts.durableDispatchId, id, {
        t: 'prompt',
        text,
      })),
    };
  });
  const deps = serverDeps();
  const server = buildServer({ ...deps, pullRequestRepairPollMs: 20 });
  try {
    await server.ready();
    await vi.waitFor(() => expect(dispatchTurnWhenIdle).toHaveBeenCalledTimes(1));
    await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
    expect(dispatchTurnWhenIdle).toHaveBeenCalledTimes(1);
    expect(
      (await ctx.store.repairs.incidents('origin')).find((row) => row.revision === 'old-sha')
        ?.owner_session_id,
    ).toBeNull();
    expect(await ctx.store.repairs.budgetUsed('origin', 'pr:119')).toBe(2);
  } finally {
    await server.close();
  }
});

it.each(['active', 'implemented'] as const)(
  'rechecks planning %s when a deferred repair reaches an idle session',
  async (planning) => {
    await createExistingSession('s1');
    if (planning === 'implemented') await ctx.store.startSessionPlanning('s1');
    let deferred: (() => Promise<void>) | undefined;
    runWhenIdle.mockImplementation(async (_id, fn) => {
      deferred = fn;
    });
    const server = buildServer(serverDeps());
    try {
      await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
      expect(deferred).toBeDefined();
      await ctx.store.setSessionPlanning('s1', planning);
      await deferred!();
      expect(dispatchTurnWhenIdle).toHaveBeenCalledTimes(planning === 'active' ? 0 : 1);
    } finally {
      await server.close();
    }
  },
);
