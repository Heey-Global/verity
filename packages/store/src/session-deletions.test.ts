import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
import { EventStore } from './store.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});
afterEach(() => vi.restoreAllMocks());
it('keeps deletion ownership outside session cascades and permanently refuses late writes and ID reuse', async () => {
  const input = { sessionId: 'deleted', worktree: '/wt/deleted', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion(input.sessionId, '{"snapshot":true}');
  await ctx.store.queueSessionDeletion(input.sessionId, '{}');
  await expect(
    ctx.store.appendEvent(input.sessionId, { t: 'text', delta: 'late' }),
  ).rejects.toThrow('being deleted');
  await ctx.store.deleteSession(input.sessionId);
  const restarted = new EventStore(ctx.db);
  expect(await restarted.listPendingSessionDeletions()).toEqual([
    { sessionId: input.sessionId, payload: '{"snapshot":true}' },
  ]);
  await restarted.finishSessionDeletionCleanup(input.sessionId);
  expect(await restarted.listPendingSessionDeletions()).toEqual([]);
  expect(await restarted.isSessionDeleting(input.sessionId)).toBe(true);
  await expect(restarted.createSession(input)).rejects.toThrow('being deleted');
});

it('captures resources committed after the first deletion snapshot in the same transaction as the cascade', async () => {
  await ctx.store.upsertProject({
    id: 'p',
    owner: 'local',
    repo: 'delete',
    containerName: 'delete',
    state: 'active',
  });
  await ctx.store.createSession({ sessionId: 's', projectId: 'p', worktree: '/wt/s', model: 'm' });
  await ctx.store.queueSessionDeletion(
    's',
    JSON.stringify({
      session: { sessionId: 's', projectId: 'p', worktree: '/wt/s', model: 'm' },
      previewIds: [],
    }),
  );
  // An already-admitted connector can commit after the HTTP snapshot was taken.
  await ctx.db
    .insertInto('local_preview_shares')
    .values({
      id: 'late-share',
      project_id: 'p',
      session_id: 's',
      managed_instance_id: null,
      network_port: 43001,
      url: 'http://192.0.2.1:43001',
      target_port: 3000,
      static_path: null,
      connector_secret: 'test-only',
      state: 'active',
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    .execute();
  await ctx.db
    .insertInto('session_backend_state')
    .values({
      session_id: 's',
      backend: 'codex',
      backend_session_id: 'late-thread',
      context_seq: 0,
    })
    .execute();
  await ctx.store.deleteSession('s');
  expect(JSON.parse((await ctx.store.getSessionDeletion('s'))!.payload).artifactBindings).toEqual([
    { backend: 'codex', backendSessionId: 'late-thread' },
  ]);
  expect(await ctx.store.listLocalPreviewShares()).toEqual([]);
  const record = (await ctx.store.listPendingSessionDeletions())[0]!;
  expect(JSON.parse(record.payload).previewIds).toEqual(['late-share']);
});

it('reserves a pending physical worktree across session IDs and releases it only after cleanup', async () => {
  const input = { sessionId: 'old', worktree: '/wt/shared', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion(
    input.sessionId,
    JSON.stringify({ session: input, previewIds: [] }),
  );
  await ctx.store.deleteSession(input.sessionId);
  expect(await ctx.store.isWorktreeBeingDeleted('/wt/other/../shared')).toBe(true);
  await expect(ctx.store.createSession({ ...input, sessionId: 'new' })).rejects.toThrow(
    'worktree is being deleted',
  );
  await expect(
    ctx.store.createSession({ ...input, sessionId: 'alias', worktree: '/wt/other/../shared' }),
  ).rejects.toThrow('worktree is being deleted');
  await ctx.store.finishSessionDeletionCleanup(input.sessionId);
  expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(false);
  await ctx.store.createSession({ ...input, sessionId: 'new' });
  expect((await ctx.store.getSession('new'))?.worktree).toBe(input.worktree);
  expect(await ctx.store.getSessionDeletion(input.sessionId)).toEqual({
    payload: '{}',
    cleanupPending: false,
  });
  // A stale request must never reserve or clean the successor's path again.
  await ctx.store.queueSessionDeletion(input.sessionId, JSON.stringify({ session: input }));
  expect(await ctx.store.listPendingSessionDeletions()).toEqual([]);
  expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(false);
});

it('checks durable admission inside creation rather than trusting a stale preflight', async () => {
  const input = { sessionId: 'deleted', worktree: '/wt/deleted', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion(input.sessionId, JSON.stringify({ session: input }));
  await ctx.store.deleteSession(input.sessionId);
  // Simulate a preflight answer taken before deletion committed. The insert must
  // still consult the tombstone while it owns the admission lock.
  vi.spyOn(ctx.store, 'isSessionDeleting').mockResolvedValue(false);
  await expect(ctx.store.createSession(input)).rejects.toThrow('being deleted');
});

it('merges late cleanup snapshots monotonically across store wrappers', async () => {
  const input = { sessionId: 's', worktree: '/wt/s', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion(
    input.sessionId,
    JSON.stringify({
      session: input,
      previewIds: ['captured-share'],
      managed: { sessionId: 's', projectId: 'p', instanceIds: ['captured-instance'] },
      terminationConfirmed: true,
      artifactBindings: [{ backend: 'codex', backendSessionId: 'initial' }],
      purgedArtifactBindings: [{ backend: 'codex', backendSessionId: 'initial' }],
      legacyArtifactsPurged: true,
    }),
  );
  const stale = new EventStore(ctx.db);
  await Promise.all([
    ctx.store.updateSessionDeletionPayload(
      's',
      JSON.stringify({
        session: input,
        previewIds: ['late-share'],
        managed: { sessionId: 's', projectId: 'p', instanceIds: ['late-instance'] },
        terminationConfirmed: false,
        failures: 2,
        artifactBindings: [{ backend: 'codex', backendSessionId: 'late' }],
        purgedArtifactBindings: [],
        legacyArtifactsPurged: false,
      }),
    ),
    stale.updateSessionDeletionPayload(
      's',
      JSON.stringify({
        session: input,
        previewIds: [],
        managed: { sessionId: 's', projectId: null, instanceIds: [] },
        terminationConfirmed: false,
        retryAt: 100,
      }),
    ),
  ]);
  const row = await ctx.store.getSessionDeletion('s');
  const payload = JSON.parse(row!.payload);
  expect(payload.previewIds).toEqual(expect.arrayContaining(['captured-share', 'late-share']));
  expect(payload.previewIds).toHaveLength(2);
  expect(payload.managed).toEqual({
    sessionId: 's',
    projectId: 'p',
    instanceIds: ['captured-instance', 'late-instance'],
  });
  expect(payload.terminationConfirmed).toBe(true);
  expect(payload.artifactBindings).toEqual([
    { backend: 'codex', backendSessionId: 'initial' },
    { backend: 'codex', backendSessionId: 'late' },
  ]);
  expect(payload.purgedArtifactBindings).toEqual([
    { backend: 'codex', backendSessionId: 'initial' },
  ]);
  expect(payload.legacyArtifactsPurged).toBe(true);
  expect(payload.session).toEqual(input);
  await ctx.store.finishSessionDeletionCleanup('s');
  await stale.updateSessionDeletionPayload(
    's',
    JSON.stringify({ session: input, previewIds: ['stale-share'] }),
  );
  expect(await ctx.store.getSessionDeletion('s')).toEqual({ payload: '{}', cleanupPending: false });
});

it('holds physical cleanup ownership across wrappers and never reruns completed cleanup', async () => {
  const input = { sessionId: 's', worktree: '/wt/s', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion(input.sessionId, JSON.stringify({ session: input }));
  await ctx.store.deleteSession(input.sessionId);
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = ctx.store.withSessionDeletionCleanup('s', async (payload) => {
    expect(JSON.parse(payload).session.worktree).toBe(input.worktree);
    // Host cleanup reads the store too; retaining an open transaction deadlocks
    // those reads under the single-connection driver.
    expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(true);
    entered();
    await gate;
    return true;
  });
  await started;
  const secondWork = vi.fn(async () => true);
  const second = new EventStore(ctx.db).withSessionDeletionCleanup('s', secondWork);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondWork).not.toHaveBeenCalled();
    expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(true);
  } finally {
    resume();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  }
  expect(secondWork).not.toHaveBeenCalled();
  await ctx.store.createSession({ ...input, sessionId: 'new' });
  await expect(ctx.store.withSessionDeletionCleanup('s', secondWork)).resolves.toBe(true);
  expect(secondWork).not.toHaveBeenCalled();
  expect(await ctx.store.getSession('new')).toBeDefined();
});

it('keeps the worktree reserved when physical cleanup defers or fails', async () => {
  const input = { sessionId: 's', worktree: '/wt/s', model: 'm' };
  await ctx.store.createSession(input);
  await ctx.store.queueSessionDeletion('s', JSON.stringify({ session: input }));
  await ctx.store.deleteSession('s');
  await expect(ctx.store.withSessionDeletionCleanup('s', async () => false)).resolves.toBe(false);
  expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(true);
  await expect(
    ctx.store.withSessionDeletionCleanup('s', async () => {
      throw new Error('not stopped');
    }),
  ).rejects.toThrow('not stopped');
  expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(true);
  expect((await ctx.store.getSessionDeletion('s'))?.cleanupPending).toBe(true);
  await expect(ctx.store.withSessionDeletionCleanup('s', async () => true)).resolves.toBe(true);
  expect(await ctx.store.isWorktreeBeingDeleted(input.worktree)).toBe(false);
});

it('keeps physical cleanup for different sessions independent', async () => {
  for (const id of ['blocked', 'other'])
    await ctx.store.queueSessionDeletion(
      id,
      JSON.stringify({ session: { worktree: `/wt/${id}` } }),
    );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = ctx.store.withSessionDeletionCleanup('blocked', async () => {
    entered();
    await gate;
    return true;
  });
  try {
    await ready;
    const other = vi.fn(async () => true);
    const cleaning = ctx.store.withSessionDeletionCleanup('other', other);
    await vi.waitFor(() => expect(other).toHaveBeenCalledOnce());
    expect(await cleaning).toBe(true);
    expect((await ctx.store.getSessionDeletion('blocked'))?.cleanupPending).toBe(true);
  } finally {
    release();
    await blocked;
  }
});
