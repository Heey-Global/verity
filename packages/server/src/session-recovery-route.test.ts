import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerSessionRecoveryRoute,
  type SessionRecoveryRouteDeps,
} from './session-recovery-route.js';

describe('Session worktree recovery route', () => {
  let app: FastifyInstance;
  let deps: SessionRecoveryRouteDeps;

  beforeEach(() => {
    app = Fastify({ logger: false });
    deps = {
      store: {
        getSession: vi.fn(
          async () =>
            ({
              sessionId: 's1',
              projectId: 'p1',
              worktree: '/projects/p1/.verity-sessions/s1',
            }) as never,
        ),
      },
      projectCloneRoot: '/projects',
      isBusy: vi.fn(() => false),
      hasMeetingJob: vi.fn(() => false),
      repair: vi.fn<NonNullable<SessionRecoveryRouteDeps['repair']>>(async () => ({
        repaired: ['worktree'],
      })),
      uid: () => 1000,
    };
    registerSessionRecoveryRoute(app, deps);
  });

  afterEach(async () => app.close());

  it('404s an unknown session before checking runtime state', async () => {
    vi.mocked(deps.store.getSession).mockResolvedValueOnce(undefined);
    const response = await app.inject({
      method: 'POST',
      url: '/sessions/missing/recover-worktree',
    });
    expect(response.statusCode).toBe(404);
    expect(deps.isBusy).not.toHaveBeenCalled();
  });

  it('refuses recovery for a projectless session', async () => {
    vi.mocked(deps.store.getSession).mockResolvedValueOnce({ projectId: null } as never);
    const response = await app.inject({ method: 'POST', url: '/sessions/s1/recover-worktree' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'worktree recovery is available only for project sessions',
    });
  });

  it('refuses recovery when the project clone root is not configured', async () => {
    delete deps.projectCloneRoot;
    const response = await app.inject({ method: 'POST', url: '/sessions/s1/recover-worktree' });
    expect(response.statusCode).toBe(409);
    expect(deps.repair).not.toHaveBeenCalled();
  });

  it('short-circuits meeting ownership when the conductor is busy', async () => {
    vi.mocked(deps.isBusy).mockReturnValueOnce(true);
    const response = await app.inject({ method: 'POST', url: '/sessions/s1/recover-worktree' });
    expect(response.statusCode).toBe(409);
    expect(deps.hasMeetingJob).not.toHaveBeenCalled();
    expect(deps.repair).not.toHaveBeenCalled();
  });

  it('maps an unsafe repair refusal to the reprovisioning response', async () => {
    vi.mocked(deps.repair!).mockRejectedValueOnce(new Error('unsafe ownership'));
    const response = await app.inject({ method: 'POST', url: '/sessions/s1/recover-worktree' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error:
        'session worktree permissions could not be repaired safely — ownership or path shape requires project reprovisioning',
    });
  });
});
