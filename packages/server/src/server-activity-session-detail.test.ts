import { describe, expect, it } from 'vitest';
import { app, ctx, pendingPermissions, ZERO_USAGE } from './server-fixture.test-helper.js';
import { sessionGoogleStatus } from './session-google-status.js';

describe('GET /sessions/:id', () => {
  it('returns session detail with status and event count', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'running' });

    const res = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // Without a signed-in person the request reads as the administrator.
      googleStatus: await sessionGoogleStatus(
        ctx.store,
        's1',
        '00000000-0000-4000-8000-000000000001',
      ),
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: null,
      planningPlan: null,
      planningRevision: 0,
      projectId: null,
      status: 'running',
      pendingPermissions: [],
      usage: ZERO_USAGE,
      resumable: false,
      eventCount: 0,
      agentTextCounterVersion: 'agent-text-v2',
      lastActivityAt: expect.any(Number),
      lastSeenEventCount: null,
      inboxDismissed: [],
      busy: false,
      queued: [],
    });
  });

  it('includes cumulative token usage in the detail', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
      stopReason: 'end_turn',
    });

    const res = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      eventCount: 0,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
        turns: 1,
      },
    });
  });

  it('includes the latest rate-limit state in the detail', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
      providerLabel: 'Codex',
    });

    const res = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rateLimit: {
        status: 'rejected',
        resetsAt: 1_700_000_000,
        window: 'five_hour',
        providerLabel: 'Codex',
        observedAt: expect.any(Number),
      },
      rateLimits: [
        {
          status: 'rejected',
          resetsAt: 1_700_000_000,
          window: 'five_hour',
          providerLabel: 'Codex',
          observedAt: expect.any(Number),
        },
      ],
    });
  });

  it('returns 404 for an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('missing') });
  });

  it('returns 400 for an invalid session id (not the raw zod error)', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/bad%20id' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
  });
});
