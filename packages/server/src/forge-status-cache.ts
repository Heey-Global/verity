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
  const aliases = new Map<string, string>();
  const epochs = new Map<string, number>();
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
      load: () => Promise<PullRequestStatus | null>,
    ): Promise<PullRequestStatus | null> {
      const epochKey = scope(id);
      const epoch = epochs.get(epochKey) ?? 0;
      const branchKey = `${scope(id)}:branch:${branch}`;
      const key = aliases.get(branchKey) ?? branchKey;
      const running = pending.get(key);
      if (running) return running;
      const previous = entries.get(key);
      if (previous && now() < previous.nextReadAt) return structuredClone(previous.value);
      const read = (async () => {
        let value: PullRequestStatus | null;
        let failures = 0;
        try {
          await acquire();
          try {
            value = await load();
          } finally {
            release();
          }
          if (value?.pipeline === 'unknown') failures = (previous?.failures ?? 0) + 1;
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
        if ((epochs.get(epochKey) ?? 0) !== epoch) return unknown(value);
        entries.set(key, entry);
        if (value) {
          const prKey = `${scope(id)}:pr:${value.number}`;
          aliases.set(branchKey, prKey);
          entries.set(prKey, entry);
        }
        // Bound retained data even when projects or branches disappear.
        while (entries.size > 4096) entries.delete(entries.keys().next().value!);
        while (aliases.size > 4096) aliases.delete(aliases.keys().next().value!);
        return value;
      })();
      pending.set(key, read);
      try {
        return structuredClone(await read);
      } finally {
        if (pending.get(key) === read) pending.delete(key);
      }
    },
    invalidate(id: ForgeStatusIdentity): void {
      const epochKey = scope(id);
      epochs.set(epochKey, (epochs.get(epochKey) ?? 0) + 1);
      const prefix = `${epochKey}:`;
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
      for (const key of aliases.keys()) if (key.startsWith(prefix)) aliases.delete(key);
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
