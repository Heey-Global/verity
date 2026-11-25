import { RevisionGate, type DomainEvent, type LiveTopicSink } from '@verity/mobile';
import { useEffect, useRef } from 'react';
import { liveConnectionFor } from './liveConnection';

/** Project topics one view subscribes at most; the live connection allows 64
 * topics in total. */
const MAX_PROJECT_TOPICS = 48;

/**
 * Overview events (ADR 0033) of the given projects while the component is
 * mounted. Events arrive in order and at most once per revision; `onResync`
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
