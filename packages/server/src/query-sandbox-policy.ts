import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Git reads against a sleeping project sandbox start a throwaway query container
 * (`withSleepingSessionGit`). That is worth it when someone opens a session, but
 * not for speculative background refreshes: the session list polled them for every
 * retained worktree, which created and removed roughly one container per second
 * on a fleet whose projects were mostly asleep.
 *
 * A read run through {@link withoutQuerySandbox} fails with
 * {@link QuerySandboxDeclined} instead of starting that container. A running
 * sandbox is still read through `docker exec`, which costs no container.
 */
const declined = new AsyncLocalStorage<true>();

export class QuerySandboxDeclined extends Error {
  constructor() {
    super('Background git read skipped because the project sandbox is asleep');
    this.name = 'QuerySandboxDeclined';
  }
}

export function withoutQuerySandbox<T>(read: () => Promise<T>): Promise<T> {
  return declined.run(true, read);
}

/** Throws when the current read may not start a query container. */
export function assertQuerySandboxAllowed(): void {
  if (declined.getStore() === true) throw new QuerySandboxDeclined();
}
