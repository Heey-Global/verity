import { expect, it, vi } from 'vitest';
import {
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
} from './server-fixture.test-helper.js';
import { buildServer, type ServerDeps } from './server.js';

// The repair sweep reads the pull requests of every session every 30 s,
// watched or not. Read at a viewer's cadence, each pass asked the forge again
// for every branch, and the sweep spent most of the API quota on sessions
// nobody had open. Without the background mark the cache cannot tell the two
// readers apart, and every test of its cadence still passes.
it('reads unwatched sessions in the background and a viewed branch list as a viewer', async () => {
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
  branchSvc.sessionBranches.mockResolvedValue(['feature']);
  const status = vi.fn().mockResolvedValue(null);
  const server = buildServer({
    eventStore: ctx.store,
    bus,
    conductor,
    branches: branchSvc as unknown as NonNullable<ServerDeps['branches']>,
    branchPrStatus: vi.fn(async () => null),
    pullRequestRepairPollMs: 20,
    projectPullRequests: {
      list: vi.fn().mockResolvedValue({ webUrl: '', pulls: [] }),
      status,
      merge: vi.fn().mockResolvedValue(false),
    },
  });
  try {
    await server.ready();
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(expect.anything(), 'feature', undefined, {
        background: true,
      }),
    );
    // Only the route reads as a viewer; a sweep that did would read open state too.
    expect(status).not.toHaveBeenCalledWith(expect.anything(), 'feature', undefined, {
      background: false,
    });
    status.mockClear();
    await server.inject({ url: '/sessions/s1/branches' });
    expect(status).toHaveBeenCalledWith(expect.anything(), 'feature', undefined, {
      background: false,
    });
  } finally {
    await server.close();
  }
});
