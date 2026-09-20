import type { Conductor } from '@verity/session';
import type { EventStore } from '@verity/store';

export interface KnowledgeLifecycleDeps {
  store: EventStore;
  conductor: Pick<Conductor, 'runBackendHandoff' | 'clearQueue' | 'closeSession'>;
}
export interface KnowledgeReconciler {
  (): Promise<void>;
  drain(): Promise<void>;
}

/** The database fence survives a failed stop or server restart; cleanup is retryable. */
export function createKnowledgeInvalidationReconciler(
  deps: KnowledgeLifecycleDeps,
): KnowledgeReconciler {
  let pending: Promise<void> | undefined;
  const reconcile = (): Promise<void> => {
    // Every caller gets a fresh scan after preceding cleanup. Joining an old scan
    // could acknowledge a newer revocation without stopping its newly closed sessions.
    const operation = (pending ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        let firstFailure: Error | undefined;
        for (const sessionId of await deps.store.knowledge.listPendingInvalidatedSessions()) {
          try {
            await deps.conductor.runBackendHandoff(sessionId, async () => {
              await deps.conductor.clearQueue(sessionId);
              const states = await deps.store.getSessionBackendStates(sessionId);
              deps.conductor.closeSession(sessionId);
              for (const state of states) deps.conductor.closeSession(state.backendSessionId);
              await deps.store.deleteSessionBackendStates(sessionId);
              await deps.store.knowledge.markInvalidatedSessionStopped(sessionId);
            });
          } catch (error) {
            firstFailure ??=
              error instanceof Error
                ? error
                : new Error('Knowledge cleanup failed', { cause: error });
          }
        }
        if (firstFailure !== undefined) throw firstFailure;
      });
    pending = operation;
    void operation
      .finally(() => {
        if (pending === operation) pending = undefined;
      })
      .catch(() => {});
    return operation;
  };
  return Object.assign(reconcile, {
    drain: async () => {
      await pending?.catch(() => {});
    },
  });
}
