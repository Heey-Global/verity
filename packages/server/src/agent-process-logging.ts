import type { EventBus } from '@verity/session';
import type { EventStore } from '@verity/store';
import { redactProcessStderr } from '@verity/store';
import type { FastifyBaseLogger } from 'fastify';
import { recentSessionDiagnostics } from './session-observation.js';

/** Observe persisted failures so logging cannot expose the raw process stream. */
export function subscribeAgentProcessLogging(
  bus: EventBus,
  store: Pick<EventStore, 'getSession'>,
  logger: Pick<FastifyBaseLogger, 'warn'>,
): () => void {
  let closed = false;
  const unsubscribe = bus.subscribeAll((sessionId, published) => {
    const { event } = published;
    if (
      event.t !== 'diagnostic' ||
      event.source !== 'agent' ||
      event.outcome !== 'failed' ||
      event.exitCode === undefined
    ) {
      return;
    }
    // Apply the same bounded redaction used by session-scoped diagnostic reads.
    const diagnostic = recentSessionDiagnostics([published], 1)[0];
    if (diagnostic?.stderrTail !== undefined) {
      diagnostic.stderrTail = redactProcessStderr(diagnostic.stderrTail);
    }
    const log = (projectId: string | null, model: string | null) => {
      if (closed) return;
      logger.warn(
        { sessionId, projectId, model, ...diagnostic },
        'agent process exited unexpectedly',
      );
    };
    void store.getSession(sessionId).then(
      (session) => log(session?.projectId ?? null, session?.model ?? null),
      () => log(null, null),
    );
  });
  return () => {
    closed = true;
    unsubscribe();
  };
}
