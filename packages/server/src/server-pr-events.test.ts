import { describe, expect, it, vi } from 'vitest';
import type { PullRequestStatus } from './forge-provider.js';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

const statuses = vi.hoisted(() => [] as { sessionId: string; status: unknown }[]);
vi.mock('./live/pr-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./live/pr-events.js')>();
  return {
    createPrEvents: (...args: Parameters<typeof actual.createPrEvents>) => {
      const publish = actual.createPrEvents(...args);
      return (...call: Parameters<typeof publish>) => {
        statuses.push({ sessionId: call[0].sessionId, status: call[1] });
        publish(...call);
      };
    },
  };
});

const green: PullRequestStatus = {
  number: 7,
  title: 'Add live status',
  url: 'https://example.test/pr/7',
  phase: 'open',
  pipeline: 'success',
  mergeable: true,
  checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
};

describe('pull request status events', () => {
  // Without this hook the session pull request cache still fills, the routes
  // still answer, and Home keeps showing the old status until its next read.
  it('reports every status the session pull request cache presents', async () => {
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
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: { ...branchSvc, sessionBranches: async () => ['feat/one'] } as never,
      branchPrStatusForBranches: vi.fn(async () => green),
    });
    try {
      await server.inject('/sessions/s1/branches');
      await vi.waitFor(() =>
        expect(statuses).toContainEqual({
          sessionId: 's1',
          status: expect.objectContaining(green),
        }),
      );
    } finally {
      await server.close();
    }
  });
});
