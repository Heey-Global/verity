import { boundedHistoryResultSchema } from '@verity/events';
import { InMemoryEventBus } from '@verity/session';
import type { FastifyInstance } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDriver } from '../../store/src/pglite.js';
import { SessionStorage } from './session-storage.js';
import { createAuthTokenRegistry } from './auth.js';
import type { ReleaseSummary } from './github.js';
import { ResourceObserver } from './live/resource-observer.js';
import {
  app,
  branchSvc,
  bus,
  conductor,
  createExistingSession,
  ctx,
  hasUnconfirmedTermination,
  isBackendHandoffPending,
  isBusy,
  pendingPermissions,
  queuedItems,
  sendTurn,
  startSession,
  worktreeRoot,
} from './server-fixture.test-helper.js';
import { buildServer, redactScrollDiagnosticData, redactScrollDiagnosticEvent } from './server.js';
describe('GET /sessions/:id/activity', () => {
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
      pendingPermissionRequests: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      mockupReview: null,
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
      pendingPermissionRequests: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      mockupReview: null,
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
      pendingPermissionRequests: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: 'Auth Refactor',
      planningPlan: null,
      mockupReview: null,
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
      pendingPermissionRequests: [],
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
      pendingPermissionRequests: [],
      modelSwitchPending: false,
      terminationUnconfirmed: false,
      name: null,
      planningPlan: null,
      mockupReview: null,
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
    expect(invalidate).toHaveBeenCalledWith('/sessions/s1/activity');
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

  // The instance accounts were the administrator's: a member's meter must show
  // their own accounts' quota, never the administrator's.
  it("shows a member their own accounts' quota, not the instance's", async () => {
    const instanceLimits = vi.fn(async () => [
      {
        status: 'allowed' as const,
        resetsAt: 1_700_000_100,
        window: 'five_hour' as const,
        usedPercent: 90,
        providerLabel: 'Claude',
      },
    ]);
    const personalClaudeAccessToken = vi.fn(async () => undefined);
    const asLena = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      claudeUsage: { getLimits: instanceLimits },
      personalClaudeAccessToken,
    });
    asLena.addHook('onRequest', async (request) => {
      request.localUserId = 'lena';
    });
    try {
      const res = await asLena.inject({ method: 'GET', url: '/provider-limits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(instanceLimits).not.toHaveBeenCalled();
      expect(personalClaudeAccessToken).toHaveBeenCalledWith('lena');
    } finally {
      await asLena.close();
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

  it('keeps actual connection acquisitions constant for growing lists with missing worktrees and fallback histories', async () => {
    const storage = new SessionStorage({
      listProjects: () => ctx.store.listProjects(),
      root: () => worktreeRoot,
      listSessions: () => ctx.store.listSessions(),
      activity: async () => null,
      withGit: async () => {
        throw new Error('unused');
      },
      mutate: async (_projectId, _sessionId, run) => run(),
      pr: async () => null,
    });
    const server = buildServer({ eventStore: ctx.store, bus, conductor, sessionStorage: storage });
    const acquisitions = new AsyncLocalStorage<{ count: number }>();
    let measurement: { count: number } | undefined;
    server.addHook('onRequest', (_request, _reply, done) => {
      if (measurement) acquisitions.run(measurement, done);
      else done();
    });
    await server.ready();
    const original = ctx.store.listSessionProjectionFacts.bind(ctx.store);
    let releaseBackground: () => void = () => undefined;
    let backgroundRead: Promise<unknown> = Promise.resolve();
    const facts = vi
      .spyOn(ctx.store, 'listSessionProjectionFacts')
      .mockImplementation(async (...args) => {
        releaseBackground();
        await backgroundRead;
        const result = await original(...args);
        for (const entry of result.values()) {
          entry.eventsTruncated = true;
          entry.events = entry.events.filter(({ event }) => event.t !== 'prompt');
        }
        return result;
      });
    // A prototype-wide spy also counts background recovery/timer reads, even
    // from the shared fixture app. Measure only this request's async context.
    // Preserve the dynamic database receiver via .call(this) inside the spy.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalAcquire = PgliteDriver.prototype.acquireConnection;
    const acquire = vi
      .spyOn(PgliteDriver.prototype, 'acquireConnection')
      .mockImplementation(function (this: PgliteDriver) {
        const current = acquisitions.getStore();
        if (current) current.count++;
        return originalAcquire.call(this);
      });
    const measure = async () => {
      // Register outside the request context, like a pre-existing timer. Its
      // query is forced to overlap the request so a global counter fails here.
      backgroundRead = new Promise<void>((resolve) => {
        releaseBackground = resolve;
      }).then(async () => {
        await ctx.store.listProjects();
        await ctx.store.listSessions();
      });
      const current = { count: 0 };
      measurement = current;
      acquire.mockClear();
      const response = await server.inject('/sessions');
      measurement = undefined;
      return { response, count: current.count };
    };
    const seed = async (n: number) => {
      await ctx.store.createSession({
        sessionId: `pool-${n}`,
        worktree: `/missing/pool-${n}`,
        model: 'm',
      });
      await ctx.store.appendEvent(`pool-${n}`, { t: 'prompt', text: 'go' });
      await ctx.store.appendEvent(`pool-${n}`, { t: 'status', state: 'running' });
    };
    try {
      await seed(0);
      const small = await measure();
      expect(small.response.statusCode).toBe(200);
      expect(small.count).toBeGreaterThan(0);
      for (let n = 1; n < 40; n++) await seed(n);
      const large = await measure();
      expect(large.response.statusCode).toBe(200);
      expect(large.response.json()).toHaveLength(40);
      expect(large.count).toBeLessThanOrEqual(small.count);
      // Constant: one log-marker read decides which logs to read at all.
      expect(large.count).toBeLessThanOrEqual(13);
      expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(large.count + 2);
    } finally {
      acquire.mockRestore();
      facts.mockRestore();
      await server.close();
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
