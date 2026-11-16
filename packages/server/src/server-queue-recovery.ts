import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './server-context.js';

export function registerServerShutdownDrain(ctx: ServerContext): void {
  const { conductor, lifecycle } = ctx;
  // P0b: on graceful shutdown, mark any in-flight turn `interrupted` before the
  // process exits, so a turn abandoned by the restart doesn't hang `running`
  // (SR-2). Runs during app.close while the store is still alive — db.destroy is
  // sequenced after app.close in the embedded server's close(). Optional-called
  // like `recover` below: a conductor implementation (or test double) without
  // the method is simply skipped, and returning the promise lets Fastify await
  // the drain before teardown continues.
  lifecycle.onClose(() =>
    (conductor as { drainOnShutdown?: () => Promise<void> }).drainOnShutdown?.(),
  );
}

export function createServerQueueRecovery(app: FastifyInstance, ctx: ServerContext) {
  const { deps, conductor } = ctx;
  // Rebuild the conductor's in-memory queues from the durable backlog before serving
  // (issue #80), so turns queued before a restart resume rather than being lost.
  // If the deployment manages encrypted secrets, recovery must wait until unlock:
  // a recovered agent turn often needs GitHub/agent credentials from the store, and
  // replaying it while sealed permanently strands the visible prompt behind a
  // "secret store is sealed" error.
  let queuedTurnRecovery: Promise<void> | undefined;
  let queuedTurnRecoveryCompleted = false;
  const recoverQueuedTurns = (reason: 'startup' | 'secret-init' | 'secret-unlock'): void => {
    if (queuedTurnRecoveryCompleted || queuedTurnRecovery !== undefined) return;
    if (deps.secretCipher?.isSealed() === true) {
      app.log.info({ reason }, 'verity: queued-turn recovery deferred until secret store unlock');
      return;
    }
    const recover = (conductor as { recover?: () => Promise<void> }).recover?.bind(conductor);
    if (recover === undefined) return;
    queuedTurnRecovery = Promise.resolve()
      .then(() => recover())
      .then(() => {
        app.log.info({ reason }, 'verity: queued-turn recovery completed');
      })
      .catch((error) => {
        app.log.error({ err: error, reason }, 'verity: queued-turn recovery failed');
      })
      .finally(() => {
        // Latch run-once regardless of outcome (P0d/SR-4). A FAILED recovery must
        // NOT re-arm: recover() replays orphan tail-prompts non-idempotently, so
        // retrying on the next unlock would double-dispatch them. Setting the
        // latch only in `.then` left a failed run retryable. (The sealed-store
        // early-return above still leaves it unlatched, so recovery IS attempted
        // once the store unlocks.)
        queuedTurnRecoveryCompleted = true;
        queuedTurnRecovery = undefined;
      });
  };
  app.addHook('onReady', async () => {
    for (const record of await deps.eventStore.listPendingSessionDeletions())
      conductor.beginSessionDeletion?.(record.sessionId);
    recoverQueuedTurns('startup');
  });
  return { recoverQueuedTurns };
}
