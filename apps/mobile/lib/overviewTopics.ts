import { OverviewStore, RevisionGate, type DomainEvent, type LiveTopicSink } from '@verity/mobile';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

/** Topics only views of a few projects (a project page) may take, so Home's
 * long list never leaves an opened project without live events. */
const FOCUSED_RESERVE = 8;
const SHARED_TOPICS = MAX_PROJECT_TOPICS - FOCUSED_RESERVE;
/** A view showing at most this many projects counts as focused. */
const FOCUSED_VIEW_PROJECTS = 4;

interface TopicEntry {
  /** Views showing the project. */
  count: number;
  /** Focused views among them; they may use the reserve. */
  focused: number;
  detach?: () => void;
  /** Revisions seen on this topic; only its own resync resets them. */
  gate?: RevisionGate;
  /** Live through the reserve rather than the shared part. */
  reserved?: boolean;
}

/**
 * The app's one subscription to overview topics for one server and account
 * (ADR 0033). Every view registers the projects it shows; each project topic
 * is subscribed once however many views show it, and every event passes the
 * topic's revision gate once before it reaches the views of its project.
 */
class OverviewHub {
  private readonly topics = new Map<string, TopicEntry>();
  private readonly listeners = new Set<OverviewListener>();
  /** Live topics within the share every view may use, and from the reserve. */
  private sharedLive = 0;
  private reservedLive = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly store: OverviewStore,
  ) {}

  get idle(): boolean {
    return this.listeners.size === 0;
  }

  attach(listener: OverviewListener): () => void {
    this.listeners.add(listener);
    const focused = listener.projects.size <= FOCUSED_VIEW_PROJECTS;
    let joinedLive = false;
    for (const projectId of listener.projects) {
      if (this.want(projectId, focused)) joinedLive = true;
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
        if (this.release(projectId, focused)) freed = true;
      }
      if (freed) this.promoteWaiting();
    };
  }

  /** Count one more view of the project; true when its topic was already live. */
  private want(projectId: string, focused: boolean): boolean {
    let entry = this.topics.get(projectId);
    const wasLive = entry?.detach !== undefined;
    if (entry === undefined) {
      entry = { count: 0, focused: 0 };
      this.topics.set(projectId, entry);
    }
    entry.count += 1;
    if (focused) entry.focused += 1;
    // A project waiting for Home may now use the reserve.
    if (!wasLive) this.subscribeIfRoom(projectId, entry);
    return wasLive;
  }

  /** Count one view less; true when this freed a live topic. */
  private release(projectId: string, focused: boolean): boolean {
    const entry = this.topics.get(projectId);
    if (entry === undefined) return false;
    entry.count -= 1;
    if (focused) entry.focused -= 1;
    if (entry.count === 0) {
      this.topics.delete(projectId);
      return this.unsubscribe(entry);
    }
    // A topic the reserve gave a page goes back once only Home shows it; Home
    // keeps following hints and reads for it.
    return entry.focused === 0 && entry.reserved === true && this.unsubscribe(entry);
  }

  private unsubscribe(entry: TopicEntry): boolean {
    if (entry.detach === undefined) return false;
    entry.detach();
    if (entry.reserved === true) this.reservedLive -= 1;
    else this.sharedLive -= 1;
    entry.detach = undefined;
    entry.gate = undefined;
    entry.reserved = undefined;
    return true;
  }

  /** Freed topics go to waiting focused views first, then to the longest
   * waiting projects. */
  private promoteWaiting(): void {
    // A reserved topic moves into a freed share, which frees the reserve.
    for (const entry of this.topics.values()) {
      if (entry.reserved !== true || this.sharedLive >= SHARED_TOPICS) continue;
      entry.reserved = false;
      this.reservedLive -= 1;
      this.sharedLive += 1;
    }
    const waiting = [...this.topics].filter(([, entry]) => entry.detach === undefined);
    for (const [projectId, entry] of waiting) {
      if (entry.focused > 0) this.subscribeIfRoom(projectId, entry);
    }
    for (const [projectId, entry] of waiting) {
      if (this.sharedLive >= SHARED_TOPICS) break;
      if (entry.detach === undefined) this.subscribeIfRoom(projectId, entry);
    }
  }

  private subscribeIfRoom(projectId: string, entry: TopicEntry): void {
    if (this.sharedLive < SHARED_TOPICS) {
      this.sharedLive += 1;
      entry.reserved = false;
    } else if (entry.focused > 0 && this.reservedLive < FOCUSED_RESERVE) {
      this.reservedLive += 1;
      entry.reserved = true;
    } else {
      return;
    }
    entry.gate = new RevisionGate();
    entry.detach = liveConnectionFor(this.baseUrl).subscribeTopic(
      `project:${projectId}`,
      this.sinkFor(projectId, entry.gate),
    );
  }

  private sinkFor(projectId: string, gate: RevisionGate): LiveTopicSink {
    return {
      event: (event) => {
        if (!gate.accept(event)) return;
        this.store.applyEvent(event);
        for (const listener of this.interestedIn(projectId))
          listener.handlers.current.onEvent(event);
      },
      resync: () => {
        gate.reset();
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

/** One hub per server and account while any view uses it. */
const hubs = new Map<string, OverviewHub>();

/** The stores of the servers and accounts in use, keyed like the hubs and
 * shared by every view of one. A store lives as long as its hub applies events
 * to it: once the hub goes idle, or its account is no longer signed in while no
 * hub holds it, it is dropped, so no view is ever shown a copy that stopped
 * following events. */
const stores = new Map<string, OverviewStore>();
let pruneOnAccountChange: (() => void) | undefined;
/** Views holding a store; told when one is dropped, so they move to the store
 * the next hub of their scope feeds. */
const storeHolders = new Set<() => void>();
let storesGeneration = 0;

function subscribeStores(listener: () => void): () => void {
  storeHolders.add(listener);
  return () => {
    storeHolders.delete(listener);
  };
}

function currentStoresGeneration(): number {
  return storesGeneration;
}

function dropStore(scope: string): void {
  if (!stores.delete(scope)) return;
  storesGeneration += 1;
  for (const holder of [...storeHolders]) holder();
}

function storeFor(scope: string): OverviewStore {
  let store = stores.get(scope);
  if (store === undefined) {
    // Gated per topic by the hub, so one topic's resync does not open another's.
    store = new OverviewStore({ gated: false });
    stores.set(scope, store);
  }
  // Installed once; the account modules outlive every view.
  pruneOnAccountChange ??= subscribeAccount(pruneStores);
  return store;
}

/** Drop the stores of accounts no longer signed in that no hub holds. */
function pruneStores(): void {
  const signedIn = taskAccountScope();
  for (const scope of stores.keys()) {
    const [, account] = JSON.parse(scope) as [string, string | null];
    if (account !== signedIn && !hubs.has(scope)) dropStore(scope);
  }
}

function subscribeAccount(listener: () => void): () => void {
  const detach = [subscribeAuthToken(listener), subscribeBrowserSession(listener)];
  return () => {
    for (const unsubscribe of detach) unsubscribe();
  };
}

/** Attach a view to the hub of this server and the signed-in account; another
 * account or server starts from an empty store. */
function attachToHub(
  baseUrl: string,
  account: string | null,
  listener: OverviewListener,
): () => void {
  const scope = JSON.stringify([baseUrl, account]);
  let hub = hubs.get(scope);
  if (hub === undefined) {
    hub = new OverviewHub(baseUrl, storeFor(scope));
    hubs.set(scope, hub);
  }
  const detach = hub.attach(listener);
  const attached = hub;
  return () => {
    detach();
    if (!attached.idle || hubs.get(scope) !== attached) return;
    hubs.delete(scope);
    // Nothing applies events to it any more.
    dropStore(scope);
  };
}

/**
 * Overview events (ADR 0033) of the given projects while the component is
 * mounted. Events arrive in order and at most once per revision between
 * resyncs; `onResync` asks the view to read its snapshot, which the server
 * requests once each subscription is live and whenever it cannot replay what
 * was missed.
 *
 * A view whose projects all wait for a free topic gets no `onResync` until
 * one is subscribed; views read on mount themselves and follow live hints
 * meanwhile.
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
    return attachToHub(baseUrl, account, {
      projects: new Set(key.split('\n')),
      handlers,
      resyncQueued: false,
      disposed: false,
    });
  }, [baseUrl, key, account]);
}

/**
 * The shared copy of sessions and projects (ADR 0033) for this server and the
 * signed-in account. Components re-render whenever an entity in it changes;
 * without a server they get a store of their own.
 */
export function useOverviewStore(baseUrl: string | null): OverviewStore {
  const account = useSyncExternalStore(subscribeAccount, taskAccountScope, taskAccountScope);
  // A dropped store renders the view again, so it takes up the current one.
  useSyncExternalStore(subscribeStores, currentStoresGeneration, currentStoresGeneration);
  const [detached] = useState(() => new OverviewStore());
  const store = baseUrl === null ? detached : storeFor(JSON.stringify([baseUrl, account]));
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const version = useCallback(() => store.getVersion(), [store]);
  useSyncExternalStore(subscribe, version, version);
  return store;
}
