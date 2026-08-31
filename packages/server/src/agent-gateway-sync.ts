import {
  ackCodexCredentialUpdate,
  configureAgentGateway,
  readCodexCredentialUpdate,
  type AgentGatewayConfiguration,
  type CodexCredentialUpdate,
} from './agent-gateway-control.js';

const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;

export interface AgentGatewaySynchronizer {
  update(configuration: AgentGatewayConfiguration): void;
  updateAndWait(configuration: AgentGatewayConfiguration): Promise<void>;
  close(): Promise<void>;
}

/**
 * Best-effort, continuously reconciling projection of Server-owned gateway
 * configuration. Identity mutations must never depend on sidecar availability;
 * the latest snapshot is retried after a gateway or control-socket restart.
 */
export function startAgentGatewaySynchronizer(options: {
  socketPath: string;
  reconcileIntervalMs?: number;
  onError: (error: unknown) => void;
  persistCodexCredentialUpdate?: (update: CodexCredentialUpdate) => Promise<boolean>;
}): AgentGatewaySynchronizer {
  let latest: AgentGatewayConfiguration | undefined;
  let inFlight: Promise<void> | undefined;
  let reconcileRequested = false;
  let closed = false;
  let generation = 0;
  let appliedGeneration = 0;
  const waiters = new Map<number, { resolve: () => void; reject: (error: unknown) => void }>();

  const update = (configuration: AgentGatewayConfiguration): number => {
    latest = configuration;
    generation += 1;
    reconcile();
    return generation;
  };

  const reconcile = (): void => {
    if (closed || latest === undefined) return;
    reconcileRequested = true;
    if (inFlight !== undefined) return;
    inFlight = (async () => {
      while (!closed && reconcileRequested) {
        reconcileRequested = false;
        const snapshot = latest;
        if (snapshot === undefined) break;
        const snapshotGeneration = generation;
        try {
          const status = await configureAgentGateway(options.socketPath, snapshot);
          if (
            snapshot.codex?.credential.authJson !== null &&
            snapshot.codex !== undefined &&
            (!status.codexCredentialReady || !status.codexListenerReady)
          ) {
            throw new Error('Agent Gateway Codex listener is not ready');
          }
          if (options.persistCodexCredentialUpdate !== undefined) {
            const update = await readCodexCredentialUpdate(options.socketPath);
            if (update !== undefined && (await options.persistCodexCredentialUpdate(update))) {
              await ackCodexCredentialUpdate(options.socketPath, update);
            }
          }
          appliedGeneration = snapshotGeneration;
          // A waiter for an older snapshot is also a barrier for any update that
          // overtook it while the control request was in flight. Do not release
          // turns until the newest queued revocation/issuance is acknowledged.
          if (snapshotGeneration === generation) {
            for (const [target, waiter] of waiters) {
              if (target <= appliedGeneration) {
                waiters.delete(target);
                waiter.resolve();
              }
            }
          }
        } catch (error) {
          if (snapshotGeneration === generation) {
            for (const [target, waiter] of waiters) {
              if (target <= snapshotGeneration) {
                waiters.delete(target);
                waiter.reject(error);
              }
            }
          }
          try {
            options.onError(error);
          } catch {
            // Reporting is observational. A logger failure must not reject this
            // detached reconciliation task or disable later periodic retries.
          }
          // A periodic tick retries an unavailable gateway. Only loop now when
          // an update arrived during this attempt, and then send the newest
          // snapshot rather than every stale intermediate revision.
          if (!reconcileRequested) break;
        }
      }
    })().finally(() => {
      inFlight = undefined;
      if (!closed && reconcileRequested) reconcile();
    });
  };

  const timer = setInterval(
    reconcile,
    options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
  );
  timer.unref();

  return {
    update(configuration): void {
      update(configuration);
    },
    updateAndWait(configuration): Promise<void> {
      if (closed) {
        return Promise.reject(
          new Error('Agent Gateway synchronizer closed before configuration completed'),
        );
      }
      const target = update(configuration);
      if (target <= appliedGeneration) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.set(target, { resolve, reject });
      });
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await inFlight;
      const error = new Error('Agent Gateway synchronizer closed before configuration completed');
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
    },
  };
}
