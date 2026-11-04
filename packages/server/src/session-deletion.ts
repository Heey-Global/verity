import type { EventStore, SessionRecord } from '@verity/store';

export interface SessionDeletionPayload {
  session: Pick<SessionRecord, 'sessionId' | 'worktree' | 'projectId' | 'model'>;
  previewIds: string[];
  runnerIdentity?: { turnId: string; startCommandId: string };
  terminationConfirmed?: boolean;
  retryAt?: number;
  failures?: number;
  managed?: { sessionId: string; projectId: string | null; instanceIds: string[] };
}

export class SessionDeletionDeadlineError extends Error {
  constructor() {
    super('Session deletion is still pending; retry shortly');
  }
}

/** A deadline bounds the caller, never releases ownership of the unfinished operation. */
export async function deletionDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SessionDeletionDeadlineError()), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Durable logical deletes and physical cleanup have independent ownership. */
export function createSessionDeletionManager(options: {
  store: Pick<
    EventStore,
    | 'queueSessionDeletion'
    | 'listPendingSessionDeletions'
    | 'finishSessionDeletionCleanup'
    | 'deleteSession'
    | 'getSession'
    | 'updateSessionDeletionPayload'
    | 'getSessionDeletion'
    | 'withSessionDeletionCleanup'
  >;
  fence: (id: string) => void;
  stop: (id: string) => Promise<boolean>;
  terminationConfirmed?: (id: string) => boolean;
  capture: (session: SessionRecord) => Promise<SessionDeletionPayload>;
  prepare: (id: string) => Promise<void>;
  beforeDelete?: (id: string) => Promise<void>;
  cleanup: (payload: SessionDeletionPayload, terminationConfirmed: boolean) => Promise<boolean>;
  report: (id: string, phase: string, outcome: string, elapsedMs: number, error?: unknown) => void;
  deadlineMs?: number;
  stopDeadlineMs?: number;
}) {
  const logical = new Map<string, Promise<void>>();
  const cleaning = new Map<string, Promise<void>>();
  const confirmed = new Set<string>();
  const retryAt = new Map<string, number>();
  const failures = new Map<string, number>();
  let closing = false;
  const maxConcurrentCleanups = 2;
  const phase = async <T>(id: string, name: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    options.report(id, name, 'started', 0);
    const watchdog = setTimeout(
      () => options.report(id, name, 'deadline', Date.now() - started),
      options.deadlineMs ?? 15_000,
    );
    watchdog.unref();
    try {
      const result = await work();
      options.report(id, name, 'completed', Date.now() - started);
      return result;
    } catch (error) {
      options.report(id, name, 'failed', Date.now() - started, error);
      throw error;
    } finally {
      clearTimeout(watchdog);
    }
  };
  const finishLogical = async (id: string, payload: SessionDeletionPayload) => {
    options.fence(id);
    const stopped =
      payload.terminationConfirmed === true ||
      ((await options.store.getSession(id)) !== undefined &&
        (await phase(id, 'stop-turn', () =>
          deletionDeadline(options.stop(id), options.stopDeadlineMs ?? 10_000),
        ).catch(() => false)));
    if (stopped) {
      confirmed.add(id);
      payload.terminationConfirmed = true;
      await options.store.updateSessionDeletionPayload(id, JSON.stringify(payload));
    } else options.report(id, 'stop-turn', 'deferred', 0);
    if (stopped && options.beforeDelete && (await options.store.getSession(id)))
      await phase(id, 'legacy-artifacts', () => options.beforeDelete!(id));
    await phase(id, 'db', () => options.store.deleteSession(id));
    const retained = (await options.store.listPendingSessionDeletions()).find(
      (record) => record.sessionId === id,
    );
    if (retained) Object.assign(payload, JSON.parse(retained.payload) as SessionDeletionPayload);
  };
  const clean = (id: string, payload: SessionDeletionPayload): Promise<void> => {
    const existing = cleaning.get(id);
    if (existing) return existing;
    // A stuck cleanup retains its own slot, never the only slot for other sessions.
    if (cleaning.size >= maxConcurrentCleanups) return Promise.resolve();
    const work = Promise.resolve()
      .then(() => {
        if (closing) return false;
        return phase(id, 'runner-cleanup', async () => {
          // A captured turn may finish after the bounded stop and the DB cascade.
          // Only the conductor's exact-handle settlement can supply this evidence.
          if (!payload.terminationConfirmed && options.terminationConfirmed?.(id)) {
            payload.terminationConfirmed = true;
            confirmed.add(id);
            await options.store.updateSessionDeletionPayload(id, JSON.stringify(payload));
          }
          const complete = await options.store.withSessionDeletionCleanup(id, async (retained) => {
            Object.assign(payload, JSON.parse(retained) as SessionDeletionPayload);
            return options.cleanup(
              payload,
              confirmed.has(id) || payload.terminationConfirmed === true,
            );
          });
          if (!complete) options.report(id, 'runner-cleanup', 'deferred', 0);
          return complete;
        });
      })
      .then(
        (done) => {
          if (done) {
            retryAt.delete(id);
            failures.delete(id);
            confirmed.delete(id);
          } else return defer(id, payload);
        },
        (error: unknown) => {
          const deferred = defer(id, payload);
          options.report(id, 'runner-cleanup', 'deferred', 0, error);
          return deferred;
        },
      );
    cleaning.set(id, work);
    void work
      .catch((error: unknown) => options.report(id, 'cleanup-schedule', 'failed', 0, error))
      .finally(() => cleaning.delete(id));
    return work;
  };
  const defer = async (id: string, payload: SessionDeletionPayload) => {
    const count = Math.max(failures.get(id) ?? 0, payload.failures ?? 0) + 1;
    failures.set(id, Math.min(count, 7));
    payload.failures = Math.min(count, 7);
    payload.retryAt = Date.now() + Math.min(1_800_000, 30_000 * 2 ** Math.min(count - 1, 6));
    retryAt.set(id, payload.retryAt);
    await options.store.updateSessionDeletionPayload(id, JSON.stringify(payload));
  };
  const resume = async () => {
    if (closing) return;
    for (const record of await options.store.listPendingSessionDeletions()) {
      options.fence(record.sessionId);
      const payload = JSON.parse(record.payload) as SessionDeletionPayload;
      if (
        logical.has(record.sessionId) ||
        cleaning.has(record.sessionId) ||
        Math.max(retryAt.get(record.sessionId) ?? 0, payload.retryAt ?? 0) > Date.now()
      )
        continue;
      if (payload.session.sessionId !== record.sessionId)
        throw new Error('Invalid session deletion payload');
      const work = finishLogical(record.sessionId, payload).then(() => {
        void clean(record.sessionId, payload);
      });
      logical.set(record.sessionId, work);
      void work
        .catch((error: unknown) => {
          void defer(record.sessionId, payload).catch((error: unknown) =>
            options.report(record.sessionId, 'cleanup-schedule', 'failed', 0, error),
          );
          options.report(record.sessionId, 'db', 'deferred', 0, error);
        })
        .finally(() => logical.delete(record.sessionId));
      // Do not stack up synchronous DB work; a wedged operation retains its slot.
      await deletionDeadline(work, options.deadlineMs ?? 15_000).catch(() => undefined);
    }
  };
  return {
    async remove(session: SessionRecord, onAdmitted?: () => void) {
      let work = logical.get(session.sessionId);
      if (!work) {
        work = (async () => {
          const tombstone = await options.store.getSessionDeletion(session.sessionId);
          if (tombstone && !tombstone.cleanupPending) return;
          const saved = (await options.store.listPendingSessionDeletions()).find(
            (record) => record.sessionId === session.sessionId,
          );
          const payload = saved
            ? (JSON.parse(saved.payload) as SessionDeletionPayload)
            : await phase(session.sessionId, 'capture', () => options.capture(session));
          if (!saved)
            await phase(session.sessionId, 'cleanup-schedule', () =>
              options.prepare(session.sessionId),
            );
          await phase(session.sessionId, 'admission', () =>
            options.store.queueSessionDeletion(session.sessionId, JSON.stringify(payload)),
          );
          options.fence(session.sessionId);
          onAdmitted?.();
          await finishLogical(session.sessionId, payload);
          void clean(session.sessionId, payload);
        })();
        logical.set(session.sessionId, work);
        void work.catch(() => undefined).finally(() => logical.delete(session.sessionId));
      }
      try {
        await deletionDeadline(work, options.deadlineMs ?? 15_000);
        options.report(session.sessionId, 'request', 'completed', 0);
        return { sessionId: session.sessionId, cleanup: 'pending' as const };
      } catch (error) {
        options.report(
          session.sessionId,
          'request',
          error instanceof SessionDeletionDeadlineError ? 'deadline' : 'failed',
          0,
          error,
        );
        throw error;
      }
    },
    waitForLogical(id: string) {
      return logical.get(id) ?? Promise.resolve();
    },
    resume,
    close() {
      closing = true;
    },
  };
}
