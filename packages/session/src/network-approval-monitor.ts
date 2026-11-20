import type { EgressPolicy, EventStore } from '@verity/store';
import type { EventBus } from './bus.js';

type ApprovalStatus = { id: string; target: string; status: string };

export function startNetworkApprovalMonitor(
  store: EventStore,
  projectId: string | null | undefined,
  notify: (text: string) => Promise<boolean>,
  events?: { bus: EventBus | undefined; sessionId: string | undefined },
): () => void {
  if (!projectId) return () => {};
  return monitorNetworkApprovals({
    read: async () =>
      (await store.getVeritySettingsRaw())?.projectEgressEnabled
        ? store.projectEgress.readForAdmission(projectId)
        : undefined,
    notify,
    ...(events?.bus && events.sessionId
      ? {
          subscribe: (check: () => void) =>
            events.bus!.subscribe(events.sessionId!, ({ event }) => {
              if (event.t === 'tool_result') check();
            }),
        }
      : {}),
  });
}

/** Read-only status feedback. It never answers a card or replays a blocked operation. */
export function monitorNetworkApprovals(options: {
  read: () => Promise<EgressPolicy | undefined>;
  notify: (text: string) => Promise<boolean>;
  intervalMs?: number;
  subscribe?: (check: () => void) => () => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const previous = new Map<string, ApprovalStatus>();
  let running = false;
  let recheck = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      recheck = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      const policy = await options.read();
      if (stopped || !policy) return;
      const current = new Map(
        Object.values(policy.requests).map((request) => [
          request.id,
          {
            id: request.id,
            target: `${request.target.host} ${request.target.protocol.toUpperCase()} ${request.target.port}`,
            status:
              request.status === 'pending' && request.revision !== policy.revision
                ? 'needs review after policy change'
                : request.status,
          },
        ]),
      );
      const changed = [...current.values()].filter((request) => {
        const old = previous.get(request.id);
        return old ? old.status !== request.status : request.status === 'pending';
      });
      const removed = [...previous.values()].filter(
        (request) => !current.has(request.id) && request.status === 'pending',
      );
      const batch = changed.slice(0, 20);
      const removedBatch = removed.slice(0, 20 - batch.length);
      if (batch.length || removedBatch.length) {
        const delivered = await options.notify(
          'Verity network approval status (project scope; the requesting process is not identified):\n' +
            batch
              .map((request) => `${request.target}: ${request.status}`)
              .concat(removedBatch.map((request) => `${request.target}: removed`))
              .join('\n') +
            "\nA pending request is waiting for your user's decision in the session approval card. " +
            'DNS remains blocked until access is granted; do not describe pending approval as a final failure. ' +
            'Continue independent work, and explain what awaits approval. ' +
            'An allowed decision is not proof that a previous operation ran. ' +
            'Recheck current authority and retry only an operation the user has authorized; never replay a mutation blindly.',
        );
        if (stopped || !delivered) return;
      }
      for (const request of batch) previous.set(request.id, request);
      for (const request of removedBatch) previous.delete(request.id);
      for (const request of current.values()) {
        if (!previous.has(request.id) && !changed.includes(request))
          previous.set(request.id, request);
      }
    } catch {
      // Status feedback is not authority. A read/steer failure cannot broaden access.
    } finally {
      running = false;
      if (!stopped)
        timer = setTimeout(() => void tick(), recheck ? 0 : (options.intervalMs ?? 3000));
      recheck = false;
    }
  };
  void tick();
  const unsubscribe = options.subscribe?.(() => void tick());
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe?.();
  };
}

/** Bind turn steering to project-scoped feedback without owning turn lifecycle. */
export function monitorNetworkTurn(
  deps: { store: EventStore; bus?: EventBus | undefined },
  projectId: string | null | undefined,
  turn: { steer(message: { text: string }): Promise<boolean> },
  sessionId: string | undefined,
): () => void {
  return startNetworkApprovalMonitor(deps.store, projectId, (text) => turn.steer({ text }), {
    bus: deps.bus,
    sessionId,
  });
}
