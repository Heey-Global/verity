import type { SequencedEvent } from '@verity/store';

/**
 * The fan-out seam (concept §5b/M3-2): canonical events reach live subscribers
 * (e.g. WebSocket clients) IN ADDITION to the durable store. The session
 * pipeline publishes each event AFTER it has durably persisted (persist-then-
 * publish), so a broadcast event is always one that actually landed — tagged
 * with its `seq` so a subscriber can order/dedup against a backlog.
 *
 * In-memory + process-local by design — the right scope for the single-process
 * orchestrator (§17). A multi-process control-plane would swap this for
 * Postgres LISTEN/NOTIFY behind the same interface.
 */
export type EventListener = (event: SequencedEvent) => void;
export type EventObserver = (sessionId: string, event: SequencedEvent) => void;

export interface EventBus {
  publish(sessionId: string, event: SequencedEvent): void;
  /** Subscribe to a session's live events. Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: EventListener): () => void;
  /** Observe every published event without masquerading as a foreground viewer. */
  subscribeAll(observer: EventObserver): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly observers = new Set<EventObserver>();

  publish(sessionId: string, event: SequencedEvent): void {
    const set = this.listeners.get(sessionId);
    // Snapshot so a listener that (un)subscribes during dispatch can't mutate
    // the set mid-iteration. A throwing listener must not break the publish (or
    // the pipeline that calls it) — isolate each.
    for (const listener of [...(set ?? [])]) {
      try {
        listener(event);
      } catch {
        // A bad/slow subscriber can't break persistence-driven fan-out.
      }
    }
    for (const observer of [...this.observers]) {
      try {
        observer(sessionId, event);
      } catch {
        // Observability/automation hooks have the same isolation contract as
        // session listeners: publishing a durable event must never fail.
      }
    }
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(observer: EventObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
}
