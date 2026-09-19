import type { ProjectRecord } from '@verity/store';

export interface ProjectListCache {
  list(): Promise<ProjectRecord[]>;
  /** Forget the memoised list after a write to a project row, so the next
   * read observes the write instead of the last sync. */
  invalidate(): void;
}

/**
 * Memoises the fleet listing for `ttlMs` and runs at most one load at a time.
 *
 * A write must never hide behind the cache window: `invalidate` bumps a
 * generation, and a load only stores its result when the generation it started
 * under is still current. A read after an invalidation does not join a load
 * that may have read the rows before the write; it waits for that load to
 * finish and then starts its own, so the loader's side effects (the GitHub
 * sync, the container reconciliation) never run concurrently either.
 */
export function createProjectListCache(
  load: () => Promise<ProjectRecord[]>,
  { ttlMs, now = Date.now }: { ttlMs: number; now?: () => number },
): ProjectListCache {
  let cached: { at: number; result: ProjectRecord[] } | undefined;
  let inflight: { generation: number; promise: Promise<ProjectRecord[]> } | undefined;
  let generation = 0;

  return {
    list() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.result);
      if (inflight?.generation === generation) return inflight.promise;
      const started = generation;
      // A load from before an invalidation may still be running: wait for it
      // rather than running the loader's side effects twice at once.
      const stale = inflight?.promise;
      const promise = (stale ? stale.catch(() => undefined).then(load) : load())
        .then((result) => {
          if (started === generation) cached = { at: now(), result };
          return result;
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = undefined;
        });
      inflight = { generation: started, promise };
      return promise;
    },
    invalidate() {
      generation += 1;
      cached = undefined;
    },
  };
}
