import type { PullRequestStatus } from './forge-provider.js';

export interface ForgeStatusIdentity {
  /** Includes credential generation; never put a raw credential in this key. */
  authority: string;
  owner: string;
  repo: string;
}
interface Entry {
  value: PullRequestStatus | null;
  checkedAt: number;
  nextReadAt: number;
  failures: number;
}

/** One repository read serves UI and supervision; stale failures cannot authorize repairs. */
export function createForgeStatusCache(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<PullRequestStatus | null>>();
  // Branch-scoped invalidations advance an epoch so a read already in flight when
  // its branch was invalidated cannot store its (possibly pre-activity) result.
  const branchEpochs = new Map<string, number>();
  interface ObservationScope {
    generation: object;
    valid: boolean;
    readers: number;
  }
  const scopes = new Map<string, ObservationScope>();
  // Idle scopes can be forgotten; active/queued readers must retain their shared identity.
  const pruneScopes = () => {
    if (scopes.size <= 4096) return;
    for (const [key, scope] of scopes) {
      if (scope.readers > 0) continue;
      scope.valid = false;
      scopes.delete(key);
      const prefix = `${key}:`;
      for (const entry of entries.keys()) if (entry.startsWith(prefix)) entries.delete(entry);
      if (scopes.size <= 4096) break;
    }
  };
  const waiting: (() => void)[] = [];
  let active = 0;
  const acquire = async () => {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const scope = (id: ForgeStatusIdentity) =>
    JSON.stringify([id.authority, id.owner.toLowerCase(), id.repo.toLowerCase()]);
  const unknown = (value: PullRequestStatus | null): PullRequestStatus | null => {
    if (!value) return null;
    const result = {
      ...value,
      pipeline: 'unknown' as const,
      observationFailed: true,
      mergeable: null,
      checks: { completed: 0, total: 0, successful: 0, failed: 0, pending: 0 },
    };
    delete result.mergeState;
    return result;
  };
  return {
    async read(
      id: ForgeStatusIdentity,
      branch: string,
      load: (observationScope: object) => Promise<PullRequestStatus | null>,
      reportUnavailable = false,
    ): Promise<PullRequestStatus | null> {
      const scopeKey = scope(id);
      let observation = scopes.get(scopeKey);
      if (!observation) {
        observation = { generation: {}, valid: true, readers: 0 };
        scopes.set(scopeKey, observation);
      }
      const generation = observation;
      const branchKey = `${scope(id)}:branch:${branch}`;
      const key = reportUnavailable ? `${branchKey}\0report-unavailable` : branchKey;
      const headKey = branchKey.split('\0')[0]!;
      const epoch = branchEpochs.get(headKey) ?? 0;
      const running = pending.get(key);
      if (running) return running;
      const previous = entries.get(key);
      const check = (value: PullRequestStatus | null, failures: number) => {
        if (reportUnavailable && value === null && failures > 0)
          throw new Error('Forge pull request status unavailable');
        return value;
      };
      if (previous && now() < previous.nextReadAt)
        return structuredClone(check(previous.value, previous.failures));
      generation.readers++;
      pruneScopes();
      const read = (async () => {
        let value: PullRequestStatus | null;
        let failures = 0;
        try {
          await acquire();
          try {
            // A mutation may have invalidated this read while it waited for a slot.
            if (!generation.valid) return unknown(previous?.value ?? null);
            value = await load(generation.generation);
          } finally {
            release();
          }
          if (value?.observationFailed === true) {
            value = unknown(value);
            failures = (previous?.failures ?? 0) + 1;
          }
        } catch {
          value = unknown(previous?.value ?? null);
          failures = (previous?.failures ?? 0) + 1;
        }
        const ttl = failures
          ? Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4))
          : !value
            ? 5_000
            : value.phase !== 'open'
              ? 300_000
              : value.pipeline === 'running' ||
                  value.pipeline === 'pending' ||
                  value.checks.total === 0
                ? 15_000
                : 30_000;
        const entry = { value, failures, checkedAt: now(), nextReadAt: now() + ttl };
        if (!generation.valid) return unknown(value);
        if ((branchEpochs.get(headKey) ?? 0) !== epoch) return value;
        entries.set(key, entry);
        // Bound retained data even when projects or branches disappear.
        while (entries.size > 4096) entries.delete(entries.keys().next().value!);
        return check(value, failures);
      })();
      pending.set(key, read);
      try {
        return structuredClone(await read);
      } finally {
        if (pending.get(key) === read) pending.delete(key);
        generation.readers--;
        pruneScopes();
      }
    },
    invalidate(id: ForgeStatusIdentity): void {
      const scopeKey = scope(id);
      const observation = scopes.get(scopeKey);
      if (observation) observation.valid = false;
      scopes.delete(scopeKey);
      const prefix = `${scopeKey}:`;
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    },
    /**
     * Forget only the given branches of one repository. Activity in one session
     * must not discard every other branch's observation in the same project: that
     * turned each agent tool call into a full re-read of the whole repository.
     */
    invalidateBranches(id: ForgeStatusIdentity, branches: readonly string[]): void {
      const scopeKey = scope(id);
      for (const branch of branches) {
        const branchKey = `${scopeKey}:branch:${branch}`;
        const numbered = new Set(
          [...pending.keys(), ...entries.keys()].filter((key) => key.startsWith(`${branchKey}\0`)),
        );
        const keys = [branchKey, ...numbered];
        const nextEpoch = (branchEpochs.get(branchKey) ?? 0) + 1;
        // Re-insert so the bound below evicts the least recently invalidated branch.
        branchEpochs.delete(branchKey);
        branchEpochs.set(branchKey, nextEpoch);
        for (const key of keys) {
          pending.delete(key);
          entries.delete(key);
        }
      }
      while (branchEpochs.size > 4096) branchEpochs.delete(branchEpochs.keys().next().value!);
    },
  };
}

export function selectBranchStatus(
  values: readonly (PullRequestStatus | null)[],
  forge: 'github' | 'forgejo',
): PullRequestStatus | null {
  const open = values
    .filter((value): value is PullRequestStatus => value?.phase === 'open')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
  return open ?? (forge === 'forgejo' ? values.find((value) => value !== null) : values[0]) ?? null;
}
