import Fastify from 'fastify';
import type { SessionRecord } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';
import { branchSvc, bus, conductor, ctx } from './server-fixture.test-helper.js';
import type { buildServer } from './server.js';
import { createServerSessionOverview } from './server-session-overview.js';

type Deps = Parameters<typeof buildServer>[0];

/** The session overview with only what its branch cache needs. */
function overview(onBranchChange: (worktree: string) => void) {
  const app = Fastify();
  const sessionOverview = createServerSessionOverview({
    conductor,
    deps: {
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Deps['branches']>,
    },
    app,
    resources: { invalidate: () => undefined },
    reconcileSessionRepairs: async () => undefined,
    sessionsBeingReaped: new Set(),
    maybeDispatchPrRepairTurns: (() => undefined) as never,
    pushRouter: undefined,
    pushFirePoints: undefined,
    describePushSession: (() => undefined) as never,
    vulnerabilitySessions: { attention: () => [] } as never,
    onBranchChange,
  });
  return { app, ...sessionOverview };
}

async function session(): Promise<SessionRecord> {
  await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
  return (await ctx.store.getSession('s1'))!;
}

describe('branch changes reach the session row', () => {
  // The branch moves without any hint: a checkout by the agent or in the
  // terminal. Unless the cache reports what its reads find, Home and the open
  // session keep the old branch until something else changes the row.
  it('reports a branch other than the one announced last, whichever read found it', async () => {
    const changed = vi.fn();
    const o = overview(changed);
    const s = await session();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await o.refreshBranch(s);
      expect(changed).toHaveBeenCalledWith('/wt/s1');

      changed.mockClear();
      await o.refreshBranch(s);
      expect(changed).not.toHaveBeenCalled();

      // An invalidation empties the cache; reading the same branch again is
      // still no change, or every tool call would publish a row.
      o.invalidateBranchCache('/wt/s1');
      await o.currentBranchCached(branchSvc as never, '/wt/s1');
      expect(changed).not.toHaveBeenCalled();

      branchSvc.current.mockResolvedValue('agent/self-checkout');
      await o.refreshBranch(s);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await o.currentBranchCached(branchSvc as never, '/wt/s1')).toBe('agent/self-checkout');
    } finally {
      await o.app.close();
    }
  });

  it('reads past the cache age, and reports no empty answer', async () => {
    const changed = vi.fn();
    const o = overview(changed);
    const s = await session();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await o.currentBranchCached(branchSvc as never, '/wt/s1');
      branchSvc.current.mockResolvedValue('feat/b');
      // The cache would answer 'feat/a' for its whole age; the refresh asks git.
      await o.refreshBranch(s);
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledTimes(2);

      changed.mockClear();
      branchSvc.current.mockResolvedValue('');
      await o.refreshBranch(s);
      expect(changed).not.toHaveBeenCalled();

      // Back from a detached HEAD: the row showed no branch meanwhile.
      branchSvc.current.mockResolvedValue('feat/b');
      await o.refreshBranch(s);
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      await o.app.close();
    }
  });
});
