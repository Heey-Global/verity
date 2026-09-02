import type { AgentEvent } from './events.js';

/**
 * The event discriminants the session-overview projections actually read.
 *
 * The overview needs four things from a session's log — its status badge, its
 * cumulative token usage, its latest per-window rate-limit states, and how many
 * events it has. The first three are decided ENTIRELY by the discriminants below;
 * every other kind of event (`text`, `thinking`, `tool_call`, `tool_result`,
 * `raw`, …) is skipped by all three projections. Those skipped kinds are also the
 * bulk of a real log, and the only ones carrying large payloads.
 *
 * So this set is what lets `GET /sessions` answer from a narrow slice instead of
 * hydrating every log in full: the store filters on the denormalized `events.type`
 * column, and the projections run on the result with no change to their logic.
 *
 * ADDING A STATUS-BEARING EVENT KIND MEANS ADDING IT HERE. A projection that
 * starts reading a discriminant missing from this set does not fail loudly — it
 * silently stops seeing those events, and the overview quietly serves a wrong
 * badge. `deriveSessionStatus`'s test asserts the equivalence directly against
 * generated logs rather than against this list, so that break is caught.
 */
export const SESSION_PROJECTION_EVENT_TYPES = [
  // Read by `deriveSessionStatus` (the backward scan and the open-task pass).
  'prompt',
  'task',
  'status',
  'result',
  'interrupted',
  'error',
  'permission',
  // Read by `aggregateUsage` (`result`, already listed) and `latestRateLimits`.
  'rate_limit',
] as const satisfies readonly AgentEvent['t'][];

/** Membership test for {@link SESSION_PROJECTION_EVENT_TYPES}. */
const PROJECTION_TYPES: ReadonlySet<string> = new Set(SESSION_PROJECTION_EVENT_TYPES);

/**
 * Keep only the events the overview projections read — the in-memory counterpart
 * of the store's `type in (…)` filter.
 *
 * Its only caller today is the equivalence guard in `status.test.ts`, and that is
 * the point: it exists so the narrowing can be applied to a full log in memory and
 * the two answers compared. Production narrows in SQL and never holds the full log
 * at all, which is the whole saving.
 */
export function sessionProjectionEvents<T extends { t: AgentEvent['t'] }>(
  events: readonly T[],
): T[] {
  return events.filter((event) => PROJECTION_TYPES.has(event.t));
}
