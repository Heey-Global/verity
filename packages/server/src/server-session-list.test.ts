import { type AgentEvent } from '@verity/events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  app,
  branchSvc,
  bus,
  CLAUDE_SORTED,
  conductor,
  ctx,
  dispatchTurnWhenIdle,
  isBusy,
  pendingPermissions,
  preparingOperation,
  updateFixture,
  worktreeRoot,
  ZERO_USAGE,
} from './server-fixture.test-helper.js';
import { buildServer } from './server.js';

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

  it('keeps safely retired sessions resumable in list and detail responses', async () => {
    await ctx.store.createSession({ sessionId: 'retired', worktree: '/wt/retired', model: 'm' });
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sessionStorage: {
        bind: () => {},
        canRestore: async (session: { sessionId: string }) => session.sessionId === 'retired',
        canRestoreMany: async () => new Map([['retired', true]]),
      } as unknown as import('./session-storage.js').SessionStorage,
    });
    try {
      const list = await server.inject({ method: 'GET', url: '/sessions' });
      expect(list.json()[0].resumable).toBe(true);
      const detail = await server.inject({ method: 'GET', url: '/sessions/retired' });
      expect(detail.json().resumable).toBe(true);
    } finally {
      await server.close();
    }
  });

  // Session servers hold their worktree; unknown project evidence holds orphan collection.
  it('holds storage collection for the session that serves, not its whole project', async () => {
    let blocked: ((projectId: string, sessionId: string | null) => boolean) | undefined;
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      sessionStorage: {
        bind: (_claim: unknown, predicate: typeof blocked) => {
          blocked = predicate;
        },
      } as unknown as import('./session-storage.js').SessionStorage,
      managedDevServerManager: {
        hasRunningServers: (projectId: string) => projectId === 'p1',
        hasUnverifiedServers: (projectId: string) => projectId === 'p4',
        hasRunningSessionServers: (sessionId: string) => sessionId === 'serving',
      } as unknown as import('./managed-dev-server-manager.js').ManagedDevServerManager,
      localPreviewManager: {
        list: (sessionId: string) => (sessionId === 'previewing' ? [{}] : []),
        listProject: (projectId: string) => (projectId === 'p2' ? [{}] : []),
      } as unknown as import('./local-preview-manager.js').LocalPreviewManager,
    });
    try {
      expect(blocked!('p1', 'serving')).toBe(true);
      expect(blocked!('p1', 'idle')).toBe(false);
      expect(blocked!('p2', 'previewing')).toBe(true);
      expect(blocked!('p2', 'idle')).toBe(false);
      // Orphaned registrations belong to no session; any server still defers them.
      expect(blocked!('p1', null)).toBe(true);
      expect(blocked!('p2', null)).toBe(true);
      expect(blocked!('p3', null)).toBe(false);
      expect(blocked!('p4', null)).toBe(true);
    } finally {
      await server.close();
    }
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
        lastMessageAt: null,
        lastSeenEventCount: null,
        inboxDismissed: [],
      },
      {
        sessionId: 's2',
        worktree: '/wt/s2',
        model: 'm',
        name: null,
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
        lastMessageAt: null,
        lastSeenEventCount: null,
        inboxDismissed: [],
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
        lastMessageAt: null,
        lastSeenEventCount: null,
        inboxDismissed: [],
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

  it('bounds fleet-wide branch reads and coalesces queued worktrees across list polls', async () => {
    const releases: (() => void)[] = [];
    const current = vi.fn(
      () => new Promise<string>((resolve) => releases.push(() => resolve('feat/one'))),
    );
    const server = buildServer({
      eventStore: ctx.store,
      bus,
      conductor,
      spawnWorktreeRoot: worktreeRoot,
      branches: { ...branchSvc, current } as unknown as NonNullable<
        Parameters<typeof buildServer>[0]['branches']
      >,
    });
    try {
      for (let i = 0; i < 5; i++) {
        const worktree = join(worktreeRoot, `bounded-${i}`);
        mkdirSync(worktree, { recursive: true });
        await ctx.store.createSession({ sessionId: `bounded-${i}`, worktree, model: 'm' });
      }
      await server.inject({ method: 'GET', url: '/sessions' });
      await server.inject({ method: 'GET', url: '/sessions' });
      expect(current).toHaveBeenCalledTimes(2);
      releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(current).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 4; i++) {
        releases.shift()!();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await server.inject({ method: 'GET', url: '/sessions' });
      expect(current).toHaveBeenCalledTimes(5);
    } finally {
      for (const release of releases) release();
      await server.close();
    }
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

describe('GET /sessions inbox facts', () => {
  it('carries the open question until a prompt answers it', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'Build the form' });
    await ctx.store.appendEvent('s1', {
      t: 'choices',
      question: 'Which validation library?',
      options: [{ label: 'Zod', recommended: true }, { label: 'Valibot' }],
    });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    const open = await app.inject({ method: 'GET', url: '/sessions' });
    expect(open.json()[0]).toMatchObject({
      openChoices: {
        question: 'Which validation library?',
        options: [{ label: 'Zod', recommended: true }, { label: 'Valibot' }],
      },
    });
    // A busy conductor means the answer is already being worked on.
    isBusy.mockReturnValue(true);
    const busy = await app.inject({ method: 'GET', url: '/sessions' });
    expect(busy.json()[0]).not.toHaveProperty('openChoices');
    isBusy.mockReturnValue(false);
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'Zod' });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'completed' });
    const answered = await app.inject({ method: 'GET', url: '/sessions' });
    expect(answered.json()[0]).not.toHaveProperty('openChoices');
  });

  it('describes the permission prompts the conductor still has parked', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: '/wt/s1', model: 'm' });
    await ctx.store.appendEvent('s1', { t: 'prompt', text: 'Search the web' });
    await ctx.store.appendEvent('s1', {
      t: 'permission',
      id: 'toolu_egress',
      tool: 'verity_http_request',
      input: { url: 'https://api.exa.ai/search' },
      riskClass: 'ask',
    });
    await ctx.store.appendEvent('s1', { t: 'status', state: 'awaiting_input' });
    pendingPermissions.mockReturnValue(['toolu_egress']);
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.json()[0]).toMatchObject({
      pendingPermissions: ['toolu_egress'],
      pendingPermissionRequests: [
        {
          toolUseId: 'toolu_egress',
          tool: 'verity_http_request',
          riskClass: 'ask',
          input: { url: 'https://api.exa.ai/search' },
        },
      ],
    });
    // Once answered the conductor drops it; the durable event alone is not a prompt.
    pendingPermissions.mockReturnValue([]);
    const answered = await app.inject({ method: 'GET', url: '/sessions' });
    expect(answered.json()[0]).not.toHaveProperty('pendingPermissionRequests');
  });
});
