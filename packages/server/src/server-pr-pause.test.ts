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

const failing = {
  number: 119,
  title: 'PR',
  url: 'https://example.test/119',
  phase: 'open' as const,
  headSha: 'sha',
  pipeline: 'failure' as const,
  mergeable: true,
  checks: { completed: 1, total: 1, failed: 1, successful: 0, pending: 0 },
};
async function setup(state: 'active' | 'sleeping' | 'absent') {
  await createExistingSession('s1');
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state,
  });
  await ctx.store.setSessionProject('s1', 'p1');
  const read = vi.fn<
    () => Promise<typeof failing | (Omit<typeof failing, 'phase'> & { phase: 'closed' })>
  >(async () => ({ ...failing, phase: 'closed' }));
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
    branchPrStatus: read,
    pullRequestRepairPollMs: 10,
  });
  return { server, read };
}
it('does not poll a paused project but permits a manual branch status read without repairing', async () => {
  const { server, read } = await setup('absent');
  try {
    await server.ready();
    await new Promise((done) => setTimeout(done, 80));
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValue(failing);
    await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
    expect(read).toHaveBeenCalled();
    expect(dispatchTurnWhenIdle).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
it.each(['active', 'sleeping'] as const)('keeps %s projects monitored', async (state) => {
  const { server, read } = await setup(state);
  try {
    await server.ready();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
  } finally {
    await server.close();
  }
});
it('reloads a closed PR after pause and resume rather than retaining its five-minute cache', async () => {
  const { server, read } = await setup('active');
  try {
    await server.ready();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await ctx.store.updateProjectState('p1', 'absent');
    await new Promise((done) => setTimeout(done, 60));
    read.mockClear();
    await ctx.store.updateProjectState('p1', 'active');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  } finally {
    await server.close();
  }
});
it('drops a deferred repair when the project is paused before the session becomes idle', async () => {
  const { server } = await setup('active');
  let deferred: (() => Promise<void>) | undefined;
  runWhenIdle.mockImplementation(async (_id, fn) => {
    deferred = fn;
  });
  // The explicit foreground read still schedules repairs for active projects.
  const depsRead = vi.fn(async () => failing);
  await server.close();
  const repairServer = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
    branchPrStatus: depsRead,
  });
  try {
    await repairServer.inject({ method: 'GET', url: '/sessions/s1/branches' });
    expect(deferred).toBeDefined();
    depsRead.mockClear();
    await ctx.store.updateProjectState('p1', 'absent');
    await deferred!();
    expect(depsRead).not.toHaveBeenCalled();
    expect(dispatchTurnWhenIdle).not.toHaveBeenCalled();
  } finally {
    await repairServer.close();
  }
});

it('rejects repair admission if pause happens after the idle callback has prepared it', async () => {
  await createExistingSession('s1');
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.setSessionProject('s1', 'p1');
  const read = vi.fn(async () => failing);
  let validated = false;
  dispatchTurnWhenIdle.mockImplementation(async (_id, _prompt, _opts, options) => {
    await ctx.store.updateProjectState('p1', 'absent');
    read.mockClear();
    const validate = (
      options as {
        validateSession: (
          session: NonNullable<Awaited<ReturnType<typeof ctx.store.getSession>>>,
        ) => Promise<boolean>;
      }
    ).validateSession;
    expect(await validate((await ctx.store.getSession('s1'))!)).toBe(false);
    validated = true;
    expect(read).not.toHaveBeenCalled();
    return { accepted: false };
  });
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
    branchPrStatus: read,
  });
  try {
    await server.inject({ method: 'GET', url: '/sessions/s1/branches' });
    expect(validated).toBe(true);
    expect(await ctx.store.repairs.reservedDispatches()).toHaveLength(0);
  } finally {
    await server.close();
  }
});

it('does not start queued overview PR reads after a project is paused', async () => {
  await createExistingSession('s1');
  await createExistingSession('s2');
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.setSessionProject('s1', 'p1');
  await ctx.store.setSessionProject('s2', 'p1');
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const read = vi.fn(async () => {
    await blocked;
    return { ...failing, phase: 'closed' as const };
  });
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
    branchPrStatus: read,
  });
  try {
    await server.inject({ method: 'GET', url: '/sessions' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await ctx.store.updateProjectState('p1', 'absent');
    release();
    await new Promise((done) => setTimeout(done, 80));
    expect(read).toHaveBeenCalledTimes(1);
    expect(dispatchTurnWhenIdle).not.toHaveBeenCalled();
  } finally {
    release();
    await server.close();
  }
});
