import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { app, ctx, isBusy, pendingPermissions } from './server-fixture.test-helper.js';

const RESULT = {
  t: 'result',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
  stopReason: 'end_turn',
} as const;

async function list(): Promise<Record<string, Record<string, unknown>>> {
  const response = await app.inject({ method: 'GET', url: '/sessions' });
  expect(response.statusCode).toBe(200);
  const byId: Record<string, Record<string, unknown>> = {};
  for (const summary of response.json<Record<string, unknown>[]>())
    byId[summary.sessionId as string] = summary;
  return byId;
}

/**
 * The session list re-derives only the logs that moved. A projection reused
 * past a change would show a stale badge, count or question until something
 * else touched the session; one that froze conductor state would hide a running
 * turn or an open permission. Each test below breaks one of those ways.
 */
describe('GET /sessions reuses the projection of an unchanged log', () => {
  it('reads only the logs that changed since the previous list', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'one' });
    await ctx.store.appendEvent('s2', { t: 'text', delta: 'two' });
    await list();

    const reads = vi.spyOn(ctx.store, 'listSessionProjectionFacts');
    try {
      await ctx.store.appendEvent('s1', { t: 'text', delta: 'three' });
      const after = await list();
      expect(reads.mock.calls.map(([ids]) => [...ids])).toEqual([['s1']]);
      expect(after.s1).toMatchObject({ eventCount: 2 });
      expect(after.s2).toMatchObject({ eventCount: 1 });

      reads.mockClear();
      expect(await list()).toEqual(after);
      expect(reads.mock.calls.map(([ids]) => [...ids])).toEqual([[]]);
    } finally {
      reads.mockRestore();
    }
  });

  it('re-reads a log changed below its newest event', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'first' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'second' });
    await ctx.store.appendEvent('s1', RESULT);
    expect((await list()).s1).toMatchObject({ eventCount: 2 });

    // The newest event and its seq stay put; only the revision records this.
    await sql`delete from events where id = (
      select min(id) from events where session_id = 's1'
    )`.execute(ctx.db);
    expect((await list()).s1).toMatchObject({ eventCount: 1 });
  });

  it('applies the conductor to a reused projection on every read', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', {
      t: 'permission',
      id: 'tool-1',
      tool: 'verity_trusted_cli',
      input: { command: 'ls' },
      riskClass: 'ask',
    });
    await ctx.store.appendEvent('s1', RESULT);
    expect((await list()).s1).toMatchObject({ status: 'completed', pendingPermissions: [] });

    isBusy.mockReturnValue(true);
    expect((await list()).s1).toMatchObject({ status: 'running' });

    pendingPermissions.mockReturnValue(['tool-1']);
    expect((await list()).s1).toMatchObject({
      status: 'awaiting_input',
      pendingPermissions: ['tool-1'],
      pendingPermissionRequests: [
        { toolUseId: 'tool-1', tool: 'verity_trusted_cli', input: { command: 'ls' } },
      ],
    });
  });

  it('bounds full projection reads across overlapping overview requests', async () => {
    for (let i = 0; i < 12; i += 1) {
      await ctx.store.createSession({
        sessionId: `fallback-${i}`,
        worktree: `/wt/missing-${i}`,
        model: 'm',
      });
      await ctx.store.appendEvent(`fallback-${i}`, { t: 'prompt', text: 'go' });
      await ctx.store.appendEvent(`fallback-${i}`, { t: 'status', state: 'running' });
    }
    const originalFacts = ctx.store.listSessionProjectionFacts.bind(ctx.store);
    const facts = vi
      .spyOn(ctx.store, 'listSessionProjectionFacts')
      .mockImplementation(async (...args) => {
        const result = await originalFacts(...args);
        for (const value of result.values()) {
          value.eventsTruncated = true;
          value.events = value.events.filter(({ event }) => event.t !== 'prompt');
        }
        return result;
      });
    const originalRead = ctx.store.visitSessionProjectionEvents.bind(ctx.store);
    let active = 0;
    let peak = 0;
    const reads = vi
      .spyOn(ctx.store, 'visitSessionProjectionEvents')
      .mockImplementation(async (...args) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return await originalRead(...args);
        } finally {
          active -= 1;
        }
      });
    try {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/sessions' }),
        app.inject({ method: 'GET', url: '/sessions' }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveLength(12);
        expect(
          response
            .json<Array<{ status: string }>>()
            .every((session) => session.status === 'running'),
        ).toBe(true);
      }
      // Identical badges would hide a queue large enough to monopolize the pool.
      expect(reads).toHaveBeenCalledTimes(1);
      expect(facts).toHaveBeenCalledTimes(1);
      expect(peak).toBe(1);
      // Unchanged logs are no longer read at all, so move them first.
      for (let i = 0; i < 12; i += 1)
        await ctx.store.appendEvent(`fallback-${i}`, { t: 'status', state: 'running' });
      reads.mockRejectedValueOnce(new Error('projection read failed'));
      const failed = await app.inject({ method: 'GET', url: '/sessions' });
      expect(failed.statusCode).toBe(500);
      const recovered = await app.inject({ method: 'GET', url: '/sessions' });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()[0]).toMatchObject({ status: 'running' });
    } finally {
      facts.mockRestore();
      reads.mockRestore();
    }
  });
});
