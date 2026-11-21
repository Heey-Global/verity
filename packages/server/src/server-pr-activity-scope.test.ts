import { describe, expect, it, vi } from 'vitest';
import type { PullRequestStatus } from './github.js';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
} from './server-fixture.test-helper.js';
import { buildServer, type ServerDeps } from './server.js';

const running: PullRequestStatus = {
  number: 7,
  title: 'Work in progress',
  url: 'https://example.test/pr/7',
  phase: 'open',
  pipeline: 'running',
  mergeable: null,
  checks: { completed: 0, total: 1, successful: 0, failed: 0, pending: 1 },
};

async function projectSession() {
  await createExistingSession('s1');
  await ctx.store.upsertProject({
    id: 'pr-project',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
  await ctx.store.setSessionProject('s1', 'pr-project');
  branchSvc.current.mockResolvedValue('feat/one');
}

const toolResult = (seq: number) =>
  bus.publish('s1', {
    seq,
    ts: Date.now(),
    event: { t: 'tool_result', id: `tool-${seq}`, output: 'done', isError: false },
  });

describe('PR status refresh after agent activity', () => {
  it('invalidates only the active session branches, not the whole repository', async () => {
    await projectSession();
    const invalidateProjectPrStatus = vi.fn<NonNullable<ServerDeps['invalidateProjectPrStatus']>>();
    const branchPrStatusForBranches = vi.fn(async () => running);
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: {
        ...branchSvc,
        sessionBranches: async () => ['feat/one', 'feat/two'],
      } as unknown as NonNullable<ServerDeps['branches']>,
      branchPrStatusForBranches,
      invalidateProjectPrStatus,
    });
    try {
      await server.inject('/sessions/s1/branches');
      await vi.waitFor(() => expect(branchPrStatusForBranches).toHaveBeenCalled());
      const before = invalidateProjectPrStatus.mock.calls.length;
      toolResult(1);
      await vi.waitFor(() =>
        expect(invalidateProjectPrStatus.mock.calls.at(-1)?.[1]).toBeDefined(),
      );
      const calls = invalidateProjectPrStatus.mock.calls.slice(before);
      // A project-wide invalidation on each tool call discarded every other session's
      // PR observation and re-read the entire repository. Only the background policy's
      // first sight of the session's project lifecycle may forget everything, once.
      expect(calls.at(-1)).toEqual(['pr-project', ['feat/one', 'feat/two']]);
      expect(calls.filter(([, branches]) => branches === undefined).length).toBeLessThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it('skips activity and background refreshes while the forge quota is reserved', async () => {
    await projectSession();
    let deferred = false;
    let now = 0;
    const deferBackgroundForgeReads = vi.fn(async () => deferred);
    const branchPrStatus = vi.fn(async () => running);
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
      branchPrStatus,
      deferBackgroundForgeReads,
      pullRequestRepairPollMs: 20,
      pullRequestCacheNow: () => now,
    });
    try {
      await server.ready();
      await vi.waitFor(() => expect(branchPrStatus).toHaveBeenCalled());
      deferred = true;
      // Every cached status is due again; only the quota reservation holds reads back.
      now += 600_000;
      const reads = branchPrStatus.mock.calls.length;
      const checks = deferBackgroundForgeReads.mock.calls.length;
      toolResult(1);
      await vi.waitFor(() =>
        expect(deferBackgroundForgeReads.mock.calls.length).toBeGreaterThan(checks + 3),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(branchPrStatus).toHaveBeenCalledTimes(reads);
      expect(deferBackgroundForgeReads).toHaveBeenCalledWith('pr-project');
    } finally {
      await server.close();
    }
  });
});
