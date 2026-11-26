import { OverviewStore, type DomainEvent, type LiveTopicSink } from '@verity/mobile';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribeAuthToken } from './authToken';
import { subscribeBrowserSession } from './browserSession';
import { liveConnectionFor } from './liveConnection';
import { taskAccountScope } from './tasksStore';

/** Project topics the app subscribes at most, leaving room for session topics
 * within the connection's 64. A project past the cap waits for a free topic,
 * and one the server ends with `limit` keeps following live hints and reads. */
const MAX_PROJECT_TOPICS = 48;

interface OverviewListener {
  readonly projects: ReadonlySet<string>;
  readonly handlers: { current: { onEvent(event: DomainEvent): void; onResync(): void } };
  resyncQueued: boolean;
  disposed: boolean;
}

/**
 * The app's one subscription to overview topics for one server and account
 * (ADR 0033). Every view registers the projects it shows; each project topic
 * is subscribed once however many views show it, and every event passes the
 * shared store's revision gate once before it reaches the views of its
 * project.
 */
class OverviewHub {
  readonly store = new OverviewStore();
  private readonly topics = new Map<string, { count: number; detach?: () => void }>();
  private readonly listeners = new Set<OverviewListener>();

  constructor(private readonly baseUrl: string) {}

  attach(listener: OverviewListener): () => void {
    this.listeners.add(listener);
    let joinedLive = false;
    for (const projectId of listener.projects) {
      if (this.want(projectId)) joinedLive = true;
    }
    // The server answers a new subscription with `resync`, which makes a view
    // read its snapshot once the stream is live. A view joining a topic that is
    // already live gets no such answer, so it is asked here.
    if (joinedLive) this.queueResync(listener);
    return () => {
      listener.disposed = true;
      this.listeners.delete(listener);
      // Free all of the view's topics first, so none of them is promoted only
      // to be released again a moment later.
      let freed = false;
      for (const projectId of listener.projects) {
        if (this.release(projectId)) freed = true;
      }
      if (freed) this.promoteWaiting();
    };
  }

  /** Count one more view of the project; true when its topic was already live. */
  private want(projectId: string): boolean {
    const held = this.topics.get(projectId);
    if (held !== undefined) {
      held.count += 1;
      return held.detach !== undefined;
    }
    const entry: { count: number; detach?: () => void } = { count: 1 };
    this.topics.set(projectId, entry);
    this.subscribeIfRoom(projectId, entry);
    return false;
  }

  /** Count one view less; true when this freed a live topic. */
  private release(projectId: string): boolean {
    const held = this.topics.get(projectId);
    if (held === undefined) return false;
    held.count -= 1;
    if (held.count > 0) return false;
    this.topics.delete(projectId);
    if (held.detach === undefined) return false;
    held.detach();
    return true;
  }

  /** Freed topics go to the longest waiting projects. */
  private promoteWaiting(): void {
    for (const [waiting, entry] of this.topics) {
      if (entry.detach !== undefined) continue;
      this.subscribeIfRoom(waiting, entry);
      if (entry.detach === undefined) break;
    }
  }

  private subscribeIfRoom(projectId: string, entry: { detach?: () => void }): void {
    const live = [...this.topics.values()].filter((topic) => topic.detach).length;
    if (live >= MAX_PROJECT_TOPICS) return;
    entry.detach = liveConnectionFor(this.baseUrl).subscribeTopic(
      `project:${projectId}`,
      this.sinkFor(projectId),
    );
  }

  private sinkFor(projectId: string): LiveTopicSink {
    return {
      event: (event) => {
        if (!this.store.applyEvent(event).applied) return;
        for (const listener of this.interestedIn(projectId))
          listener.handlers.current.onEvent(event);
      },
      resync: () => {
        this.store.resync();
        for (const listener of this.interestedIn(projectId)) this.queueResync(listener);
      },
    };
  }

  /** Several topics answer a new subscription at once; one read serves all.
   * Resyncs in separate frames are bounded by the view's own read coalescing
   * (at most one read in flight and one after it). */
  private queueResync(listener: OverviewListener): void {
    if (listener.resyncQueued) return;
    listener.resyncQueued = true;
    queueMicrotask(() => {
      listener.resyncQueued = false;
      if (!listener.disposed) listener.handlers.current.onResync();
    });
  }

  private interestedIn(projectId: string): OverviewListener[] {
    return [...this.listeners].filter((listener) => listener.projects.has(projectId));
  }
}

let current: { scope: string; hub: OverviewHub } | undefined;

function subscribeAccount(listener: () => void): () => void {
  const detach = [subscribeAuthToken(listener), subscribeBrowserSession(listener)];
  return () => {
    for (const unsubscribe of detach) unsubscribe();
  };
}

/** The hub of this server and the signed-in account; another account or
 * server starts from an empty store. */
function hubFor(baseUrl: string): OverviewHub {
  const scope = JSON.stringify([baseUrl, taskAccountScope()]);
  if (current?.scope !== scope) current = { scope, hub: new OverviewHub(baseUrl) };
  return current.hub;
}

/**
 * Overview events (ADR 0033) of the given projects while the component is
 * mounted. Events arrive in order and at most once per revision between
 * resyncs; `onResync` asks the view to read its snapshot, which the server
 * requests once each subscription is live and whenever it cannot replay what
 * was missed.
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
  const key = [...new Set(projectIds)].sort().join('\n');
  // A view that stays mounted across a sign-in moves to the new account's store.
  const account = useSyncExternalStore(subscribeAccount, taskAccountScope, taskAccountScope);
  useEffect(() => {
    if (baseUrl === null || key === '') return undefined;
    return hubFor(baseUrl).attach({
      projects: new Set(key.split('\n')),
      handlers,
      resyncQueued: false,
      disposed: false,
    });
  }, [baseUrl, key, account]);
}
