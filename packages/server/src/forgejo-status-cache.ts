import { ForgeObservationError } from './forge-observation-error.js';

interface Snapshot {
  until: number;
  pending: boolean;
  value: Promise<unknown>;
}
interface RepositoryReads {
  snapshots: Map<string, Snapshot>;
  until: number;
  failures: number;
  active: number;
  probe?: Promise<void>;
}

/** A status-cache generation owns its snapshots; invalidation never revives old reads. */
export function createForgejoStatusReads() {
  let generations = new WeakMap<object, Map<string, RepositoryReads>>();
  let ordinary = new Map<string, RepositoryReads>();
  const prune = <T>(map: Map<string, T>, removable: (value: T) => boolean) => {
    for (const [key, value] of map) {
      if (map.size <= 200) break;
      if (removable(value)) map.delete(key);
    }
  };
  return {
    clear() {
      generations = new WeakMap();
      ordinary = new Map();
    },
    repository(scope: object | undefined, credential: string, repository: string) {
      let repositories = scope ? generations.get(scope) : ordinary;
      if (!repositories) {
        repositories = new Map();
        generations.set(scope!, repositories);
      }
      const identity = `${credential}:${repository}`;
      let state = repositories.get(identity);
      if (!state) {
        state = { snapshots: new Map(), until: 0, failures: 0, active: 0 };
        repositories.set(identity, state);
      }
      const reads = state;
      const owner = repositories;
      const fail = () => {
        if (Date.now() < reads.until) return;
        reads.failures = Math.min(5, reads.failures + 1);
        reads.until = Math.max(
          reads.until,
          Date.now() + Math.min(300_000, 30_000 * 2 ** (reads.failures - 1)),
        );
      };
      return {
        async observe<T>(
          load: () => Promise<T>,
          incomplete: (value: T) => boolean,
          unsupported: (error: unknown) => boolean,
        ): Promise<T> {
          let release: (() => void) | undefined;
          try {
            while (reads.probe) await reads.probe;
            if (Date.now() < reads.until)
              throw new ForgeObservationError(
                'unavailable',
                'pull-request-backoff',
                new Date(reads.until).toISOString(),
              );
            if (reads.until > 0) {
              reads.probe = new Promise((resolve) => {
                release = resolve;
              });
            }
            reads.active++;
            try {
              const value = await load();
              if (incomplete(value)) fail();
              else if (release) {
                reads.until = 0;
                reads.failures = 0;
              }
              return value;
            } catch (error) {
              if (!unsupported(error)) fail();
              throw error;
            } finally {
              reads.active--;
            }
          } finally {
            if (release) {
              delete reads.probe;
              release();
            }
            prune(owner, (entry) => entry.active === 0 && entry.probe === undefined);
          }
        },
        read<T>(key: string, load: () => Promise<T>, enabled = true): Promise<T> {
          if (!enabled) return load();
          const prior = reads.snapshots.get(key);
          if (prior && (prior.pending || prior.until > Date.now()))
            return prior.value as Promise<T>;
          const entry: Snapshot = {
            until: Infinity,
            pending: true,
            value: Promise.resolve().then(load),
          };
          reads.snapshots.set(key, entry);
          void entry.value.then(
            () => {
              entry.pending = false;
              entry.until = Date.now() + 2_000;
              prune(reads.snapshots, (snapshot) => !snapshot.pending);
            },
            () => {
              entry.pending = false;
              entry.until = Date.now() + 5_000;
              prune(reads.snapshots, (snapshot) => !snapshot.pending);
            },
          );
          return entry.value as Promise<T>;
        },
      };
    },
  };
}
