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
