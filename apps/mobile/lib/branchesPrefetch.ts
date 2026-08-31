import type { BranchList, VerityClient } from '@verity/mobile';

type PendingBranches = {
  promise: Promise<BranchList>;
};

const pendingByClient = new WeakMap<VerityClient, Map<string, PendingBranches>>();

function entriesFor(client: VerityClient): Map<string, PendingBranches> {
  let entries = pendingByClient.get(client);
  if (!entries) {
    entries = new Map();
    pendingByClient.set(client, entries);
  }
  return entries;
}

/**
 * Start loading the complete branch/PR state at the same instant a session is
 * opened. The session screen consumes this request, avoiding a second fetch
 * after navigation/focus while keeping its regular polling authoritative.
 */
export function prefetchBranches(client: VerityClient, sessionId: string): void {
  const entries = entriesFor(client);
  if (entries.has(sessionId)) return;

  const promise = client.getBranches(sessionId);
  entries.set(sessionId, { promise });
  void promise.catch(() => {
    if (entries.get(sessionId)?.promise === promise) entries.delete(sessionId);
  });
}

/** Consume a request started while opening the session, if one exists. */
export function takePrefetchedBranches(
  client: VerityClient,
  sessionId: string,
): Promise<BranchList> | undefined {
  const entries = pendingByClient.get(client);
  const entry = entries?.get(sessionId);
  if (!entry) return undefined;
  entries?.delete(sessionId);
  // Navigation should not turn a transient speculative failure into a delayed
  // PR bar. Retry through the screen's normal request path immediately.
  return entry.promise.catch(() => client.getBranches(sessionId));
}
