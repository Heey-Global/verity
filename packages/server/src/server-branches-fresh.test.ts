import { describe, expect, it, vi } from 'vitest';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

describe('GET /sessions/:id/branches?fresh=1', () => {
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
});
