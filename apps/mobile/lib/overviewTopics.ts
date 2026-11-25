import { RevisionGate, type DomainEvent, type LiveTopicSink } from '@verity/mobile';
import { useEffect, useRef } from 'react';
import { liveConnectionFor } from './liveConnection';

/** Project topics one view subscribes at most, leaving room for the project
 * page and session topics within the connection's 64. A project past the cap,
 * or one the server ends with `limit`, keeps following live hints and reads. */
const MAX_PROJECT_TOPICS = 48;

/**
 * Overview events (ADR 0033) of the given projects while the component is
 * mounted. Events arrive in order and at most once per revision between
 * resyncs (one gate serves all topics, and any resync resets it); `onResync`
 * asks the view to read its snapshot, which the server requests once each
 * subscription is live and whenever it cannot replay what was missed.
 *
 * Callbacks are read through refs, so passing new functions does not
 * resubscribe; only a changed set of projects does.
 */
export function useOverviewTopics(
  baseUrl: string | null,
  projectIds: readonly string[],
  onEvent: (event: DomainEvent) => void,
  onResync: () => void,
): void {
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  const key = [...new Set(projectIds)].sort().slice(0, MAX_PROJECT_TOPICS).join('\n');
  useEffect(() => {
    if (baseUrl === null || key === '') return undefined;
    const connection = liveConnectionFor(baseUrl);
    const gate = new RevisionGate();
    let resyncQueued = false;
    let disposed = false;
    const sink: LiveTopicSink = {
      event: (event) => {
        if (gate.accept(event)) handlers.current.onEvent(event);
      },
      resync: () => {
        gate.reset();
        // Several topics answer a new subscription at once; one read serves all.
        // Resyncs in separate frames are bounded by the view's own read
        // coalescing (at most one read in flight and one after it).
        if (resyncQueued) return;
        resyncQueued = true;
        queueMicrotask(() => {
          resyncQueued = false;
          if (!disposed) handlers.current.onResync();
        });
      },
    };
    const detach = key
      .split('\n')
      .map((projectId) => connection.subscribeTopic(`project:${projectId}`, sink));
    return () => {
      disposed = true;
      for (const unsubscribe of detach) unsubscribe();
    };
  }, [baseUrl, key]);
}
