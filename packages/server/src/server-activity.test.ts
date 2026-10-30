import { boundedHistoryResultSchema, type AgentEvent } from '@verity/events';
import { InMemoryEventBus } from '@verity/session';
import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry } from './auth.js';
import type { ReleaseSummary } from './github.js';
import { ResourceObserver } from './live/resource-observer.js';
import {
  app,
  branchSvc,
  bus,
  CLAUDE_SORTED,
  conductor,
  createExistingSession,
  ctx,
  dispatchTurnWhenIdle,
  hasUnconfirmedTermination,
  isBackendHandoffPending,
  isBusy,
  pendingPermissions,
  preparingOperation,
  queuedItems,
  sendTurn,
  startSession,
  updateFixture,
  worktreeRoot,
  ZERO_USAGE,
} from './server-fixture.test-helper.js';
import { buildServer, redactScrollDiagnosticData, redactScrollDiagnosticEvent } from './server.js';
import { sessionGoogleStatus } from './session-google-status.js';

describe('GET /sessions/:id/activity', () => {
  it('keeps background work visible while the main agent awaits input and settles on termination', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'child', phase: 'started' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_input' });
    const activity = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(activity.json()).toMatchObject({ busy: true, activityAnimating: true });
    const overview = await app.inject({ method: 'GET', url: '/sessions' });
    expect(overview.json()[0]).toMatchObject({ status: 'awaiting_input', backgroundWorking: true });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'child', phase: 'ended' });
    const waiting = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(waiting.json()).toMatchObject({ busy: true, activityAnimating: false });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'orphan', phase: 'started' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    isBusy.mockReturnValue(false);
    const ended = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(ended.json()).toMatchObject({ busy: false, activityAnimating: false });
  });

  it('reflects the conductor in-flight + queued state', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    queuedItems.mockReturnValue([{ id: 'q1', text: 'next one' }]);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      busy: true,
      activityAnimating: true,
      queued: [{ id: 'q1', text: 'next one' }],
      pendingPermissions: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      planningRevision: 0,
    });
  });

  it('reports permission prompts waiting for a decision', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    pendingPermissions.mockReturnValue(['toolu_pending']);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ pendingPermissions: ['toolu_pending'] });
  });

  it('keeps activity busy and model-switch pending until backend termination is confirmed', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    isBackendHandoffPending.mockReturnValue(true);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ busy: true, modelSwitchPending: true });
  });

  it('marks a session busy-because-unconfirmed so the fence is not read as work', async () => {
    // Without this flag the two states look identical from the app: `busy: true` with
    // nothing running. The operator needs to know the session is reserved pending a
    // termination the server is still retrying, not stuck in an endless turn.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    isBusy.mockReturnValue(true);
    hasUnconfirmedTermination.mockReturnValue(true);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ busy: true, terminationUnconfirmed: true });
  });

  it('404s for an unknown session so stale app state cannot stay half-alive', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/ghost/activity' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session ghost not found' });
  });

  it('includes the worktree branch read live from git (#110)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    branchSvc.current.mockResolvedValue('feat/122-x');
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toEqual({
      busy: false,
      activityAnimating: false,
      queued: [],
      pendingPermissions: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      planningRevision: 0,
      branch: 'feat/122-x',
    });
    expect(branchSvc.current).toHaveBeenCalledWith('/wt/s1');
  });

  it('carries the display name so an auto-title/rename reflects within a poll', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: 'Auth Refactor',
    });
    const noBranches = buildServer({ eventStore: ctx.store, bus, conductor });
    const res = await noBranches.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toEqual({
      busy: false,
      activityAnimating: false,
      queued: [],
      pendingPermissions: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: 'Auth Refactor',
      planningPlan: null,
      planningRevision: 0,
    });
    await noBranches.close();
  });

  it('omits the branch (keeps the poll alive) when the live git read throws', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    branchSvc.current.mockRejectedValue(new Error('git boom'));
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      busy: false,
      queued: [],
      pendingPermissions: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
    });
  });

  it('omits the branch when branch switching is not configured (no project repo)', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const noBranches = buildServer({ eventStore: ctx.store, bus, conductor });
    const res = await noBranches.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toEqual({
      busy: false,
      activityAnimating: false,
      queued: [],
      pendingPermissions: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      planningRevision: 0,
    });
    await noBranches.close();
  });

  it('reports busy for an open background task even when the conductor is idle', async () => {
    // The turn's first `result` landed while a sub-agent (task) is still open — the
    // backend has re-invoked, so conductor.isBusy is momentarily false. The derived
    // status is still `running`, so the working indicator must stay lit (the bug:
    // raw isBusy dropped the Stop button + activity line mid-turn).
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'bg1', phase: 'started' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    isBusy.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ busy: true });
  });

  it('reports not-busy once the background task ends and the turn is completed', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'bg1', phase: 'started' });
    await ctx.store.appendEvent('s1', {
      t: 'task',
      id: 'bg1',
      phase: 'ended',
      status: 'completed',
    });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    isBusy.mockReturnValue(false);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ busy: false });
  });

  it('ignores an orphaned background task from an older completed turn', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'first' });
    await ctx.store.appendEvent('s1', { t: 'task', id: 'orphan', phase: 'started' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'second' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    isBusy.mockReturnValue(false);

    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });

    expect(res.json()).toMatchObject({ busy: false });
  });

  it('stays busy for a turn parked on a permission prompt (awaiting_input, still in-flight)', async () => {
    // The turn is paused on a mid-turn permission prompt: the derived status is
    // `awaiting_input` (not `running`), but conductor.isBusy is true because the turn
    // is still in flight. `busy` must stay true (the in-flight term is un-suppressed),
    // so the working/Stop indicator doesn't vanish while awaiting the operator.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'permission',
      id: 'p1',
      tool: 'Bash',
      input: {},
      riskClass: 'ask',
    });
    isBusy.mockReturnValue(true);
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(res.json()).toMatchObject({ busy: true });
  });
});

describe('POST /sessions/:id/debug/scroll', () => {
  it('redacts scroll diagnostics to scalar allowlisted fields', () => {
    expect(redactScrollDiagnosticEvent('prompt text leaked here')).toBe('unknown');
    expect(redactScrollDiagnosticEvent('programmatic-scroll-delta')).toBe(
      'programmatic-scroll-delta',
    );
    expect(
      redactScrollDiagnosticData({
        atBottom: true,
        blockedBy: 'append-settling',
        dy: -240,
        loadingOlder: false,
        mode: 'latest prompt text leaked here',
        prompt: 'do not log me',
        target: { rowKey: 'text-secret' },
      }),
    ).toEqual({
      atBottom: true,
      blockedBy: 'append-settling',
      dy: -240,
      loadingOlder: false,
      mode: 'unknown',
    });
  });

  it('keeps the newest-first transcript diagnostics readable', () => {
    for (const event of [
      'history-append-settled',
      'restore-latest',
      'restore-latest-interrupted',
      'restore-skipped-after-user-action',
      'transcript-mode',
    ]) {
      expect(redactScrollDiagnosticEvent(event)).toBe(event);
    }
    expect(
      redactScrollDiagnosticData({
        anchorOffsetY: 37,
        historyEdgeDistance: 412.5,
        index: 12,
        mode: 'newest-first',
        oldestVisibleIndex: 41,
        reason: 'deep-anchor-not-loaded',
        rows: 82,
        targetOffsetY: 926.7,
      }),
    ).toEqual({
      anchorOffsetY: 37,
      historyEdgeDistance: 412.5,
      index: 12,
      mode: 'newest-first',
      oldestVisibleIndex: 41,
      reason: 'deep-anchor-not-loaded',
      rows: 82,
      targetOffsetY: 926.7,
    });
    expect(redactScrollDiagnosticData({ reason: 'prompt text leaked here' })).toEqual({
      reason: 'unknown',
    });
  });

  it('redacts diagnostics from the removed chronological coordinate system', () => {
    // These names described prepend-anchoring, which no longer exists. An older
    // installed app can still send them; they must degrade, not leak through.
    for (const event of [
      'history-anchor-restore',
      'mvp-mode',
      'restore-bottom-settled',
      'restore-empty',
    ]) {
      expect(redactScrollDiagnosticEvent(event)).toBe('unknown');
    }
    expect(
      redactScrollDiagnosticData({
        anchorCaptured: false,
        attempts: 6,
        blockedBy: 'wrong-direction',
        mode: 'prepend',
        restored: true,
      }),
    ).toEqual({ blockedBy: 'unknown', mode: 'unknown' });
  });

  it('accepts mobile scroll diagnostics for a known session', async () => {
    const invalidate = vi.spyOn(ResourceObserver.prototype, 'invalidate');
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/debug/scroll',
      payload: {
        event: 'programmatic-scroll-delta',
        seq: 7,
        at: 1_700_000_000,
        data: { dy: -240, loadingOlder: false },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Telemetry must not trigger Git metadata reads or sandbox listener scans.
    expect(invalidate).not.toHaveBeenCalled();
    await app.inject({ method: 'PATCH', url: '/sessions/s1', payload: { name: 'Renamed' } });
    expect(invalidate).toHaveBeenCalledWith('/sessions/s1');
    invalidate.mockRestore();
  });

  it('rejects non-scalar scroll diagnostic data', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/debug/scroll',
      payload: {
        event: 'programmatic-scroll-delta',
        seq: 8,
        at: 1_700_000_000,
        data: { target: { rowKey: 'text-secret' } },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid request' });
  });

  it('404s scroll diagnostics for an unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/ghost/debug/scroll',
      payload: {
        event: 'begin-drag',
        seq: 1,
        at: 1_700_000_000,
        data: {},
      },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /sessions/:id/events (backward pagination)', () => {
  it('negotiates whole byte-bounded history independently from the legacy route', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: '界'.repeat(100_000) });
    const bounded = await app.inject({ method: 'GET', url: '/sessions/s1/history/v1' });
    expect(bounded.statusCode).toBe(200);
    expect(bounded.json()).toMatchObject({
      contract: 'bounded-history-v1',
      kind: 'oversized-event',
    });
    expect(Buffer.byteLength(bounded.body)).toBeLessThanOrEqual(256 * 1024);
    const boundary = bounded.json();
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const response = await app.inject({
        method: 'GET',
        url: `/sessions/s1/history/v1?beforeSeq=${boundary.seq + 1}&snapshotSeq=${boundary.snapshotSeq}&eventOffset=${offset}`,
      });
      expect(response.statusCode).toBe(200);
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(256 * 1024);
      const chunk = boundedHistoryResultSchema.parse(response.json());
      if (chunk.kind !== 'event-chunk') throw new Error('expected chunk');
      expect(chunk).toMatchObject({ kind: 'event-chunk', seq: boundary.seq, offset });
      chunks.push(chunk.data);
      offset += chunk.data.length;
      if (offset === chunk.totalChars) break;
    }
    const recovered = JSON.parse(chunks.join(''));
    expect(recovered.events[0].event.delta).toBe('界'.repeat(100_000));
    expect(recovered.hasMore).toBe(false);
    const invalidOffset = await app.inject({
      method: 'GET',
      url: `/sessions/s1/history/v1?eventOffset=${offset}`,
    });
    expect(invalidOffset.statusCode).toBe(400);
    const legacy = await app.inject({ method: 'GET', url: '/sessions/s1/events' });
    expect(legacy.json().events[0].event.delta).toBe('界'.repeat(100_000));
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'complete tail '.repeat(1000) });
    const plain = await app.inject({ method: 'GET', url: '/sessions/s1/history/v1' });
    expect(plain.json()).toMatchObject({ kind: 'page', hasMore: true });
    expect(plain.json().events).toHaveLength(1);
    expect(plain.json().events[0].event.delta).toBe('complete tail '.repeat(1000));
    expect(Buffer.byteLength(plain.body)).toBeLessThanOrEqual(256 * 1024);
    const compressed = await app.inject({
      method: 'GET',
      url: '/sessions/s1/history/v1',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(compressed.rawPayload).toString()).toBe(plain.body);

    const invalid = await app.inject({ method: 'GET', url: '/sessions/s1/history/v1?beforeSeq=0' });
    expect(invalid.statusCode).toBe(400);
  });

  it('negotiates compression for history while leaving other responses untouched', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'text', delta: 'history '.repeat(1_000) });
    const plain = await app.inject({ method: 'GET', url: '/sessions/s1/events' });
    const compressed = await app.inject({
      method: 'GET',
      url: '/sessions/s1/events',
      headers: { 'accept-encoding': 'gzip' },
    });
    // Verify composition: a route-only fixture can hide a missing compressor.
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.headers.vary).toContain('accept-encoding');
    expect(gunzipSync(compressed.rawPayload).toString()).toBe(plain.body);
    expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    expect(plain.headers['content-encoding']).toBeUndefined();
    const settings = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.headers['content-encoding']).toBeUndefined();
  });

  it('returns the newest page (ascending) with hasMore, then the older page', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++)
      seqs.push((await ctx.store.appendEvent('s1', { t: 'text', delta: `d${i}` })).seq);

    const tail = await app.inject({ method: 'GET', url: '/sessions/s1/events?limit=2' });
    expect(tail.statusCode).toBe(200);
    const tailBody = tail.json<{ events: { seq: number; ts: number }[]; hasMore: boolean }>();
    expect(tailBody.events.map((e) => e.seq)).toEqual(seqs.slice(-2));
    expect(tailBody.hasMore).toBe(true);
    // The REST history surfaces a real per-event ts (epoch ms, #32), not the seq.
    for (const e of tailBody.events) expect(Number.isInteger(e.ts) && e.ts > 0).toBe(true);

    const older = await app.inject({
      method: 'GET',
      url: `/sessions/s1/events?limit=2&beforeSeq=${tailBody.events[0]?.seq ?? 0}`,
    });
    const olderBody = older.json<{ events: { seq: number }[]; hasMore: boolean }>();
    expect(olderBody.events.map((e) => e.seq)).toEqual(seqs.slice(1, 3));
    expect(olderBody.hasMore).toBe(true);
  });

  it('404s an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/ghost/events' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /sessions/:id/diagnostics', () => {
  it('bounds history reads when recent events have no diagnostics', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const read = vi.spyOn(ctx.store, 'getEventsBeforeSeq').mockResolvedValue({
      events: [{ seq: 1, ts: 1, event: { t: 'prompt', text: 'private chat' } }],
      hasMore: true,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/s1/diagnostics' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(read).toHaveBeenCalledTimes(10);
    } finally {
      read.mockRestore();
    }
  });

  it('returns technical metadata without transcript content', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'private chat' });
    await ctx.store.appendEvent('s1', {
      t: 'diagnostic',
      source: 'agent',
      outcome: 'failed',
      phase: 'session_load',
      backend: 'opencode-acp',
      code: -32603,
    });
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/diagnostics' });
    expect(res.statusCode).toBe(200);
    const diagnostics = res.json<Array<{ seq: number; ts: number; source: string }>>();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.ts).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({
      source: 'agent',
      outcome: 'failed',
      phase: 'session_load',
      backend: 'opencode-acp',
      code: -32603,
    });
    expect(res.body).not.toContain('private chat');
  });
});

/**
 * The attention envelope. `?envelope=1` is opt-in precisely so the shape of the
 * default response cannot change under an app that has not been updated — the
 * first test below is the one that guards that.
 */
describe('GET /sessions?envelope=1', () => {
  it('still answers the bare array without the opt-in', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json()).toHaveLength(1);
  });

  it('wraps the same list and omits `attention` entirely when healthy', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const plain = await app.inject({ method: 'GET', url: '/sessions' });
    const enveloped = await app.inject({ method: 'GET', url: '/sessions?envelope=1' });

    expect(enveloped.statusCode).toBe(200);
    expect(enveloped.json().sessions).toEqual(plain.json());
    expect(Object.keys(enveloped.json())).toEqual(['sessions', 'sessionReordering']);
    expect(enveloped.json().sessionReordering).toBe(true);
  });

  it('names an Updater that is not answering its control socket', async () => {
    const updates = await updateFixture({
      readOperation: () => Promise.reject(new Error('ENOENT /run/verity/updater.sock')),
    });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/sessions?envelope=1',
        headers: { authorization: `Bearer ${updates.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().attention).toEqual([
        { code: 'updater_unhealthy', message: expect.stringContaining('not answering') },
      ]);
    } finally {
      await server.close();
    }
  });

  it('names an update whose journal stopped moving', async () => {
    const updates = await updateFixture({
      operation: { ...preparingOperation, updatedAt: '2020-01-01T00:00:00.000Z' },
    });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/sessions?envelope=1',
        headers: { authorization: `Bearer ${updates.token}` },
      });
      expect(res.json().attention).toEqual([
        { code: 'updater_unhealthy', message: expect.stringContaining('requested') },
      ]);
    } finally {
      await server.close();
    }
  });

  it('names a Codex quota probe that has been failing long enough to matter', async () => {
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      codexUsage: {
        getLimits: () => Promise.resolve([]),
        health: () => ({
          state: 'http-error',
          status: 401,
          at: Date.now(),
          // Well past USAGE_PROBE_STALL_MS: the meter has been showing a session's
          // frozen number for an hour and nothing else on the screen says so.
          since: Date.now() - 60 * 60_000,
        }),
      },
    });
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(res.json().attention).toEqual([
        { code: 'usage_probe_unhealthy', message: expect.stringContaining('not your account') },
      ]);
    } finally {
      await server.close();
    }
  });

  // `action` is the half of the signal that the app turns into a tap, and it is
  // carried by the same spread that carries `code`. Asserted here rather than only
  // against `attentionSignals()` because a response schema, or a builder that
  // projected `{ code, message }`, would drop it silently — the banner would still
  // render, just without the one screen that fixes it.
  it('carries the sign-in remedy across the wire, not just the sentence', async () => {
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      codexUsage: {
        getLimits: () => Promise.resolve([]),
        health: () => ({
          state: 'sign-in-rejected',
          at: Date.now(),
          // Past SIGN_IN_REJECTED_STALL_MS, so the fuse has blown: every Codex
          // session has been failing its model calls for minutes by now.
          since: Date.now() - 60 * 60_000,
        }),
      },
    });
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(res.json().attention).toEqual([
        {
          code: 'usage_probe_unhealthy',
          message: expect.stringContaining('Codex sessions cannot run'),
          action: 'codex-login',
        },
      ]);
    } finally {
      await server.close();
    }
  });

  // The attention path calls `codexUsage.health()` on every list poll, so a
  // deployment that injects no probe at all must still get a working `/sessions`
  // — the one invariant this whole file header is about.
  it('serves the list with no Codex probe injected at all', async () => {
    const server = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().attention).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('serves the list even when the Codex probe throws on being read', async () => {
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      codexUsage: {
        getLimits: () => Promise.resolve([]),
        health: () => {
          throw new Error('probe exploded');
        },
      },
    });
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions?envelope=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().attention).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  // The session list is polled every 2s per device and the Updater's control
  // socket has a 2s request timeout. Probing inline would let a hung Updater add
  // two seconds to every poll — a health signal that degrades the screen it
  // rides on. The probe is cached and refreshed off the request path instead.
  it('does not re-probe the Updater on every poll', async () => {
    let reads = 0;
    const updates = await updateFixture({
      readOperation: () => {
        reads += 1;
        return Promise.resolve(null);
      },
    });
    const server = buildServer(updates.deps);
    try {
      for (let poll = 0; poll < 5; poll += 1)
        expect(
          (
            await server.inject({
              method: 'GET',
              url: '/sessions?envelope=1',
              headers: { authorization: `Bearer ${updates.token}` },
            })
          ).statusCode,
        ).toBe(200);
      expect(reads).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('stays quiet about an update that is still progressing', async () => {
    const updates = await updateFixture({
      operation: { ...preparingOperation, updatedAt: new Date().toISOString() },
    });
    const server = buildServer(updates.deps);
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/sessions?envelope=1',
        headers: { authorization: `Bearer ${updates.token}` },
      });
      expect(Object.keys(res.json())).toEqual(['sessions', 'sessionReordering']);
    } finally {
      await server.close();
    }
  });
});

/**
 * The per-SESSION half of the same mechanism. This one rides the DEFAULT
 * response rather than the envelope, because it safely can: the breaking change
 * the envelope exists to avoid was the top-level array→object switch, and an
 * extra key on an element is stripped by the app's `z.object(...)`.
 */
describe('GET /sessions — a session whose sandbox is cut off from the broker', () => {
  async function serverWithDisconnectedProjects(disconnected: readonly string[]) {
    await ctx.store.upsertProject({
      id: 'p-cutoff',
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'dev-heey-global--k8s',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 's-cutoff',
      worktree: '/wt/s-cutoff',
      model: 'm',
      projectId: 'p-cutoff',
    });
    return buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: {
        provision: vi.fn(),
        disconnectedSandboxProjects: () => new Set(disconnected),
      },
    });
  }

  it('says so on the session, in the default response shape', async () => {
    const server = await serverWithDisconnectedProjects(['p-cutoff']);
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions' });
      expect(Array.isArray(res.json())).toBe(true);
      expect(res.json()[0].attention).toEqual([
        {
          code: 'sandbox_disconnected',
          message: expect.stringContaining('lost its connection to Verity'),
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('omits the field entirely for a session whose sandbox is current', async () => {
    const server = await serverWithDisconnectedProjects([]);
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions' });
      expect(Object.keys(res.json<Array<Record<string, unknown>>>()[0] ?? {})).not.toContain(
        'attention',
      );
    } finally {
      await server.close();
    }
  });

  it('reads the set without asking the provisioner to compute anything', async () => {
    // The guarantee this route needs: whatever it reports, it reports from state
    // the reconciler already produced. `/sessions` is polled every 2 s per device,
    // so a probe here would be paid 30 times a minute per device.
    const disconnectedSandboxProjects = vi.fn(() => new Set(['p-cutoff']));
    await ctx.store.upsertProject({
      id: 'p-cutoff',
      owner: 'heey-global',
      repo: 'k8s',
      containerName: 'dev-heey-global--k8s',
      state: 'active',
    });
    for (const sessionId of ['a', 'b', 'c'])
      await ctx.store.createSession({
        sessionId,
        worktree: `/wt/${sessionId}`,
        model: 'm',
        projectId: 'p-cutoff',
      });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: { provision: vi.fn(), disconnectedSandboxProjects },
    });
    try {
      await server.inject({ method: 'GET', url: '/sessions' });
      // One synchronous, already-computed read per session, and nothing else —
      // no Docker call, no query, nothing that can block or throw.
      expect(disconnectedSandboxProjects).toHaveBeenCalledTimes(3);
      expect(disconnectedSandboxProjects.mock.results.every((r) => r.type === 'return')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('reports nothing when the deployment has no provisioner that classifies sandboxes', async () => {
    await ctx.store.createSession({ sessionId: 's-noprov', worktree: '/wt/s-noprov', model: 'm' });
    const server = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      const res = await server.inject({ method: 'GET', url: '/sessions' });
      expect(Object.keys(res.json<Array<Record<string, unknown>>>()[0] ?? {})).not.toContain(
        'attention',
      );
    } finally {
      await server.close();
    }
  });
});

describe('GET /sessions', () => {
  it('returns an empty list when there are no sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('reports resumable from whether the worktree exists on disk', async () => {
    // s1 points at the real temp dir (exists → resumable); s2 at a missing path
    // (e.g. a worktree cleaned up after its PR merged → not resumable).
    await ctx.store.createSession({ sessionId: 's1', worktree: worktreeRoot, model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/gone-xyz', model: 'm' });

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    const byId: Record<string, boolean> = {};
    for (const s of res.json()) byId[s.sessionId] = s.resumable;
    expect(byId).toEqual({ s1: true, s2: false });
  });

  it('marks sessions that carry an automation and checks its model on confirm', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: '{"claudeAiOauth":{"accessToken":"claude-token"}}',
    });
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    const proposal = {
      name: 'Morning review',
      schedule: { kind: 'daily', hour: 9, minute: 0 },
      prompt: 'Review the open pull requests.',
    };
    // A project-less session has no project allowlist, but an agent-proposed model
    // still has to be one this server can actually run unattended.
    const refused = await app.inject({
      method: 'PUT',
      url: '/sessions/s1/automation',
      payload: { ...proposal, model: 'nowhere/unknown' },
    });
    expect(refused.statusCode).toBe(400);
    const saved = await app.inject({
      method: 'PUT',
      url: '/sessions/s1/automation',
      payload: { ...proposal, model: CLAUDE_SORTED[0] },
    });
    expect(saved.statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: '/sessions' })).json<
      Array<{ sessionId: string; automation?: unknown }>
    >();
    expect(list.find((s) => s.sessionId === 's1')?.automation).toEqual({ status: 'enabled' });
    expect(list.find((s) => s.sessionId === 's2')).not.toHaveProperty('automation');
  });

  it('lists sessions with a derived status badge', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_input' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        sessionId: 's1',
        worktree: '/wt/s1',
        model: 'm',
        name: null,
        planningPlan: null,
        planningRevision: 0,
        projectId: null,
        sortOrder: null,
        status: 'awaiting_input',
        pendingPermissions: [],
        usage: ZERO_USAGE,
        resumable: false, // fake worktree path → not on disk
        eventCount: 0,
        agentTextCounterVersion: 'agent-text-v2',
        lastActivityAt: expect.any(Number),
        lastSeenEventCount: null,
      },
      {
        sessionId: 's2',
        worktree: '/wt/s2',
        model: 'm',
        name: null,
        planningPlan: null,
        planningRevision: 0,
        projectId: null,
        sortOrder: null,
        status: 'idle',
        pendingPermissions: [],
        usage: ZERO_USAGE,
        resumable: false,
        eventCount: 0,
        agentTextCounterVersion: 'agent-text-v2',
        lastActivityAt: null,
        lastSeenEventCount: null,
      },
    ]);
  });

  it('keeps a timed-out linked message visible as needing input after its turn ends', async () => {
    for (const id of ['p1', 'p2']) {
      await ctx.store.upsertProject({
        id,
        owner: 'local',
        repo: id,
        containerName: `test-${id}`,
        state: 'active',
      });
    }
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      projectId: 'p1',
    });
    await ctx.store.createSession({
      sessionId: 's2',
      worktree: '/wt/s2',
      model: 'm',
      projectId: 'p2',
    });
    await ctx.store.createSessionLink('s1', 's2');
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    await ctx.store.createPendingSessionLinkMessage({
      id: 'card-1',
      invocationId: 'call-1',
      sourceSessionId: 's1',
      targetSessionId: 's2',
      sourceProjectId: 'p1',
      requestMac: 'a'.repeat(64),
      macKeyId: 'key-1',
      message: 'Deliver after approval',
    });

    const overview = await app.inject({ method: 'GET', url: '/sessions' });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toContainEqual(
      expect.objectContaining({
        sessionId: 's1',
        status: 'awaiting_input',
        pendingPermissions: ['card-1'],
        permissionAwaitingInput: true,
      }),
    );
    const activity = await app.inject({ method: 'GET', url: '/sessions/s1/activity' });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().pendingPermissions).toContain('card-1');
  });

  it('reports a conductor-busy session as running even when its last event is terminal', async () => {
    // Regression: the operator sends a new turn after a previous one `completed`.
    // The event log's last status is still `completed` (claude hasn't emitted its
    // first `running` event yet), but the conductor has the turn in flight. The
    // overview must badge it `running` (pulsing) — not `completed` — so several
    // sessions working at once all show as working.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'end_turn',
    });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    isBusy.mockImplementation((id) => id === 's1');

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    const byId: Record<string, string> = {};
    for (const s of res.json()) byId[s.sessionId] = s.status;
    expect(byId).toEqual({ s1: 'running', s2: 'idle' });
  });

  it('keeps awaiting_input over running for a busy session pending a permission', async () => {
    // A session blocked on a permission is still in-flight (conductor-busy), but
    // `awaiting_input` is the more specific, actionable badge — it must win over
    // the generic `running` overlay.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_input' });
    isBusy.mockReturnValue(true);

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.json()).toMatchObject([{ sessionId: 's1', status: 'awaiting_input' }]);
  });

  it('retires a historical permission status after the live prompt is answered', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'permission',
      id: 'tool-1',
      tool: 'verity_trusted_cli',
      input: {},
      riskClass: 'ask',
    });
    isBusy.mockReturnValue(true);

    const running = await app.inject({ method: 'GET', url: '/sessions' });
    expect(running.json()).toMatchObject([
      { sessionId: 's1', status: 'running', pendingPermissions: [] },
    ]);

    isBusy.mockReturnValue(false);
    const completed = await app.inject({ method: 'GET', url: '/sessions' });
    expect(completed.json()).toMatchObject([{ sessionId: 's1', status: 'completed' }]);
  });

  it('keeps awaiting_dependency over running for a busy session', async () => {
    // The other in-flight-but-blocked state: it's likewise more specific than the
    // generic `running` overlay and must be preserved.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_dependency' });
    isBusy.mockReturnValue(true);

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.json()).toMatchObject([{ sessionId: 's1', status: 'awaiting_dependency' }]);
  });

  it('includes the operator-assigned name when one is set', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/wt/s1',
      model: 'm',
      name: 'Fix login',
    });
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.json()).toMatchObject([{ sessionId: 's1', name: 'Fix login' }]);
  });

  it('reports cumulative token usage per session', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 3 },
      stopReason: 'end_turn',
    });
    await ctx.store.appendEvent('s1', {
      t: 'result',
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 1, cacheCreationTokens: 2 },
      stopReason: 'end_turn',
    });

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        sessionId: 's1',
        worktree: '/wt/s1',
        model: 'm',
        name: null,
        planningPlan: null,
        planningRevision: 0,
        projectId: null,
        sortOrder: null,
        status: 'completed',
        pendingPermissions: [],
        usage: {
          inputTokens: 150,
          outputTokens: 30,
          cacheReadTokens: 6,
          cacheCreationTokens: 5,
          turns: 2,
        },
        resumable: false,
        eventCount: 0,
        agentTextCounterVersion: 'agent-text-v2',
        lastActivityAt: expect.any(Number),
        lastSeenEventCount: null,
      },
    ]);
  });

  it('includes the latest rate-limit state in the summary', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', {
      t: 'rate_limit',
      status: 'rejected',
      resetsAt: 1_700_000_000,
      window: 'five_hour',
    });

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      {
        sessionId: 's1',
        rateLimit: {
          status: 'rejected',
          resetsAt: 1_700_000_000,
          window: 'five_hour',
          providerLabel: 'Claude',
          observedAt: expect.any(Number),
        },
        rateLimits: [
          {
            status: 'rejected',
            resetsAt: 1_700_000_000,
            window: 'five_hour',
            providerLabel: 'Claude',
            observedAt: expect.any(Number),
          },
        ],
      },
    ]);
  });

  it('still reports status and quota from a log far longer than the projection tail', async () => {
    // The overview no longer reads a session's whole projection slice — it reads
    // the end of it. Both things this route derives from a log can be decided by
    // something OLDER than that tail: the quota state stands until the provider
    // replaces it, and the status derivation needs the turn's `prompt`. A short
    // log cannot tell those apart from a tail that simply held them, so this
    // seeds past the bound and asks the route.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    // Deliberately does not import `PROJECTION_TAIL`: a guard that tracked the
    // bound would follow it if it were raised, and stop asking the question.
    // What it needs is a log whose ANSWER lives before the end of it.
    const written: AgentEvent[] = [
      { t: 'rate_limit', status: 'rejected', resetsAt: 1_700_000_042, window: 'weekly' },
      { t: 'prompt', text: 'the turn still running in the background' },
      { t: 'task', id: 'bg-open', phase: 'started' },
      // Long enough to push everything above out of any plausible tail, and made
      // of events the derivation reads but does not stop on.
      ...Array.from({ length: 130 }, (_, at) => [
        { t: 'task', id: `bg-${String(at)}`, phase: 'started' } as const,
        { t: 'task', id: `bg-${String(at)}`, phase: 'ended' } as const,
      ]).flat(),
      {
        t: 'result',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: 'end_turn',
      },
    ];
    for (const event of written) await ctx.store.appendEvent('s1', event);

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    const [summary] =
      res.json<
        { status: string; rateLimit?: { status: string; resetsAt: number }; eventCount: number }[]
      >();
    // `bg-open` never ended, so the turn's `result` does NOT mean completed —
    // and its `started` is far out of reach of the tail. Read from the tail
    // alone this session reports `completed`, and the operator watching a
    // background task run sees the card go quiet.
    expect(summary?.status).toBe('running');
    // Likewise the quota: the newest state for the weekly window is the oldest
    // event in the log. Dropped, the summary carries no `rateLimit` at all,
    // which renders as "not limited".
    expect(summary?.rateLimit).toMatchObject({ status: 'rejected', resetsAt: 1_700_000_042 });
    // The counters stay facts about the whole log, whatever the tail read.
    expect(summary?.eventCount).toBe(
      written.filter((event) => event.t === 'text' && event.delta.length > 0).length,
    );
  });

  it('carries the cached branch on each summary without awaiting git', async () => {
    let release: (branch: string) => void = () => undefined;
    const current = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const branches = {
      current,
      switchable: vi.fn(async () => [] as string[]),
      previewable: vi.fn(async () => [] as string[]),
      switch: vi.fn(),
    };
    const branchApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: branches as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchCacheTtlMs: 60_000,
    });
    try {
      const live = join(worktreeRoot, 'live');
      mkdirSync(live, { recursive: true });
      await ctx.store.createSession({ sessionId: 's1', worktree: live, model: 'm' });
      await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/gone', model: 'm' });
      // The list is polled every 2 s for every session: a git read that never
      // settles must not hold it up, so the cold answer simply has no branch.
      type Listed = { sessionId: string; branch?: string };
      const cold = await branchApp.inject({ method: 'GET', url: '/sessions' });
      expect(cold.statusCode).toBe(200);
      expect(cold.json<Listed[]>().find((s) => s.sessionId === 's1')?.branch).toBeUndefined();
      release('feat/122-preview-branches');
      await vi.waitFor(async () => {
        const res = await branchApp.inject({ method: 'GET', url: '/sessions' });
        const byId = new Map(res.json<Listed[]>().map((s) => [s.sessionId, s]));
        expect(byId.get('s1')?.branch).toBe('feat/122-preview-branches');
        expect(byId.get('s2')?.branch).toBeUndefined();
      });
      // A gone worktree is never asked: git would fail for it on every poll.
      expect(current).not.toHaveBeenCalledWith('/wt/gone');
      // Within the TTL the label comes from memory, not another git read per poll.
      expect(current).toHaveBeenCalledTimes(1);
    } finally {
      await branchApp.close();
    }
  });

  it('enriches each summary with a compact `pr` once resolved (stale-while-revalidate)', async () => {
    const branchPrStatus = vi.fn(async () => ({
      number: 7,
      title: 'feat: x',
      url: 'https://gh/pr/7',
      phase: 'open' as const,
      pipeline: 'success' as const,
      checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
      mergeable: true,
    }));
    const branches = {
      current: vi.fn(async () => 'feat/x'),
      switchable: vi.fn(async () => [] as string[]),
      previewable: vi.fn(async () => [] as string[]),
      switch: vi.fn(),
    };
    const prApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: branches as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus,
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      // Cold read: the hot path never blocks on git/GitHub, so it returns no marker
      // yet and schedules a background refresh.
      const cold = await prApp.inject({ method: 'GET', url: '/sessions' });
      expect(cold.json()[0].pr).toBeUndefined();
      // Once the refresh lands, only the compact projection (phase/pipeline/mergeable)
      // is attached — not the PR's title/url/checks.
      await vi.waitFor(async () => {
        const res = await prApp.inject({ method: 'GET', url: '/sessions' });
        expect(res.json()[0].pr).toEqual({ phase: 'open', pipeline: 'success', mergeable: true });
      });
      expect(branchPrStatus).toHaveBeenCalledWith('feat/x', '/wt/s1');
    } finally {
      await prApp.close();
    }
  });

  it('automatically asks the agent to fix failed CI from the overview PR refresh', async () => {
    const branchPrStatus = vi.fn(async () => ({
      number: 7,
      title: 'feat: x',
      url: 'https://gh/pr/7',
      phase: 'open' as const,
      headSha: 'abc123',
      pipeline: 'failure' as const,
      checks: { completed: 2, total: 2, successful: 1, failed: 1, pending: 0 },
      mergeable: false,
    }));
    const branches = {
      current: vi.fn(async () => 'feat/x'),
      switchable: vi.fn(async () => [] as string[]),
      previewable: vi.fn(async () => [] as string[]),
      switch: vi.fn(),
    };
    const prApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: branches as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus,
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      await prApp.inject({ method: 'GET', url: '/sessions' });
      await vi.waitFor(() => {
        expect(dispatchTurnWhenIdle).toHaveBeenCalledWith(
          's1',
          expect.stringContaining('1/2 checks are failing'),
          undefined,
          { displayPrompt: 'Fix failing CI for PR #7' },
        );
      });
    } finally {
      await prApp.close();
    }
  });

  // A Forgejo PR described as a GitHub one sends the agent to `gh` and GitHub
  // Actions, which cannot see it; the repair turn must name the real host.
  it('names the Forgejo code host in the CI repair turn of a Forgejo project', async () => {
    await ctx.store.forgeConnections.upsert({
      id: 'repair-forgejo',
      provider: 'forgejo',
      baseUrl: 'https://git.example.org',
      label: 'Forgejo',
      personalToken: 'fixture',
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKey: null,
    });
    await ctx.store.upsertProject({
      id: 'repair-forgejo-project',
      kind: 'forgejo',
      forgeConnectionId: 'repair-forgejo',
      owner: 'team',
      repo: 'site',
      containerName: 'forgejo-team-site',
      state: 'active',
    });
    const branchPrStatus = vi.fn(async () => ({
      number: 7,
      title: 'feat: x',
      url: 'https://git.example.org/team/site/pulls/7',
      phase: 'open' as const,
      headSha: 'abc123',
      pipeline: 'failure' as const,
      checks: { completed: 2, total: 2, successful: 1, failed: 1, pending: 0 },
      mergeable: false,
    }));
    const prApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: {
        current: vi.fn(async () => 'feat/x'),
        switchable: vi.fn(async () => [] as string[]),
        previewable: vi.fn(async () => [] as string[]),
        switch: vi.fn(),
      } as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus,
    });
    try {
      await ctx.store.createSession({
        sessionId: 's1',
        worktree: '/wt/s1',
        model: 'm',
        projectId: 'repair-forgejo-project',
      });
      await prApp.inject({ method: 'GET', url: '/sessions' });
      await vi.waitFor(() => expect(dispatchTurnWhenIdle).toHaveBeenCalled());
      const prompt = String(dispatchTurnWhenIdle.mock.calls.at(-1)?.[1]);
      expect(prompt).toContain('Forgejo pull request #7');
      expect(prompt).not.toContain('GitHub');
      // verity-repo reads no check logs, so the turn must not send the agent after them.
      expect(prompt).toContain('reproduce them locally');
    } finally {
      await prApp.close();
    }
  });

  it('resolves the `pr` marker across a multi-branch session, not just the worktree HEAD', async () => {
    // Repro (k8s "Audit" session): the worktree HEAD (agent/x) has no PR, but a
    // branch the session pushed does. The overview must still mark the session, so the
    // resolver keys off `sessionBranches`, not `current`.
    const branchPrStatusForBranches = vi.fn(async (bs: readonly string[]) => {
      expect(bs).toEqual(['agent/x', 'security/audit-phase5']);
      return {
        number: 1510,
        title: 'security: egress justification',
        url: 'https://gh/pr/1510',
        phase: 'open' as const,
        pipeline: 'success' as const,
        checks: { completed: 1, total: 1, successful: 1, failed: 0, pending: 0 },
        mergeable: true,
      };
    });
    const branches = {
      current: vi.fn(async () => 'agent/x'),
      sessionBranches: vi.fn(async () => ['agent/x', 'security/audit-phase5']),
      switchable: vi.fn(async () => [] as string[]),
      previewable: vi.fn(async () => [] as string[]),
      switch: vi.fn(),
    };
    const prApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: branches as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      // Both are wired in production; branchPrStatus stays the "GitHub configured"
      // signal while branchPrStatusForBranches does the multi-branch pick.
      branchPrStatus: vi.fn(async () => null),
      branchPrStatusForBranches,
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      await prApp.inject({ method: 'GET', url: '/sessions' });
      await vi.waitFor(async () => {
        const res = await prApp.inject({ method: 'GET', url: '/sessions' });
        expect(res.json()[0].pr).toEqual({ phase: 'open', pipeline: 'success', mergeable: true });
      });
      expect(branchPrStatusForBranches).toHaveBeenCalledWith(
        ['agent/x', 'security/audit-phase5'],
        '/wt/s1',
      );
    } finally {
      await prApp.close();
    }
  });

  it('does not re-hit GitHub on every poll while the PR lookup keeps failing', async () => {
    // Regression: a persistent git/GitHub error must still stamp the cache entry so
    // the TTL guard engages — otherwise a rejected lookup leaves the entry unset and
    // a refresh fires on every ~2s poll (a stampede during a GitHub outage).
    const branchPrStatus = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const branches = {
      current: vi.fn(async () => 'feat/x'),
      switchable: vi.fn(async () => [] as string[]),
      previewable: vi.fn(async () => [] as string[]),
      switch: vi.fn(),
    };
    const prApp = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: branches as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchPrStatus,
    });
    try {
      await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
      // First poll schedules the background refresh; wait for it to fail once.
      await prApp.inject({ method: 'GET', url: '/sessions' });
      await vi.waitFor(() => expect(branchPrStatus).toHaveBeenCalledTimes(1));
      // Further polls within the TTL must not re-schedule it despite the failure.
      for (let i = 0; i < 3; i += 1) await prApp.inject({ method: 'GET', url: '/sessions' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(branchPrStatus).toHaveBeenCalledTimes(1);
    } finally {
      await prApp.close();
    }
  });
});

describe('GET /search/messages', () => {
  it('returns scoped visible-message matches with navigation anchors', async () => {
    await createExistingSession('search-1');
    await createExistingSession('search-2');
    await ctx.store.appendEvent('search-1', { t: 'prompt', text: 'global search needle' });
    await ctx.store.appendEvent('search-2', { t: 'prompt', text: 'global search needle' });

    const response = await app.inject({
      method: 'GET',
      url: '/search/messages?q=search+needle&sessionId=search-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          sessionId: 'search-1',
          role: 'user',
          kind: 'prompt',
          text: 'global search needle',
          firstEventSeq: expect.any(Number),
        },
      ],
    });
  });

  it('rejects malformed cursors as a client error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/search/messages?q=needle&cursor=not-json',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /provider-limits', () => {
  it('uses the Claude credentials JSON stored in Verity settings for provider limits', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'db-claude-token',
          refreshToken: 'db-refresh-token',
          expiresAt: 4102444800000,
        },
      }),
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: '2026-07-09T21:00:00.000Z' },
      }),
    } as Response);
    const app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          status: 'allowed',
          resetsAt: 1783630800,
          window: 'five_hour',
          usedPercent: 42,
          providerLabel: 'Claude',
          observedAt: expect.any(Number),
        },
      ]);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer db-claude-token' }),
        }),
      );
    } finally {
      await app.close();
      fetch.mockRestore();
    }
  });

  it('refreshes stored Claude credentials JSON before probing provider limits', async () => {
    await ctx.store.updateVeritySettings({
      claudeCodeOauthCredentialsJson: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-db-token',
          refreshToken: 'db-refresh-token',
          expiresAt: 1,
        },
      }),
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-db-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 17, resets_at: '2026-07-09T21:00:00.000Z' },
        }),
      } as Response);
    const persistAgentCredentials = vi.fn(async (_patch: unknown, persist: () => Promise<void>) =>
      persist(),
    );
    const app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      persistAgentCredentials,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          status: 'allowed',
          resetsAt: 1783630800,
          window: 'five_hour',
          usedPercent: 17,
          providerLabel: 'Claude',
          observedAt: expect.any(Number),
        },
      ]);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://platform.claude.com/v1/oauth/token',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer fresh-db-token' }),
        }),
      );
      const settings = await ctx.store.getVeritySettings();
      expect(settings?.claudeCodeOauthCredentialsJson).toContain('fresh-refresh-token');
      expect(persistAgentCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeCodeOauthCredentialsJson: expect.stringContaining('fresh-refresh-token'),
        }),
        expect.any(Function),
      );
    } finally {
      await app.close();
      fetch.mockRestore();
    }
  });

  it('returns cached account-global provider limits from the Claude usage service', async () => {
    const limits = [
      {
        status: 'allowed',
        resetsAt: 1_700_000_100,
        window: 'five_hour' as const,
        usedPercent: 33,
        providerLabel: 'Claude',
      },
      {
        status: 'rejected',
        resetsAt: 1_700_000_200,
        window: 'weekly' as const,
        usedPercent: 100,
        providerLabel: 'Claude',
      },
    ];
    const getLimits = vi.fn(async () => limits);
    const withProviderLimits = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      claudeUsage: { getLimits },
    });
    try {
      const res = await withProviderLimits.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(limits);
      expect(getLimits).toHaveBeenCalledOnce();
    } finally {
      await withProviderLimits.close();
    }
  });

  it('serves the Codex account-global quota next to Claude', async () => {
    // Codex's own per-turn events only advance while an interactive session runs,
    // so the probe is what keeps the Codex meter true; the route must merge both.
    const claudeLimits = [
      {
        status: 'allowed',
        resetsAt: 1_700_000_100,
        window: 'five_hour' as const,
        usedPercent: 33,
        providerLabel: 'Claude',
        observedAt: 1_700_000_000_000,
      },
    ];
    const codexLimits = [
      {
        status: 'allowed',
        resetsAt: 1_700_000_300,
        window: 'weekly' as const,
        usedPercent: 95,
        providerLabel: 'Codex',
        observedAt: 1_700_000_000_000,
      },
    ];
    const codexGetLimits = vi.fn(async () => codexLimits);
    const withBothProbes = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      claudeUsage: { getLimits: async () => claudeLimits },
      codexUsage: { getLimits: codexGetLimits, health: () => ({ state: 'pending' }) as const },
    });
    try {
      const res = await withBothProbes.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([...claudeLimits, ...codexLimits]);
      expect(codexGetLimits).toHaveBeenCalledOnce();
    } finally {
      await withBothProbes.close();
    }
  });

  it('leaves the Codex half empty when no gateway credential provider is wired', async () => {
    const app = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      claudeUsage: { getLimits: async () => [] },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('overview projections read only the narrow event slice', () => {
  const resultEvent = {
    t: 'result' as const,
    usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason: 'end_turn',
  };

  /** A log whose bulk is transcript text — the shape the overview must not load. */
  const seedChattySession = async (sessionId: string): Promise<void> => {
    await ctx.store.createSession({ sessionId, worktree: `/wt/${sessionId}`, model: 'm' });
    await ctx.store.appendEvent(sessionId, { t: 'prompt', text: 'go' });
    for (let i = 0; i < 20; i += 1) {
      await ctx.store.appendEvent(sessionId, { t: 'text', delta: `chunk ${i}` });
    }
    await ctx.store.appendEvent(sessionId, resultEvent);
  };

  // The regression this guards is invisible from the response: hydrating whole
  // logs produces byte-identical output and only shows up as latency that grows
  // with history, on the three routes the app polls hardest.
  it('answers list, detail and activity without hydrating a full log', async () => {
    await seedChattySession('s-chatty');
    const getEvents = vi.spyOn(ctx.store, 'getEvents');
    const getEventsAfter = vi.spyOn(ctx.store, 'getEventsAfter');
    const countingReads = vi.spyOn(ctx.store, 'listSessionProjectionFacts');
    const sliceOnlyReads = vi.spyOn(ctx.store, 'listSessionProjectionEvents');
    const tailReads = vi.spyOn(ctx.store, 'listRecentSessionProjectionEvents');
    try {
      const list = await app.inject({ method: 'GET', url: '/sessions' });
      expect(list.json()).toHaveLength(1);
      expect(list.json()[0]).toMatchObject({
        sessionId: 's-chatty',
        status: 'completed',
        eventCount: 20,
        usage: { inputTokens: 5, outputTokens: 7 },
      });

      const detail = await app.inject({ method: 'GET', url: '/sessions/s-chatty' });
      expect(detail.json()).toMatchObject({
        status: 'completed',
        eventCount: 20,
        usage: { inputTokens: 5, outputTokens: 7 },
      });

      const activity = await app.inject({ method: 'GET', url: '/sessions/s-chatty/activity' });
      expect(activity.json()).toMatchObject({ busy: false });

      expect(getEvents).not.toHaveBeenCalled();
      expect(getEventsAfter).not.toHaveBeenCalled();
      // Activity needs only the log's busy projection; reading overview facts
      // would also hydrate usage and quota data that this response never returns.
      expect(countingReads).toHaveBeenCalledTimes(2);
      expect(tailReads).toHaveBeenCalledTimes(1);
      expect(sliceOnlyReads).not.toHaveBeenCalled();
    } finally {
      getEvents.mockRestore();
      getEventsAfter.mockRestore();
      countingReads.mockRestore();
      sliceOnlyReads.mockRestore();
      tailReads.mockRestore();
    }
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
    const originalRead = ctx.store.listSessionProjectionEvents.bind(ctx.store);
    let active = 0;
    let peak = 0;
    const reads = vi
      .spyOn(ctx.store, 'listSessionProjectionEvents')
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
      expect(reads).toHaveBeenCalledTimes(24);
      expect(peak).toBe(1);
      reads.mockRejectedValueOnce(new Error('projection read failed'));
      const failed = await app.inject({ method: 'GET', url: '/sessions/fallback-0' });
      expect(failed.statusCode).toBe(500);
      const recovered = await app.inject({ method: 'GET', url: '/sessions/fallback-0' });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ status: 'running' });
    } finally {
      facts.mockRestore();
      reads.mockRestore();
    }
  });

  it('falls back to the full projection when the recent tail misses the turn boundary', async () => {
    await ctx.store.createSession({ sessionId: 's-long-turn', worktree: '/wt/long', model: 'm' });
    await ctx.store.appendEvent('s-long-turn', { t: 'prompt', text: 'go' });
    for (let i = 0; i <= 200; i += 1) {
      await ctx.store.appendEvent('s-long-turn', { t: 'status', state: 'running' });
    }
    const tailReads = vi.spyOn(ctx.store, 'listRecentSessionProjectionEvents');
    const fullReads = vi.spyOn(ctx.store, 'listSessionProjectionEvents');
    try {
      const activity = await app.inject({ method: 'GET', url: '/sessions/s-long-turn/activity' });
      expect(activity.json()).toMatchObject({ busy: false });
      expect(tailReads).toHaveBeenCalledTimes(1);
      expect(fullReads).toHaveBeenCalledTimes(1);
    } finally {
      tailReads.mockRestore();
      fullReads.mockRestore();
    }
  });

  it('keeps the whole-log task gate when an accepted tail no longer contains the task', async () => {
    await ctx.store.createSession({ sessionId: 's-old-task', worktree: '/wt/task', model: 'm' });
    await ctx.store.appendEvent('s-old-task', { t: 'task', id: 'old', phase: 'started' });
    for (let i = 0; i < 5; i += 1) {
      await ctx.store.appendEvent('s-old-task', { t: 'status', state: 'running' });
    }
    await ctx.store.appendEvent('s-old-task', { t: 'prompt', text: 'new turn' });
    for (let i = 0; i < 198; i += 1) {
      await ctx.store.appendEvent('s-old-task', { t: 'status', state: 'running' });
    }

    const fullReads = vi.spyOn(ctx.store, 'listSessionProjectionEvents');
    const taskChecks = vi.spyOn(ctx.store, 'sessionHasTaskLifecycleEvent');
    try {
      const activity = await app.inject({ method: 'GET', url: '/sessions/s-old-task/activity' });
      expect(activity.json()).toMatchObject({ busy: true });
      expect(taskChecks).toHaveBeenCalledTimes(1);
      expect(fullReads).not.toHaveBeenCalled();
    } finally {
      fullReads.mockRestore();
      taskChecks.mockRestore();
    }
  });

  it('still reports a session whose log holds nothing the projection reads as running', async () => {
    // The count is what separates this from an untouched session; without it the
    // filtered log would read as empty and badge `idle` mid-turn.
    await ctx.store.createSession({ sessionId: 's-quiet', worktree: '/wt/s-quiet', model: 'm' });
    await ctx.store.appendEvent('s-quiet', { t: 'text', delta: 'streaming…' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s-quiet' });
    expect(res.json()).toMatchObject({ status: 'running', eventCount: 1 });

    await ctx.store.createSession({ sessionId: 's-fresh', worktree: '/wt/s-fresh', model: 'm' });
    const fresh = await app.inject({ method: 'GET', url: '/sessions/s-fresh' });
    expect(fresh.json()).toMatchObject({ status: 'idle', eventCount: 0 });
  });

  it('keeps a session with an open background task busy on the activity poll', async () => {
    // The activity route reads the log ONLY to catch this case, so narrowing that
    // read must not lose it: the turn's result already landed while the task runs.
    await ctx.store.createSession({ sessionId: 's-task', worktree: '/wt/s-task', model: 'm' });
    await ctx.store.appendEvent('s-task', { t: 'prompt', text: 'go' });
    await ctx.store.appendEvent('s-task', { t: 'task', id: 'bg1', phase: 'started' });
    await ctx.store.appendEvent('s-task', { t: 'text', delta: 'working' });
    await ctx.store.appendEvent('s-task', resultEvent);
    const res = await app.inject({ method: 'GET', url: '/sessions/s-task/activity' });
    expect(res.json()).toMatchObject({ busy: true });
  });
});

describe('activity polls reuse unchanged log state', () => {
  let server: FastifyInstance;
  const result = {
    t: 'result' as const,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stopReason: 'end_turn',
  };
  const poll = () => server.inject({ method: 'GET', url: '/sessions/activity-cache/activity' });

  beforeEach(async () => {
    server = buildServer({ eventStore: ctx.store, bus, conductor });
    await ctx.store.createSession({
      sessionId: 'activity-cache',
      worktree: '/wt/cache',
      model: 'm',
    });
    await ctx.store.appendEvent('activity-cache', { t: 'task', id: 'bg', phase: 'started' });
    await ctx.store.appendEvent('activity-cache', result);
  });
  afterEach(async () => {
    await server.close();
  });

  it('hydrates once across repeated polls and refreshes after task completion and interruption', async () => {
    const reads = vi.spyOn(ctx.store, 'listRecentSessionProjectionEvents');
    try {
      expect((await poll()).json()).toMatchObject({ busy: true });
      expect((await poll()).json()).toMatchObject({ busy: true });
      expect(reads).toHaveBeenCalledTimes(1);
      await ctx.store.appendEvent('activity-cache', {
        t: 'task',
        id: 'bg',
        phase: 'ended',
        status: 'completed',
      });
      expect((await poll()).json()).toMatchObject({ busy: false });
      await ctx.store.appendEvent('activity-cache', { t: 'task', id: 'another', phase: 'started' });
      expect((await poll()).json()).toMatchObject({ busy: true });
      await ctx.store.appendEvent('activity-cache', { t: 'interrupted' });
      expect((await poll()).json()).toMatchObject({ busy: false });
      expect(reads).toHaveBeenCalledTimes(4);
    } finally {
      reads.mockRestore();
    }
  });

  it('keeps conductor fields and renamed metadata live while the log is cached', async () => {
    await ctx.store.appendEvent('activity-cache', { t: 'interrupted' });
    expect((await poll()).json()).toMatchObject({ busy: false });
    isBusy.mockReturnValue(true);
    pendingPermissions.mockReturnValue(['permission-now']);
    hasUnconfirmedTermination.mockReturnValue(true);
    await ctx.store.renameSession('activity-cache', 'Renamed');
    expect((await poll()).json()).toMatchObject({
      busy: true,
      pendingPermissions: ['permission-now'],
      terminationUnconfirmed: true,
      name: 'Renamed',
    });
    isBusy.mockReturnValue(false);
    pendingPermissions.mockReturnValue([]);
    expect((await poll()).json()).toMatchObject({ busy: false, pendingPermissions: [] });
  });

  it('invalidates on removal below the maximum sequence and session recreation', async () => {
    expect((await poll()).json()).toMatchObject({ busy: true });
    await ctx.db
      .deleteFrom('events')
      .where('session_id', '=', 'activity-cache')
      .where('type', '=', 'task')
      .execute();
    expect((await poll()).json()).toMatchObject({ busy: false });
    await ctx.store.deleteSession('activity-cache');
    expect((await poll()).statusCode).toBe(404);
    await ctx.store.createSession({ sessionId: 'activity-cache', worktree: '/wt/new', model: 'm' });
    await ctx.store.appendEvent('activity-cache', { t: 'task', id: 'new', phase: 'started' });
    await ctx.store.appendEvent('activity-cache', result);
    expect((await poll()).json()).toMatchObject({ busy: true });
  });

  it('refreshes when an older sequence commits without advancing the maximum', async () => {
    const original = await ctx.db
      .selectFrom('events')
      .select(['id'])
      .where('session_id', '=', 'activity-cache')
      .where('type', '=', 'task')
      .executeTakeFirstOrThrow();
    await ctx.db.deleteFrom('events').where('id', '=', original.id).execute();
    expect((await poll()).json()).toMatchObject({ busy: false });
    await ctx.db
      .insertInto('events')
      .values({
        id: original.id,
        session_id: 'activity-cache',
        type: 'task',
        payload: JSON.stringify({ t: 'task', id: 'late', phase: 'started' }),
      })
      .execute();
    expect((await poll()).json()).toMatchObject({ busy: true });
  });

  it('does not reuse a matching revision when a session is recreated between polls', async () => {
    expect((await poll()).json()).toMatchObject({ busy: true });
    const previous = await ctx.store.getSessionEventStats('activity-cache');
    await ctx.store.deleteSession('activity-cache');
    await ctx.store.createSession({
      sessionId: 'activity-cache',
      worktree: '/wt/recreated',
      model: 'm',
    });
    await ctx.store.appendEvent('activity-cache', { t: 'prompt', text: 'new turn' });
    await ctx.store.appendEvent('activity-cache', result);
    const recreated = await ctx.store.getSessionEventStats('activity-cache');
    expect(recreated?.revision).toBe(previous?.revision);
    expect(recreated?.lastEventSeq).not.toBe(previous?.lastEventSeq);
    expect((await poll()).json()).toMatchObject({ busy: false });
  });

  it('shares simultaneous projection reads and retries after a failed read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realRead = ctx.store.listRecentSessionProjectionEvents.bind(ctx.store);
    const reads = vi
      .spyOn(ctx.store, 'listRecentSessionProjectionEvents')
      .mockImplementationOnce(async () => {
        await gate;
        throw new Error('temporary read failure');
      })
      .mockImplementation(realRead);
    try {
      const first = poll();
      const second = poll();
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
      release();
      expect((await first).json()).toMatchObject({ busy: false });
      expect((await second).json()).toMatchObject({ busy: false });
      expect((await poll()).json()).toMatchObject({ busy: true });
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      release();
      reads.mockRestore();
    }
  });
});

describe('the session branch label is cached between activity polls', () => {
  const cachedBranchServer = (): FastifyInstance =>
    buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
    });

  it('reads git once across polls and again after an operator switch', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = cachedBranchServer();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      const first = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(first.json()).toMatchObject({ branch: 'feat/a' });

      // A second poll 1.5 s later must not spawn another git/docker call.
      branchSvc.current.mockResolvedValue('feat/b');
      const second = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(second.json()).toMatchObject({ branch: 'feat/a' });
      expect(branchSvc.current).toHaveBeenCalledTimes(1);

      // The operator's own switch is visible to the server, so it drops the label
      // rather than showing the old branch until the TTL runs out.
      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);
      const third = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(third.json()).toMatchObject({ branch: 'feat/b' });
    } finally {
      await server.close();
    }
  });

  it('converges on a branch changed from inside the sandbox once the TTL passes', async () => {
    // The case no invalidation hook can see: the agent checks out its own work
    // inside the worktree. A cache that only ever refreshed on the switch route
    // would pin the header to a branch the session left — the TTL is the only
    // thing that makes the label converge, so it is the thing worth guarding.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchCacheTtlMs: 1,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      const first = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(first.json()).toMatchObject({ branch: 'feat/a' });

      branchSvc.current.mockResolvedValue('agent/self-checkout');
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Stale-while-revalidate: this poll still answers 'feat/a' and refreshes
      // behind the response, so the NEXT poll is the one that shows the change.
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      const settled = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(settled.json()).toMatchObject({ branch: 'agent/self-checkout' });
    } finally {
      await server.close();
    }
  });

  it('discards a refresh that was already reading git when the operator switched', async () => {
    // The refresh read git BEFORE the switch, so its answer is the branch the
    // session just left. Writing it back after the invalidation would pin the
    // header to the old branch for a full TTL — the cache undoing the one
    // invalidation that exists to correct it, and only under the interleaving
    // nobody reproduces by hand.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      branchCacheTtlMs: 1,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      // Hold the next git read open so the switch below lands mid-flight.
      let answerHeldRead: (branch: string) => void = () => {};
      branchSvc.current.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          answerHeldRead = resolve;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);

      // Only now does the held read answer — with the pre-switch branch.
      answerHeldRead('feat/a');
      await new Promise((resolve) => setImmediate(resolve));

      branchSvc.current.mockResolvedValue('feat/b');
      const after = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(after.json()).toMatchObject({ branch: 'feat/b' });
    } finally {
      await server.close();
    }
  });

  it('discards a COLD read that was already reading git when the operator switched', async () => {
    // The same race one step earlier, and the one a `delete` cannot cover: on a
    // session's first poll there is no cache entry for the invalidation to drop,
    // so an undisownable cold read lands the pre-switch branch on the empty slot
    // and pins the header there for a full TTL — with no second git call due for
    // ten seconds to correct it.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = cachedBranchServer();
    try {
      let answerHeldRead: (branch: string) => void = () => {};
      branchSvc.current.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          answerHeldRead = resolve;
        }),
      );
      // Left unawaited on purpose: a cold read blocks its own response, so the
      // switch below has to be issued while this poll is still inside git.
      const coldPoll = server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(1));

      branchSvc.switch.mockResolvedValue('feat/b');
      const switched = await server.inject({
        method: 'POST',
        url: '/sessions/s1/branch',
        payload: { branch: 'feat/b' },
      });
      expect(switched.statusCode).toBe(200);

      // The old read is still unresolved. A poll in this window must not join
      // it merely because its token remains in the single-flight map.
      branchSvc.current.mockResolvedValueOnce('feat/b');
      const afterSwitch = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(afterSwitch.json()).toMatchObject({ branch: 'feat/b' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);

      answerHeldRead('feat/a');
      // The poll that asked still hears what git said — it is the CACHE that must
      // not keep the answer.
      expect((await coldPoll).json()).toMatchObject({ branch: 'feat/a' });

      branchSvc.current.mockResolvedValue('feat/b');
      const after = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(after.json()).toMatchObject({ branch: 'feat/b' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it('paces a failing refresh like a successful one', async () => {
    // A refresh that rejects must still advance the entry's clock. Otherwise the
    // first git failure turns the cache back into a per-poll git call — every
    // 1.5 s, per open session, against a worktree that is already unhappy.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      branches: branchSvc as unknown as NonNullable<Parameters<typeof buildServer>[0]['branches']>,
      // The window has to outlast everything between the failed refresh settling
      // and the third request below — `vi.waitFor` polling included — on a loaded
      // machine running the whole suite in parallel. A tight window here does not
      // test the pacing harder, it just makes the guard flaky.
      branchCacheTtlMs: 1_000,
    });
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      branchSvc.current.mockRejectedValue(new Error('git boom'));
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      await vi.waitFor(() => expect(branchSvc.current).toHaveBeenCalledTimes(2));

      // Well inside the window the failed attempt just started: no third call,
      // and the last known good label is still what the header gets.
      const during = await server.inject({ method: 'GET', url: '/sessions/s1/activity' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
      expect(during.json()).toMatchObject({ branch: 'feat/a' });
    } finally {
      await server.close();
    }
  });

  it('drops the label of a worktree that no longer exists', async () => {
    // Keyed by worktree, so without eviction a long-lived server accumulates one
    // entry per session ever created — and a recreated worktree of the same path
    // would be answered from the deleted session's label for a whole TTL window.
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.createSession({ sessionId: 's2', worktree: '/wt/s2', model: 'm' });
    const server = cachedBranchServer();
    try {
      branchSvc.current.mockResolvedValue('feat/a');
      await server.inject({ method: 'GET', url: '/sessions/s1/activity' });

      await ctx.store.deleteSession('s1');
      // The full list is where every live worktree is visible at once, so it is
      // where the eviction happens.
      await server.inject({ method: 'GET', url: '/sessions' });

      await ctx.store.createSession({ sessionId: 's3', worktree: '/wt/s1', model: 'm' });
      branchSvc.current.mockResolvedValue('feat/reused');
      const reused = await server.inject({ method: 'GET', url: '/sessions/s3/activity' });
      expect(reused.json()).toMatchObject({ branch: 'feat/reused' });
      expect(branchSvc.current).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });
});

describe('GET /projects/:id release resolution', () => {
  it('serves the cached release instead of blocking the request on GitHub', async () => {
    await ctx.store.upsertProject({
      id: 'p-detail-rel',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const release: ReleaseSummary = {
      tag: 'v2.0.0',
      name: 'Release 2.0.0',
      url: 'https://github.com/heey-global/verity/releases/tag/v2.0.0',
      publishedAt: '2026-08-01T10:00:00Z',
    };
    const refreshLatestRelease = vi.fn(async () => release);
    const withRelease = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      latestRelease: () => release,
      refreshLatestRelease,
    });
    try {
      const res = await withRelease.inject({ method: 'GET', url: '/projects/p-detail-rel' });
      expect(res.json().project).toMatchObject({ latestReleaseTag: 'v2.0.0' });
      // The detail screen polls every 15 s; awaiting a refresh there put a GitHub
      // round trip in front of every one of them.
      expect(refreshLatestRelease).not.toHaveBeenCalled();
    } finally {
      await withRelease.close();
    }
  });

  it('still awaits one refresh while the release cache is cold', async () => {
    // This is what populates the badge on deployments with no PAT, where the
    // non-blocking cache can only be filled by an awaited lookup.
    await ctx.store.upsertProject({
      id: 'p-detail-cold',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const refreshLatestRelease = vi.fn(async () => ({
      tag: 'v2.1.0',
      name: 'Release 2.1.0',
      url: 'https://github.com/heey-global/verity/releases/tag/v2.1.0',
      publishedAt: '2026-08-02T10:00:00Z',
    }));
    const withRelease = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      latestRelease: () => undefined,
      refreshLatestRelease,
    });
    try {
      const res = await withRelease.inject({ method: 'GET', url: '/projects/p-detail-cold' });
      expect(res.json().project).toMatchObject({ latestReleaseTag: 'v2.1.0' });
      expect(refreshLatestRelease).toHaveBeenCalledTimes(1);
    } finally {
      await withRelease.close();
    }
  });
});

describe('PATCH /sessions/order', () => {
  it('requires a device bearer and exposes manual positions through the overview', async () => {
    await ctx.store.createSession({ sessionId: 'order-a', worktree: '/wt/order-a', model: 'm' });
    await ctx.store.createSession({ sessionId: 'order-b', worktree: '/wt/order-b', model: 'm' });
    const history = (await ctx.store.listSessions()).map((session) => session.sessionId);
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const { token } = await registry.mint('order-device');
    const gated = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor,
      authRegistry: registry,
    });
    try {
      const request = {
        method: 'PATCH' as const,
        url: '/sessions/order',
        payload: { projectId: null, ids: ['order-b', 'order-a'] },
      };
      expect((await gated.inject(request)).statusCode).toBe(401);
      const result = await gated.inject({
        ...request,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ ids: ['order-b', 'order-a'] });
      const overview = await gated.inject({
        url: '/sessions?envelope=1',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = overview.json<{
        sessionReordering: boolean;
        sessions: { sessionId: string; sortOrder: number }[];
      }>();
      expect(body.sessionReordering).toBe(true);
      expect(body.sessions.map((session) => [session.sessionId, session.sortOrder])).toEqual([
        ['order-a', 1],
        ['order-b', 0],
      ]);
      expect((await ctx.store.listSessions()).map((session) => session.sessionId)).toEqual(history);
    } finally {
      await gated.close();
    }
  });
});

describe('vulnerability scan session integration', () => {
  it('scans a paused project only after its manual start finishes and leaves it active', async () => {
    const id = 'vuln-paused-start';
    await ctx.store.upsertProject({
      id,
      owner: 'test',
      repo: id,
      containerName: id,
      state: 'absent',
    });
    await ctx.store.vulnerabilityScans.setSettings({ enabled: true, schedule: null });
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const provision = vi.fn(async (projectId: string) => {
      await ready;
      return (await ctx.store.updateProjectState(projectId, 'active'))!;
    });
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        worktree: '/work/.verity-vuln-test1234/tree',
        hash: 'a'.repeat(64),
        revision: 'b'.repeat(40),
        lockfiles: [],
      }),
      stderr: '',
      timedOut: false,
    }));
    const runtime = {
      runAutomationScript: run,
    } as unknown as import('./project-runtime.js').ProjectRuntime;
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      provisioner: { provision },
      projectRuntime: runtime,
    });
    try {
      expect(
        (await server.inject({ method: 'POST', url: `/projects/${id}/repair` })).statusCode,
      ).toBe(202);
      expect(provision).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(async () =>
        expect((await ctx.store.vulnerabilityScans.getState(id))?.status).toBe('no_lockfiles'),
      );
      expect((await ctx.store.getProject(id))?.state).toBe('active');
      expect(startSession).not.toHaveBeenCalled();
      expect(sendTurn).not.toHaveBeenCalled();
    } finally {
      finish();
      await server.close();
    }
  });

  it.each(['success', 'failure', 'takeover', 'takeover-while-waking'] as const)(
    'temporarily wakes a sleeping project for a manual scan: %s',
    async (scenario) => {
      const id = `vuln-sleeper-${scenario}`;
      await ctx.store.upsertProject({
        id,
        owner: 'test',
        repo: id,
        containerName: id,
        state: 'sleeping',
      });
      await ctx.store.vulnerabilityScans.setSettings({ enabled: true, schedule: null });
      let activity = 0;
      const touch = () => {
        activity++;
      };
      const wakeProject = vi.fn(async (projectId: string) => {
        touch();
        return (await ctx.store.updateProjectState(projectId, 'active'))!;
      });
      const sleepProject = vi.fn(
        async (projectId: string, options?: { shouldRestore?: () => boolean }) => {
          if (options?.shouldRestore && !options.shouldRestore())
            return (await ctx.store.getProject(projectId))!;
          return (await ctx.store.updateProjectState(projectId, 'sleeping'))!;
        },
      );
      const provisioner = {
        provision: vi.fn(),
        wakeProject,
        wakeProjectForScan: async (projectId: string) => {
          const waking = wakeProject(projectId);
          const activityAt = activity;
          return { project: await waking, owned: true, activityAt };
        },
        sleepProject,
        ensureProjectSandboxAwake: async (projectId: string) => {
          touch();
          return (await ctx.store.getProject(projectId))!;
        },
        tryBeginProjectSandboxActivity: () => {
          touch();
          return true;
        },
        endProjectSandboxActivity: touch,
        projectSandboxLastActivityAt: () => activity,
      };
      const runtime = {
        runAutomationScript: async (
          _project: unknown,
          _settings: unknown,
          input: { script: string },
        ) => {
          if (input.script.includes('mktemp')) {
            if (scenario === 'failure') throw new Error('scan preparation failed');
            if (scenario === 'takeover-while-waking') {
              // The user taps Wake while the scan's own wake has not finished yet.
              await ctx.store.updateProjectState(id, 'waking');
              expect(
                (await server.inject({ method: 'POST', url: `/projects/${id}/wake` })).statusCode,
              ).toBe(200);
              await ctx.store.updateProjectState(id, 'active');
            }
            if (scenario === 'takeover')
              expect(
                (await server.inject({ method: 'POST', url: `/projects/${id}/wake` })).statusCode,
              ).toBe(200);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                worktree: '/work/.verity-vuln-test1234/tree',
                hash: 'a'.repeat(64),
                revision: 'b'.repeat(40),
                lockfiles: [],
              }),
              stderr: '',
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      } as unknown as import('./project-runtime.js').ProjectRuntime;
      const server = buildServer({
        eventStore: ctx.store,
        bus,
        conductor,
        provisioner,
        projectRuntime: runtime,
      });
      try {
        expect(
          (await server.inject({ method: 'POST', url: `/projects/${id}/vulnerability-scan` }))
            .statusCode,
        ).toBe(202);
        await vi.waitFor(async () =>
          expect((await ctx.store.vulnerabilityScans.getState(id))?.status).toBe(
            scenario === 'failure' ? 'error' : 'no_lockfiles',
          ),
        );
        expect(wakeProject).toHaveBeenCalledOnce();
        const takenOver = scenario === 'takeover' || scenario === 'takeover-while-waking';
        expect((await ctx.store.getProject(id))?.state).toBe(takenOver ? 'active' : 'sleeping');
        expect(sleepProject).toHaveBeenCalledTimes(takenOver ? 0 : 1);
        expect(startSession).not.toHaveBeenCalled();
        expect(sendTurn).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );

  it('hydrates summary warnings and scans after an interrupted turn without starting an agent', async () => {
    await ctx.store.upsertProject({
      id: 'vuln-project',
      owner: 'test',
      repo: 'vuln',
      containerName: 'vuln',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'vuln-session',
      worktree: '/work/session',
      projectId: 'vuln-project',
      model: 'm',
    });
    await ctx.store.vulnerabilityScans.setSettings({ enabled: true, sessionChanges: true });
    const finding = {
      category: 'security' as const,
      classificationSource: 'osv',
      classificationVersion: 1,
      advisoryId: 'GHSA-example',
      aliases: [],
      ecosystem: 'npm',
      package: 'example',
      version: '1',
      severity: 'high' as const,
      summary: '',
      fixedVersions: [],
      source: 'package-lock.json',
      dev: false,
      modified: null,
    };
    await ctx.store.vulnerabilityScans.putCached('integration-main', [finding]);
    await ctx.store.vulnerabilityScans.putCached('integration-session', [
      finding,
      { ...finding, package: 'added' },
    ]);
    for (const sessionId of [null, 'vuln-session'])
      await ctx.store.vulnerabilityScans.setState({
        projectId: 'vuln-project',
        sessionId,
        contentHash: sessionId ? 'integration-session' : 'integration-main',
        ...(sessionId ? { baseChecked: true, baseContentHash: 'integration-main' } : {}),
        status: 'ready',
        detail: null,
        revision: 'abc',
        attemptedAt: new Date(),
      });
    const server = buildServer({ eventStore: ctx.store, bus, conductor });
    try {
      await vi.waitFor(async () => {
        const sessions = (await server.inject('/sessions')).json<
          { sessionId: string; attention?: { code: string; message: string }[] }[]
        >();
        expect(sessions.find((s) => s.sessionId === 'vuln-session')?.attention).toContainEqual({
          code: 'vulnerability_new',
          message: '1 new vulnerable package',
        });
      });
      const projects = (await server.inject('/projects')).json<
        { id: string; vulnerabilitySummary?: unknown }[]
      >();
      expect(projects.find((p) => p.id === 'vuln-project')?.vulnerabilitySummary).toEqual({
        count: 1,
        critical: 0,
        high: 1,
        maintenance: 0,
        unclassified: 0,
      });
      bus.publish('vuln-session', { seq: 1, ts: Date.now(), event: { t: 'interrupted' } });
      await vi.waitFor(
        async () =>
          expect(
            (await ctx.store.vulnerabilityScans.getState('vuln-project', 'vuln-session'))?.status,
          ).toBe('unavailable'),
        { timeout: 5000 },
      );
      expect(startSession).not.toHaveBeenCalled();
      expect(sendTurn).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('GET /sessions/:id', () => {
  it('returns session detail with status and event count', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'session', id: 's1', model: 'm', worktree: '/wt/s1' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'running' });

    const res = await app.inject({ method: 'GET', url: '/sessions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      googleStatus: await sessionGoogleStatus(ctx.store, 's1'),
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
