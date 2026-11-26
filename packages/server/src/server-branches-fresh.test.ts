import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

describe('GET /sessions/:id/branches?fresh=1', () => {
  // A fake clock installed before a failing buildServer must not reach later files.
  afterEach(() => {
    vi.useRealTimers();
  });

  // The cache answers a plain read with a status up to thirty seconds old;
  // opening the session must reach the forge.
  it('reads the pull request from the forge when the session is opened', async () => {
    await createExistingSession('s1');
    branchSvc.current.mockResolvedValue('feat/fresh');
    branchSvc.switchable.mockResolvedValue([]);
    branchSvc.previewable.mockResolvedValue([]);
    const branchPrStatus = vi.fn(async () => ({
      number: 7,
      title: 'Fresh',
      url: 'https://github.com/heey-global/verity/pull/7',
      phase: 'open' as const,
      pipeline: 'success' as const,
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
      mergeable: true,
    }));
    // Before the server, whose cache keeps the clock it was built with.
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus,
    });
    try {
      const read = (url: string) => server.inject({ method: 'GET', url });
      await read('/sessions/s1/branches');
      await read('/sessions/s1/branches');
      expect(branchPrStatus).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_500);
      await read('/sessions/s1/branches');
      expect(branchPrStatus).toHaveBeenCalledTimes(1);
      await read('/sessions/s1/branches?fresh=1');
      expect(branchPrStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  // A forge that just failed must not be asked again every two seconds
  // because a device keeps opening the session.
  it('keeps a failed repository pull request read on its TTL when asked fresh', async () => {
    await createExistingSession('s1');
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'team',
      repo: 'app',
      containerName: 'app',
      state: 'active',
    });
    await ctx.store.setSessionProject('s1', 'p1');
    branchSvc.current.mockResolvedValue('feat/fresh');
    branchSvc.switchable.mockResolvedValue([]);
    branchSvc.previewable.mockResolvedValue([]);
    const listRepositories = ctx.store.listProjectRepositories.bind(ctx.store);
    const repositories = vi
      .spyOn(ctx.store, 'listProjectRepositories')
      .mockRejectedValueOnce(new Error('forge down'));
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus: vi.fn(async () => null),
      projectPullRequests: {
        list: vi.fn().mockResolvedValue({ webUrl: '', pulls: [] }),
        status: vi.fn().mockResolvedValue(null),
        merge: vi.fn().mockResolvedValue(false),
      },
    });
    try {
      const read = () => server.inject({ method: 'GET', url: '/sessions/s1/branches?fresh=1' });
      await read();
      const failedReads = repositories.mock.calls.length;
      expect(failedReads).toBeGreaterThan(0);
      repositories.mockImplementation(listRepositories);
      vi.setSystemTime(Date.now() + 2_500);
      await read();
      expect(repositories.mock.calls.length).toBe(failedReads);
      vi.setSystemTime(Date.now() + 3_000);
      await read();
      const settledReads = repositories.mock.calls.length;
      expect(settledReads).toBeGreaterThan(failedReads);
      vi.setSystemTime(Date.now() + 2_500);
      await read();
      expect(repositories.mock.calls.length).toBeGreaterThan(settledReads);
    } finally {
      vi.useRealTimers();
      repositories.mockRestore();
      await server.close();
    }
  });
});
