import { describe, expect, it, vi } from 'vitest';
import {
  createSessionDeletionManager,
  SessionDeletionDeadlineError,
  type SessionDeletionPayload,
} from './session-deletion.js';
import type { SessionRecord } from '@verity/store';

const session: SessionRecord = {
  sessionId: 's',
  projectId: 'p',
  worktree: '/wt/s',
  name: null,
  model: 'm',
  lastSeenEventCount: null,
};
function setup() {
  const records = new Map<string, string>();
  const completed = new Set<string>();
  let present = true;
  const store = {
    queueSessionDeletion: vi.fn(async (id: string, payload: string) => {
      if (!records.has(id)) records.set(id, payload);
    }),
    listPendingSessionDeletions: vi.fn(async () =>
      [...records].map(([sessionId, payload]) => ({ sessionId, payload })),
    ),
    finishSessionDeletionCleanup: vi.fn(async (id: string) => {
      records.delete(id);
      completed.add(id);
    }),
    getSessionDeletion: vi.fn(async (id: string) =>
      records.has(id)
        ? { payload: records.get(id)!, cleanupPending: true }
        : completed.has(id)
          ? { payload: '{}', cleanupPending: false }
          : undefined,
    ),
    withSessionDeletionCleanup: vi.fn(
      async (id: string, work: (payload: string) => Promise<boolean>): Promise<boolean> => {
        if (!records.has(id)) return true;
        if (!(await work(records.get(id)!))) return false;
        await store.finishSessionDeletionCleanup(id);
        return true;
      },
    ),
    getSession: vi.fn(async () => (present ? session : undefined)),
    updateSessionDeletionPayload: vi.fn(async (id: string, payload: string) => {
      records.set(id, payload);
    }),
    deleteSession: vi.fn(async () => {
      present = false;
      return true;
    }),
  };
  const options = {
    store,
    fence: vi.fn(),
    terminationConfirmed: vi.fn(() => false),
    stop: vi.fn(async () => false),
    capture: vi.fn(async (input: SessionRecord) => ({ session: input, previewIds: [] })),
    prepare: vi.fn(async () => {}),
    releasePublications: vi.fn<(payload: SessionDeletionPayload) => Promise<boolean>>(
      async () => true,
    ),
    cleanup: vi.fn<(payload: SessionDeletionPayload, confirmed: boolean) => Promise<boolean>>(
      async () => false,
    ),
    report: vi.fn(),
    deadlineMs: 30,
    stopDeadlineMs: 10,
  };
  return { options, records, manager: createSessionDeletionManager(options) };
}
describe('durable session deletion', () => {
  it('resumes a legacy purge after logical deletion with its retained bindings', async () => {
    const { options, records, manager } = setup();
    manager.close();
    const bindings = [{ backend: 'codex', backendSessionId: 'thread' }];
    const purge = vi.fn(async () => {});
    const initial = createSessionDeletionManager({
      ...options,
      beforeDelete: purge,
      capture: async () => ({
        session,
        previewIds: [],
        artifactBindings: bindings,
        legacyArtifactsRequired: true,
      }),
    });
    vi.useFakeTimers();
    try {
      await initial.remove(session);
      expect(options.store.getSession).toHaveBeenCalled();
      expect(await options.store.getSession()).toBeUndefined();
      expect(purge).not.toHaveBeenCalled();
      initial.close();
      await vi.advanceTimersByTimeAsync(31_000);
      options.cleanup.mockResolvedValue(true);
      const confirmTermination = vi.fn(async () => true);
      const restarted = createSessionDeletionManager({
        ...options,
        beforeDelete: purge,
        confirmTermination,
      });
      await restarted.resume();
      await vi.waitFor(() => expect(records.has('s')).toBe(false));
      expect(purge).toHaveBeenCalledWith(
        's',
        expect.objectContaining({ artifactBindings: bindings }),
      );
      expect(confirmTermination).toHaveBeenCalledOnce();
      restarted.close();
    } finally {
      initial.close();
      vi.useRealTimers();
    }
  });
  it('purges bindings added after an earlier purge snapshot', async () => {
    const { options, records, manager } = setup();
    manager.close();
    const initial = { backend: 'codex', backendSessionId: 'initial' };
    const late = { backend: 'codex', backendSessionId: 'late' };
    records.set(
      's',
      JSON.stringify({
        session,
        legacyArtifactsRequired: true,
        legacyArtifactsPurged: true,
        artifactBindings: [initial, late],
        purgedArtifactBindings: [initial],
        terminationConfirmed: true,
      }),
    );
    const purge = vi.fn(async () => {});
    options.cleanup.mockResolvedValue(true);
    const restarted = createSessionDeletionManager({ ...options, beforeDelete: purge });
    await restarted.resume();
    await vi.waitFor(() => expect(records.has('s')).toBe(false));
    expect(purge).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ artifactBindings: [initial, late] }),
    );
    restarted.close();
  });

  it('logically deletes with unconfirmed termination and retains physical cleanup ownership', async () => {
    const { options, records, manager } = setup();
    expect(await manager.remove(session)).toEqual({ sessionId: 's', cleanup: 'pending' });
    expect(options.store.deleteSession).toHaveBeenCalledOnce();
    expect(options.cleanup).toHaveBeenCalledWith(expect.objectContaining({ session }), false);
    expect(records.has('s')).toBe(true);
    expect(options.report).toHaveBeenCalledWith('s', 'stop-turn', 'deferred', 0);
  });
  it('proceeds with logical deletion after a never-resolving stop reaches its deadline', async () => {
    const { options, manager } = setup();
    options.stop.mockImplementation(() => new Promise(() => {}));
    await expect(manager.remove(session)).resolves.toMatchObject({
      sessionId: 's',
      cleanup: 'pending',
    });
    expect(options.store.deleteSession).toHaveBeenCalledOnce();
    expect(options.cleanup).toHaveBeenCalledWith(expect.any(Object), false);
  });
  it('persists late confirmed termination and eventually completes deferred cleanup', async () => {
    const { options, records, manager } = setup();
    options.cleanup.mockImplementation(async (_payload, stopped) => stopped);
    vi.useFakeTimers();
    try {
      await manager.remove(session);
      expect(records.has('s')).toBe(true);
      options.terminationConfirmed.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(31_000);
      await manager.resume();
      await vi.waitFor(() => expect(records.has('s')).toBe(false));
      expect(options.store.updateSessionDeletionPayload).toHaveBeenCalledWith(
        's',
        expect.stringContaining('"terminationConfirmed":true'),
      );
    } finally {
      manager.close();
      vi.useRealTimers();
    }
  });
  it('a wedged cleanup never holds the HTTP request or starts duplicate cleanup', async () => {
    const { options, manager } = setup();
    options.cleanup.mockImplementation(() => new Promise(() => {}));
    await expect(manager.remove(session)).resolves.toMatchObject({ sessionId: 's' });
    await manager.resume();
    expect(options.cleanup).toHaveBeenCalledOnce();
  });
  it('allows unrelated cleanup to complete while one session cleanup is stalled', async () => {
    const { options, records, manager } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    options.cleanup.mockImplementation(async (payload) => {
      if (payload.session.sessionId === 's') await gate;
      return true;
    });
    options.capture.mockImplementation(async (input) => ({ session: input, previewIds: [] }));
    try {
      await manager.remove(session);
      await manager.remove({ ...session, sessionId: 'other', worktree: '/wt/other' });
      await vi.waitFor(() => expect(records.has('other')).toBe(false));
      expect(records.has('s')).toBe(true);
    } finally {
      release();
      manager.close();
    }
  });
  it('stops publications for later deletions while both physical cleanup slots remain owned', async () => {
    const { options, records, manager } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    options.cleanup.mockImplementation(async () => {
      await gate;
      return true;
    });
    try {
      for (const id of ['first', 'second', 'third'])
        await manager.remove({ ...session, sessionId: id, worktree: `/wt/${id}` });
      await vi.waitFor(() =>
        expect(options.releasePublications).toHaveBeenCalledWith(
          expect.objectContaining({ session: expect.objectContaining({ sessionId: 'third' }) }),
        ),
      );
      expect(options.cleanup).toHaveBeenCalledTimes(2);
      expect(records.has('third')).toBe(true);
    } finally {
      release();
      manager.close();
    }
  });

  it('bounds waiting on a wedged prepare without deleting the row', async () => {
    const { options, manager } = setup();
    options.prepare.mockImplementation(() => new Promise(() => {}));
    await expect(manager.remove(session)).rejects.toBeInstanceOf(SessionDeletionDeadlineError);
    expect(options.store.deleteSession).not.toHaveBeenCalled();
    expect(options.store.queueSessionDeletion).not.toHaveBeenCalled();
    expect(options.report).toHaveBeenCalledWith('s', 'request', 'deadline', 0, expect.any(Error));
  });
  it('never cascades state when durable cleanup ownership cannot be recorded', async () => {
    const { options, manager } = setup();
    options.store.queueSessionDeletion.mockRejectedValue(new Error('disk failure'));
    await expect(manager.remove(session)).rejects.toThrow('disk failure');
    expect(options.store.deleteSession).not.toHaveBeenCalled();
    expect(options.fence).not.toHaveBeenCalled();
  });
  it('restores the fence and resumes deletion after restart without treating a missing DB marker as death', async () => {
    const { options, records, manager } = setup();
    await manager.remove(session);
    const restarted = createSessionDeletionManager(options);
    options.cleanup.mockClear();
    options.stop.mockClear();
    await vi.waitFor(() => expect(JSON.parse(records.get('s')!).retryAt).toBeGreaterThan(0));
    const due = JSON.parse(records.get('s')!);
    due.retryAt = 0;
    records.set('s', JSON.stringify(due));
    await restarted.resume();
    expect(options.stop).not.toHaveBeenCalled();
    expect(options.cleanup).toHaveBeenCalledWith(expect.any(Object), false);
    expect(records.has('s')).toBe(true);
  });
  it('persists confirmed termination before the cascade and clears completed cleanup on restart', async () => {
    const { options, records, manager } = setup();
    options.stop.mockResolvedValue(true);
    await manager.remove(session);
    expect(JSON.parse(records.get('s')!).terminationConfirmed).toBe(true);
    options.cleanup.mockResolvedValue(true);
    const restarted = createSessionDeletionManager(options);
    await vi.waitFor(() => expect(JSON.parse(records.get('s')!).retryAt).toBeGreaterThan(0));
    const due = JSON.parse(records.get('s')!);
    due.retryAt = 0;
    records.set('s', JSON.stringify(due));
    await restarted.resume();
    await vi.waitFor(() =>
      expect(options.store.finishSessionDeletionCleanup).toHaveBeenCalledWith('s'),
    );
    expect(options.cleanup).toHaveBeenLastCalledWith(expect.any(Object), true);
  });
});

it('a completed tombstone makes a delayed duplicate request harmless after path reuse', async () => {
  const { options, manager } = setup();
  options.stop.mockResolvedValue(true);
  options.cleanup.mockResolvedValue(true);
  await manager.remove(session);
  await vi.waitFor(() => expect(options.store.finishSessionDeletionCleanup).toHaveBeenCalledOnce());
  options.capture.mockClear();
  options.cleanup.mockClear();
  options.store.deleteSession.mockClear();
  await manager.remove(session);
  expect(options.capture).not.toHaveBeenCalled();
  expect(options.cleanup).not.toHaveBeenCalled();
  expect(options.store.deleteSession).not.toHaveBeenCalled();
});

it('preserves cleanup backoff across a manager restart', async () => {
  const { options, records, manager } = setup();
  await manager.remove(session);
  await vi.waitFor(() => expect(JSON.parse(records.get('s')!).retryAt).toBeGreaterThan(Date.now()));
  options.cleanup.mockClear();
  await createSessionDeletionManager(options).resume();
  expect(options.cleanup).not.toHaveBeenCalled();
});
