import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { branchSvc, bus, conductor, ctx } from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

describe('the session branch label is cached between activity polls', () => {
  const cachedBranchServer = (): FastifyInstance =>
    buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
    });

  it('reads git once across polls and again after an operator switch', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = cachedBranchServer();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      const first = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(first.json()).toMatchObject({ branch: 'feat/a' });

      // A second poll 1.5 s later must not spawn another git/docker call.
      branchSvc.current.mockResolvedValue('feat/b');
      const second = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(second.json()).toMatchObject({ branch: 'feat/a' });
      expect(branchSvc.current).toHaveBeenCalledTimes(1);

      // The operator's own switch is visible to the server, so it drops the label
      // rather than showing the old branch until the TTL runs out.
      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);
      const third = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(third.json()).toMatchObject({ branch: 'feat/b' });
    } finally {
      await server.close();
    }
  });

  it('converges on a branch changed from inside the sandbox once the TTL passes', async () => {
    // The case no invalidation hook can see: the agent checks out its own work
    // inside the worktree. A cache that only ever refreshed on the switch route
    // would pin the header to a branch the session left — the TTL is the only
    // thing that makes the label converge, so it is the thing worth guarding.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchCacheTtlMs: 1,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      const first = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(first.json()).toMatchObject({ branch: 'feat/a' });

      branchSvc.current.mockResolvedValue('agent/self-checkout');
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Stale-while-revalidate: this poll still answers 'feat/a' and refreshes
      // behind the response, so the NEXT poll is the one that shows the change.
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      const settled = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(settled.json()).toMatchObject({ branch: 'agent/self-checkout' });
    } finally {
      await server.close();
    }
  });

  it('discards a refresh that was already reading git when the operator switched', async () => {
    // The refresh read git BEFORE the switch, so its answer is the branch the
    // session just left. Writing it back after the invalidation would pin the
    // header to the old branch for a full TTL — the cache undoing the one
    // invalidation that exists to correct it, and only under the interleaving
    // nobody reproduces by hand.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchCacheTtlMs: 1,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      // Hold the next git read open so the switch below lands mid-flight.
      let answerHeldRead: (branch: string) => void = () => {};
      branchSvc.current.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          answerHeldRead = resolve;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);

      // Only now does the held read answer — with the pre-switch branch.
      answerHeldRead('feat/a');
      await new Promise((resolve) => setImmediate(resolve));

      branchSvc.current.mockResolvedValue('feat/b');
      const after = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(after.json()).toMatchObject({ branch: 'feat/b' });
    } finally {
      await server.close();
    }
  });

  it('discards a COLD read that was already reading git when the operator switched', async () => {
    // The same race one step earlier, and the one a `delete` cannot cover: on a
    // session's first poll there is no cache entry for the invalidation to drop,
    // so an undisownable cold read lands the pre-switch branch on the empty slot
    // and pins the header there for a full TTL — with no second git call due for
    // ten seconds to correct it.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = cachedBranchServer();
    try {
      let answerHeldRead: (branch: string) => void = () => {};
      branchSvc.current.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          answerHeldRead = resolve;
        }),
      );
      // Left unawaited on purpose: a cold read blocks its own response, so the
      // switch below has to be issued while this poll is still inside git.
      const coldPoll = server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(1));

      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);

      // The old read is still unresolved. A poll in this window must not join
      // it merely because its token remains in the single-flight map.
      branchSvc.current.mockResolvedValueOnce('feat/b');
      const afterSwitch = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(afterSwitch.json()).toMatchObject({ branch: 'feat/b' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);

      answerHeldRead('feat/a');
      // The poll that asked still hears what git said — it is the CACHE that must
      // not keep the answer.
      expect((await coldPoll).json()).toMatchObject({ branch: 'feat/a' });

      branchSvc.current.mockResolvedValue('feat/b');
      const after = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(after.json()).toMatchObject({ branch: 'feat/b' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it('paces a failing refresh like a successful one', async () => {
    // A refresh that rejects must still advance the entry's clock. Otherwise the
    // first git failure turns the cache back into a per-poll git call — every
    // 1.5 s, per open session, against a worktree that is already unhappy.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      // The window has to outlast everything between the failed refresh settling
      // and the third request below — `vi.waitFor` polling included — on a loaded
      // machine running the whole suite in parallel. A tight window here does not
      // test the pacing harder, it just makes the guard flaky.
      branchCacheTtlMs: 1_000,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      branchSvc.current.mockRejectedValue(new Error('git boom'));
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      // Well inside the window the failed attempt just started: no third call,
      // and the last known good label is still what the header gets.
      const during = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
      expect(during.json()).toMatchObject({ branch: 'feat/a' });
    } finally {
      await server.close();
    }
  });

  it('drops the label of a worktree that no longer exists', async () => {
    // Keyed by worktree, so without eviction a long-lived server accumulates one
    // entry per session ever created — and a recreated worktree of the same path
    // would be answered from the deleted session's label for a whole TTL window.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    const server = cachedBranchServer();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      await ctx.store.deleteSession('s1');
      // The full list is where every live worktree is visible at once, so it is
      // where the eviction happens.
      await server.inject({ method: 'GET', url: '/sessions' });

      await ctx.store.createSession({ sessionId: 's3', worktree: '/wt/s1', model: 'm' });
      branchSvc.current.mockResolvedValue('feat/reused');
      const reused = await server.inject({ method: 'GET', url: '/sessions/s3/activity' });
      expect(reused.json()).toMatchObject({ branch: 'feat/reused' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });
});
