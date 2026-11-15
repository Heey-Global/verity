import { describe, expect, it } from 'vitest';
import {
  app,
  cancelTurn,
  clearQueue,
  ctx,
  decidePermission,
  releaseUnconfirmedTermination,
  stopSession,
} from './server-fixture.test-helper.js';

describe('POST /sessions/:id/cancel (#79)', () => {
  it('stops a running turn (200, cancelled: true) with an empty backlog', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    cancelTurn.mockReturnValueOnce(true);
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: true,
      forceReleased: false,
      droppedQueued: [],
    });
    expect(cancelTurn).toHaveBeenCalledWith('s1');
  });

  it('returns cancelled: false (200, no-op) when the session is idle', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    cancelTurn.mockReturnValueOnce(false);
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: false,
      forceReleased: false,
      droppedQueued: [],
    });
  });

  it('drops the pending backlog BEFORE cancelling the turn and returns the dropped prompts (#79)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // Record call order: the queue must be cleared before the turn is signalled, or
    // the cancelled turn's settle drains a queued message into a fresh turn.
    const order: string[] = [];
    clearQueue.mockImplementationOnce(async () => {
      order.push('clearQueue');
      return [
        { id: 'q1', prompt: 'first queued' },
        { id: 'q2', prompt: 'second queued' },
      ];
    });
    cancelTurn.mockImplementationOnce(() => {
      order.push('cancelTurn');
      return true;
    });
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: 's1',
      cancelled: true,
      forceReleased: false,
      droppedQueued: [
        { id: 'q1', prompt: 'first queued' },
        { id: 'q2', prompt: 'second queued' },
      ],
    });
    expect(stopSession).toHaveBeenCalledWith('s1');
    expect(order).toEqual(['clearQueue', 'cancelTurn']);
  });

  it('404s an unknown session without touching the conductor', async () => {
    const res = await app.inject({ method: 'POST', url: '/sessions/missing/cancel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session missing not found' });
    expect(cancelTurn).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('leaves the unconfirmed-termination fence alone unless force is asked for', async () => {
    // The default has to stay the safe one: an ordinary Stop must never hand the
    // worktree on while the previous agent process is unaccounted for.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({ method: 'POST', url: '/sessions/s1/cancel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: false });
    expect(releaseUnconfirmedTermination).not.toHaveBeenCalled();
  });

  it('releases the fence on force, AFTER the ordinary stop has had its chance', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const order: string[] = [];
    stopSession.mockImplementationOnce(async () => {
      order.push('stopSession');
      return { cancelled: false, droppedQueued: [] };
    });
    releaseUnconfirmedTermination.mockImplementationOnce(async () => {
      order.push('release');
      return true;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: true });
    expect(releaseUnconfirmedTermination).toHaveBeenCalledWith('s1');
    // The graceful path first: an override should only ever face a fence that
    // survived a real stop attempt.
    expect(order).toEqual(['stopSession', 'release']);
  });

  it('reports forceReleased: false when force finds nothing fenced', async () => {
    // The button is reachable from a banner that may already be stale, so a force on
    // a healthy session must be an honest no-op rather than a lie about a release.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forceReleased: false });
  });

  it('404s a force on an unknown session before releasing anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/missing/cancel',
      payload: { force: true },
    });
    expect(res.statusCode).toBe(404);
    expect(releaseUnconfirmedTermination).not.toHaveBeenCalled();
  });
});

describe('POST /sessions/:id/permissions/:toolUseId (#27)', () => {
  it('allows a tool: 200 decided:true, routes the decision to the conductor', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(true);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_a',
      payload: { behavior: 'allow', updatedInput: { command: 'ls -la' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 's1', toolUseId: 'toolu_a', decided: true });
    expect(decidePermission).toHaveBeenCalledWith('s1', 'toolu_a', {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  it('denies a tool, defaulting the message when none is given', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(true);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_b',
      payload: { behavior: 'deny' },
    });
    expect(res.statusCode).toBe(200);
    expect(decidePermission).toHaveBeenCalledWith('s1', 'toolu_b', {
      behavior: 'deny',
      message: 'Denied by the operator.',
    });
  });

  it('404s when no prompt is pending under that id (already answered / turn ended)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    decidePermission.mockReturnValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/stale',
      payload: { behavior: 'allow' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('stale') });
  });

  it('404s an unknown session without touching the conductor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/missing/permissions/toolu_a',
      payload: { behavior: 'allow' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session missing not found' });
    expect(decidePermission).not.toHaveBeenCalled();
  });

  it('400s an invalid decision body (unknown behavior)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/permissions/toolu_a',
      payload: { behavior: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
    expect(decidePermission).not.toHaveBeenCalled();
  });
});
