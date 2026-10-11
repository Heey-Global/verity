import type { BranchList, SessionSummary, VerityClient } from '@verity/mobile';

type PendingBranches = {
  promise: Promise<BranchList>;
  controller: AbortController;
  settledAt?: number;
};
type BranchesCache = {
  pending: Map<string, PendingBranches>;
  snapshots: Map<string, BranchList>;
  versions: Map<string, object>;
};
const clientScopes = new WeakMap<VerityClient, () => string>();
const isolatedCaches = new WeakMap<VerityClient, BranchesCache>();
const sharedCaches = new Map<string, BranchesCache>();
const MAX_SCOPES = 16;
const MAX_SNAPSHOTS = 100;
const PREFETCH_FRESH_MS = 15_000;
function newCache(): BranchesCache {
  return { pending: new Map(), snapshots: new Map(), versions: new Map() };
}

/** Scope uses server identity and credential ID, never the credential itself. */
export function registerBranchesClientScope(client: VerityClient, scope: () => string): void {
  clientScopes.set(client, scope);
}

function cacheFor(client: VerityClient): BranchesCache {
  const scope = clientScopes.get(client)?.();
  if (scope !== undefined) {
    let cache = sharedCaches.get(scope);
    if (!cache) {
      cache = newCache();
      sharedCaches.set(scope, cache);
      if (sharedCaches.size > MAX_SCOPES) sharedCaches.delete(sharedCaches.keys().next().value!);
    }
    return cache;
  }
  let cache = isolatedCaches.get(client);
  if (!cache) {
    cache = newCache();
    isolatedCaches.set(client, cache);
  }
  return cache;
}

function remember(cache: BranchesCache, sessionId: string, value: BranchList): void {
  cache.snapshots.delete(sessionId);
  cache.snapshots.set(sessionId, value);
  if (cache.snapshots.size > MAX_SNAPSHOTS) {
    cache.snapshots.delete(cache.snapshots.keys().next().value!);
  }
}

/** Last known state paints immediately; a focus request remains authoritative. */
export function cachedBranches(client: VerityClient, sessionId: string): BranchList | undefined {
  return cacheFor(client).snapshots.get(sessionId);
}

export function rememberBranches(client: VerityClient, sessionId: string, value: BranchList): void {
  remember(cacheFor(client), sessionId, value);
}

/** Carry the overview's known PR into the opening frame without another HTTP read. */
export function seedSessionBranches(client: VerityClient, session: SessionSummary): void {
  const cached = cachedBranches(client, session.sessionId);
  const known = session.pullRequest === undefined ? cached?.pullRequest : session.pullRequest;
  if (known === undefined) return;
  // A confirmed action can update the compact projection before the next full read.
  const pullRequest = session.pr === null || known === null ? null : { ...known, ...session.pr };
  // A speculative read predating this snapshot must not overwrite it on entry.
  const cache = cacheFor(client);
  cache.pending.get(session.sessionId)?.controller.abort();
  cache.pending.delete(session.sessionId);
  cache.versions.delete(session.sessionId);
  rememberBranches(client, session.sessionId, {
    switchable: [],
    ...cached,
    current: session.branch ?? cached?.current ?? '',
    currentPr: pullRequest?.number ?? null,
    pullRequest,
  });
}

/** Capture identity before awaiting the network; authentication may rotate meanwhile. */
export function branchesSnapshotWriter(
  client: VerityClient,
  sessionId: string,
): (value: BranchList) => void {
  const cache = cacheFor(client);
  const version = {};
  cache.versions.delete(sessionId);
  cache.versions.set(sessionId, version);
  if (cache.versions.size > MAX_SNAPSHOTS) {
    cache.versions.delete(cache.versions.keys().next().value!);
  }
  return (value) => {
    if (cache.versions.get(sessionId) === version) remember(cache, sessionId, value);
  };
}

/** A read started before a branch mutation must not repopulate its stale state. */
export function invalidateBranches(client: VerityClient, sessionId: string): void {
  const cache = cacheFor(client);
  cache.snapshots.delete(sessionId);
  cache.pending.get(sessionId)?.controller.abort();
  cache.pending.delete(sessionId);
  cache.versions.delete(sessionId);
}

function freshPrefetch(cache: BranchesCache, sessionId: string): PendingBranches | undefined {
  const entry = cache.pending.get(sessionId);
  // Slow requests remain joinable. Completed speculative reads from abandoned
  // navigation must not replace the next visit's authoritative focus refresh.
  if (entry?.settledAt !== undefined && Date.now() - entry.settledAt >= PREFETCH_FRESH_MS) {
    cache.pending.delete(sessionId);
    return undefined;
  }
  return entry;
}

/** Start branch/PR loading before navigation; the screen consumes this request. */
export function prefetchBranches(client: VerityClient, sessionId: string): void {
  const cache = cacheFor(client);
  for (const [id, pending] of cache.pending) {
    if (id !== sessionId) {
      pending.controller.abort();
      cache.pending.delete(id);
    }
  }
  if (freshPrefetch(cache, sessionId)) return;
  const publish = branchesSnapshotWriter(client, sessionId);
  const controller = new AbortController();
  const entry: PendingBranches = {
    controller,
    promise: client.getBranches(sessionId, controller.signal).then((value) => {
      entry.settledAt = Date.now();
      if (!controller.signal.aborted) publish(value);
      return value;
    }),
  };
  cache.pending.set(sessionId, entry);
  if (cache.pending.size > MAX_SNAPSHOTS) {
    const oldest = cache.pending.keys().next().value!;
    cache.pending.get(oldest)?.controller.abort();
    cache.pending.delete(oldest);
  }
  void entry.promise.catch(() => {
    if (cache.pending.get(sessionId) === entry) cache.pending.delete(sessionId);
  });
}

/** Consume a request started while opening the session, if one exists. */
export function takePrefetchedBranches(
  client: VerityClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<BranchList> | undefined {
  const cache = cacheFor(client);
  const entry = freshPrefetch(cache, sessionId);
  if (!entry) return undefined;
  cache.pending.delete(sessionId);
  // A transient speculative failure must not postpone the PR bar until the next poll.
  const abort = () => entry.controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return entry.promise
    .catch((error: unknown) => {
      if (signal?.aborted || entry.controller.signal.aborted) throw error;
      return client.getBranches(sessionId, signal);
    })
    .finally(() => signal?.removeEventListener('abort', abort));
}

/** Release speculative network work when navigation no longer selects this session. */
export function cancelPrefetchedBranches(client: VerityClient, sessionId: string): void {
  const cache = cacheFor(client);
  cache.pending.get(sessionId)?.controller.abort();
  cache.pending.delete(sessionId);
}
