import type { SessionRecord } from '@verity/store';
import type { PullRequestStatus } from './github.js';

interface Entry {
  status: PullRequestStatus | null;
  at: number;
  quietReads: number;
  failures: number;
}

interface ReadOptions {
  background?: boolean;
  priority?: boolean;
  load?: () => Promise<PullRequestStatus | null>;
}

function foregroundInterval(status: PullRequestStatus | null): number {
  if (status === null) return 5_000;
  if (status.pipeline === 'running' || status.pipeline === 'pending') return 15_000;
  if (status.phase === 'open' && status.checks.total === 0) return 15_000;
  // Green but GitHub is still computing mergeability: the merge button waits on it.
  // Same cadence as running CI — GitHub can leave it null for minutes, and every
  // viewed session would otherwise hit the API at the clients' 5s poll rate.
  if (status.phase === 'open' && status.pipeline === 'success' && status.mergeable === null)
    return 15_000;
  if (status.phase === 'open') return 30_000;
  return 300_000;
}

function interval(entry: Entry, background: boolean): number {
  if (entry.failures > 0) return Math.min(300_000, 30_000 * 2 ** (entry.failures - 1));
  if (!background) return foregroundInterval(entry.status);
  if (entry.status === null) return Math.min(300_000, 30_000 * 2 ** (entry.quietReads - 1));
  if (entry.status.pipeline === 'running' || entry.status.pipeline === 'pending') return 30_000;
  if (entry.status.phase === 'open' && entry.status.checks.total === 0) return 30_000;
  return entry.status.phase === 'open' ? 120_000 : 300_000;
}

function unavailable(status: PullRequestStatus | null): PullRequestStatus | null {
  if (status === null) return null;
  const result = { ...status, pipeline: 'unknown' as const, mergeable: null };
  delete result.mergeState;
  result.checks = { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 };
  return result;
}

/** Share complete PR reads before git across the overview, branch strip and both
 * background monitors. Only one expensive read runs at a time across sessions. */
export function createSessionPrCache(options: {
  load(session: SessionRecord): Promise<PullRequestStatus | null>;
  now?: (() => number) | undefined;
}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  interface PendingRead {
    disowned: boolean;
    priority: boolean;
    promise: Promise<PullRequestStatus | null>;
    run(): Promise<void>;
    resolve(status: PullRequestStatus | null): void;
  }
  const pending = new Map<string, PendingRead>();
  const queued: PendingRead[] = [];
  let active = false;
  const startNext = (): void => {
    if (active || queued.length === 0) return;
    const priorityIndex = queued.findIndex((read) => read.priority);
    const read = queued.splice(priorityIndex < 0 ? 0 : priorityIndex, 1)[0]!;
    active = true;
    void read
      .run()
      .catch(() => read.resolve(null))
      .finally(() => {
        active = false;
        startNext();
      });
  };

  const isDue = (session: SessionRecord, background = false): boolean => {
    const entry = entries.get(session.worktree);
    return entry === undefined || now() - entry.at >= interval(entry, background);
  };
  const get = (session: SessionRecord, readOptions: ReadOptions = {}) => {
    const key = session.worktree;
    const running = pending.get(key);
    if (running !== undefined && !running.disowned) {
      if (readOptions.priority) running.priority = true;
      return running.promise;
    }
    const previous = entries.get(key);
    if (!isDue(session, readOptions.background)) return Promise.resolve(previous?.status ?? null);
    let resolve!: (status: PullRequestStatus | null) => void;
    const token: PendingRead = {
      disowned: false,
      priority: readOptions.priority === true,
      promise: new Promise((done) => {
        resolve = done;
      }),
      resolve: (status) => resolve(status),
      run: async () => {},
    };
    token.run = async () => {
      // Invalidation can happen while this read waits behind another session.
      if (token.disowned) {
        resolve(null);
        if (pending.get(key) === token) pending.delete(key);
        return;
      }
      let status: PullRequestStatus | null;
      let failures = 0;
      try {
        status = await (readOptions.load?.() ?? options.load(session));
        if (
          status?.pipeline === 'unknown' &&
          status.mergeable === null &&
          status.mergeState === undefined
        )
          failures = Math.min(5, (previous?.failures ?? 0) + 1);
      } catch {
        status = unavailable(previous?.status ?? null);
        failures = Math.min(5, (previous?.failures ?? 0) + 1);
      }
      if (!token.disowned) {
        entries.set(key, {
          status,
          at: now(),
          quietReads: status === null ? Math.min(5, (previous?.quietReads ?? 0) + 1) : 0,
          failures,
        });
      }
      if (pending.get(key) === token) pending.delete(key);
      resolve(token.disowned ? null : status);
    };
    pending.set(key, token);
    queued.push(token);
    // Coalesce all consumers that arrive in this tick before choosing a read.
    void Promise.resolve().then(startNext);
    return token.promise;
  };
  const invalidate = (worktree: string): void => {
    entries.delete(worktree);
    const running = pending.get(worktree);
    if (running !== undefined) running.disowned = true;
  };
  const prune = (live: ReadonlySet<string>): void => {
    for (const key of new Set([...entries.keys(), ...pending.keys()])) {
      if (!live.has(key)) invalidate(key);
    }
  };
  return { get, isDue, invalidate, prune };
}
