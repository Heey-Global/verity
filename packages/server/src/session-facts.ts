/**
 * How the fleet listing behind `verity_list_sessions` is assembled: which rows are read from
 * disk at all, and in what order the answer comes back.
 *
 * It lives in its own module rather than inline in the route because every decision in it is
 * a cost or a correctness choice worth asserting — the prefilter that decides what is never
 * hydrated, the cap, the pool bound, and the rule that one failed read fails the whole
 * listing. Inline it could only be reached through a running server with a real event store,
 * which is how the expensive half of a tool ends up covered by a two-session fixture.
 *
 * Generic over the row and the summary: the route supplies its own `SessionRecord` and its
 * own `summarizeSession`, so the listing's `status` and `resumable` stay the same projection
 * `GET /sessions` serves rather than a second definition that can disagree with it.
 */

/** How many sessions are read at once — both for the worktree check and for hydration. Each
 *  hydration costs a full event-log read, and the tool is called with no narrowing by
 *  default; the bound is what keeps an unnarrowed listing from opening one descriptor per
 *  session the install has ever run. */
export const SESSION_LISTING_HYDRATION_LIMIT = 8;

/** The cheap session row, before anything is read from disk for it. */
export interface SessionFactsRow {
  sessionId: string;
  projectId: string | null;
  worktree: string;
}

export interface SessionFactsSource<Row extends SessionFactsRow, Summary> {
  listSessions(): Promise<readonly Row[]>;
  /** A `stat`. Cheap next to `summarize`, which is the whole reason it runs first. */
  worktreeExists(worktree: string): Promise<boolean>;
  /** Reads the session's entire event log. The expensive one. */
  summarize(row: Row): Promise<Summary>;
}

/**
 * Run `task` over `items` with at most `limit` in flight, returning results in INPUT order.
 *
 * Ordered by index rather than by completion, so a listing does not depend on which event log
 * happened to read fastest. A rejection propagates: `Promise.all` over the workers means one
 * failed read fails the call rather than silently dropping that session — an incomplete list
 * is the worse answer here, because the caller reads it as the fleet and would conclude a
 * session it cannot see does not exist.
 *
 * That rejection also stops the pool. `Promise.all` rejects on the first failure but does not
 * cancel its siblings, and the work here is file reads whose results are already known to be
 * discarded — without the flag, one corrupt event log still costs a full sweep of the fleet
 * before the caller sees the error. In-flight reads are not interrupted; only unstarted ones
 * are skipped.
 */
async function mapPooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  await Promise.all(
    // At least one worker. A `limit` of zero or less would spawn none, and `Promise.all([])`
    // resolves — returning an empty result for a non-empty input, which is the silent
    // truncation the rejection-propagation above exists to avoid. Degrading to serial is the
    // right failure for a nonsensical limit; returning half a fleet is not.
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
      (async () => {
        for (let index = next++; index < items.length; index = next++) {
          if (failed) return;
          try {
            results[index] = await task(items[index]!);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      })(),
    ),
  );
  return results;
}

/**
 * Apply a cap to the rows a listing is about to project.
 *
 * Four lines, and named only so the choice inside them is testable without standing up a
 * fleet: it keeps the TAIL. The session table is ordered oldest-first, and the sessions a
 * handoff is looking for are the recent ones — a cap that kept the head would answer a large
 * install with the sessions least likely to still matter, and do it silently enough to look
 * like a complete answer.
 *
 * That ordering is the store's, not this module's: `EventStore.listSessions` sorts by
 * `created_at asc` with a `session_id` tiebreaker, and `'lists sessions in creation order,
 * oldest first'` in `packages/store/src/store.test.ts` is what pins it. The dependency runs
 * the other way from the imports, so it is named at both ends — reversing the query would
 * otherwise leave the tool description and the approval card promising "the newest ones" while
 * this returned the oldest, with nothing failing.
 *
 * `limit` is `undefined` for the handoff, which must not cap at all. See
 * `LIST_SESSIONS_MAX_ENTRIES` in `@verity/events` for why the listing does.
 */
export function newestWithinLimit<T>(
  candidates: readonly T[],
  limit: number | undefined,
): { kept: readonly T[]; omitted: number } {
  const omitted = limit === undefined ? 0 : Math.max(0, candidates.length - limit);
  return { kept: candidates.slice(omitted), omitted };
}

/**
 * The rows a listing reports, hydrated — and how many the cap left out.
 *
 * The order of the three narrowing steps is the point:
 *
 * 1. `keep`, against the cheap row. Everything the caller's own narrow would drop outright is
 *    decided here, before anything is read, so a call that named one project does not pay for
 *    the rest of the fleet.
 * 2. The worktree check, for the sessions that survived it. This is the one filter `keep`
 *    cannot express, because deciding it costs a filesystem call: drop the sessions whose
 *    worktree is gone. The session table is append-only apart from an explicit delete, so
 *    every session the install has ever run is still a row and over time most of them are
 *    dead ones — permanently ineligible, and otherwise hydrated in full to be dropped a step
 *    later. After `keep`, so a narrowed call stats only what it was already going to hydrate.
 * 3. The cap, last. It is the only bound on the TOTAL hydrated and returned, where the two
 *    above bound the growth term. `GET /sessions` hydrates the same way with no cap, but it
 *    answers one operator at one screen; this answers an agent told to call it routinely, and
 *    its result is injected whole into that agent's context.
 *
 * The cap does NOT bound step 2, and cannot: deadness is not decidable from the row, so an
 * unnarrowed listing stats every session the install has ever created to find the newest live
 * ones. Capping before the stat would cap a list still full of dead rows and return fewer than
 * the cap — a listing short of what it promised, which is the failure this order avoids. A
 * stat is the cheap end of the two file operations here and the pool bounds its concurrency;
 * the expensive one, the event-log read, is what the cap keeps off an ever-growing table.
 */
export async function collectSessionFacts<Row extends SessionFactsRow, Summary>(
  source: SessionFactsSource<Row, Summary>,
  keep: (candidate: { sessionId: string; projectId: string | null }) => boolean,
  requireResumable: boolean,
  limit: number | undefined,
): Promise<{ summaries: Summary[]; omitted: number }> {
  const rows = await source.listSessions();
  const named = rows.filter((row) => keep({ sessionId: row.sessionId, projectId: row.projectId }));
  // Pooled rather than sequential — a fleet-wide `Promise.all` of stats is how a busy install
  // runs out of file descriptors, but one at a time makes the listing's latency linear in a
  // table that only grows. The same bound serves both, because both are per-session file
  // reads and the descriptors they hold are the resource being protected.
  const alive = requireResumable
    ? await mapPooled(named, SESSION_LISTING_HYDRATION_LIMIT, (row) =>
        source.worktreeExists(row.worktree),
      )
    : undefined;
  const candidates = alive === undefined ? named : named.filter((_, index) => alive[index]);
  const { kept, omitted } = newestWithinLimit(candidates, limit);
  const summaries = await mapPooled(kept, SESSION_LISTING_HYDRATION_LIMIT, (row) =>
    source.summarize(row),
  );
  return { summaries, omitted };
}
