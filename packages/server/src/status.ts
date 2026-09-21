import type { AgentEvent, AgentStatus } from '@verity/events';

/** A session's badge status (concept §12) — the agent lifecycle plus `idle`. */
export type SessionStatus = AgentStatus | 'idle';

/**
 * Derive a session's current status from its canonical event log — a read-time
 * projection (§12), not persisted state. Scans backward for the most recent
 * status-bearing event: an explicit `status` wins; otherwise a `result` or
 * `interrupted` → completed, `error` → crashed, an unresolved `permission` →
 * awaiting_input.
 * An empty log is `idle`; a log with only neutral events is treated as running.
 *
 * Background tasks (sub-agents / `run_in_background`) outlive a turn's first
 * `result`: the backend re-invokes with a later `result` once they finish. So a
 * `result` reached with any task still open is an intra-turn checkpoint, not the
 * session's end — the session is still running. The open set is scoped to the
 * current turn: a fresh `prompt` is an authoritative boundary, so an orphaned task
 * from an older turn cannot keep every later, normally completed turn running.
 */
export function deriveSessionStatus(events: readonly AgentEvent[]): SessionStatus {
  return deriveSessionStatusFromProjection(events, events.length);
}

/**
 * Whether {@link deriveSessionStatusFromProjection} would return the same status
 * for this tail as it would for the whole slice it was cut from.
 *
 * This is the licence for reading only the end of a long log. It holds because a
 * non-steered `prompt` is a hard boundary in BOTH passes of the derivation:
 *
 * - the forward pass calls `openTasks.clear()` on one, so no `task` before it can
 *   affect the open set afterwards;
 * - the backward scan returns `'running'` on one, so it never reads past it.
 *
 * So every event preceding the most recent non-steered `prompt` is unreachable,
 * and a tail containing one carries everything the derivation can observe.
 *
 * {@link permissionEventAwaitsInput} runs over the same tail wherever this one
 * does, and is bounded by the same event for its own reasons: its backward scan
 * returns on a non-steered `prompt`. The licence covers both, and a guard in
 * `status.test.ts` holds it to that.
 *
 * It is a predicate rather than a length, deliberately: "far enough back" is not
 * a number of events. One turn can emit an unbounded run of `task`, `status` and
 * `permission` events, so any fixed window is sometimes short — the caller has to
 * be able to find out and read more, and a tail that misses the boundary is
 * indistinguishable from a complete short log without asking.
 *
 * If the derivation ever grows a pass that reads past a `prompt`, this stops
 * being true, and it lives here so that change and this proof are in one file.
 */
export function projectionTailIsSelfContained(events: readonly AgentEvent[]): boolean {
  return events.some((event) => event.t === 'prompt' && event.steered !== true);
}

/** Whether the current `awaiting_input` projection comes from a durable permission
 * event rather than another kind of question/status. Used with the conductor's
 * live pending set to retire an answered card without hiding unrelated input. */
export function permissionEventAwaitsInput(events: readonly AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || (event.t === 'prompt' && event.steered === true)) continue;
    if (event.t === 'permission') return true;
    if (
      event.t === 'status' ||
      event.t === 'result' ||
      event.t === 'interrupted' ||
      event.t === 'error' ||
      event.t === 'prompt'
    ) {
      return false;
    }
  }
  return false;
}

/**
 * {@link deriveSessionStatus} over a log already narrowed to
 * `SESSION_PROJECTION_EVENT_TYPES`, so the overview does not have to hydrate
 * whole logs to render a badge.
 *
 * The narrowing is lossless HERE and nowhere else: the forward pass reads only
 * `prompt` and `task`, and the backward scan returns on `status`, `result`,
 * `interrupted`, `error`, `permission` or a non-steered `prompt` and otherwise
 * keeps scanning — so dropping every other kind cannot change which event the
 * scan settles on. The single exception is the empty-log case, which is why
 * `totalEventCount` is passed separately: a session whose log holds nothing but
 * `text` events is running, not idle, and `events.length` can no longer tell
 * those apart.
 */
export function deriveSessionStatusFromProjection(
  events: readonly AgentEvent[],
  totalEventCount: number,
): SessionStatus {
  if (totalEventCount === 0) return 'idle';
  const openTasks = new Set<string>();
  for (const event of events) {
    // A new operator turn cannot belong to a background task from the preceding
    // turn. Normally the backend writes that task's `ended` event first, but logs
    // produced by an interrupted process or an older backend may be missing it.
    // Forget those historical orphans at the new turn boundary.
    if (event?.t === 'prompt' && event.steered !== true) {
      openTasks.clear();
      continue;
    }
    if (event?.t !== 'task') continue;
    if (event.phase === 'started') openTasks.add(event.id);
    else if (event.phase === 'ended') openTasks.delete(event.id);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    // A fresh operator prompt starts a new turn. Until that turn emits its own
    // status-bearing event it is running; never inherit a terminal marker from
    // the preceding turn. Steered prompts remain part of the current turn.
    if (event.t === 'prompt' && event.steered !== true) return 'running';
    switch (event.t) {
      case 'status':
        return event.state;
      case 'result':
        return openTasks.size > 0 ? 'running' : 'completed';
      case 'interrupted':
        return 'completed';
      case 'error':
        return 'crashed';
      case 'permission':
        return 'awaiting_input';
      default:
        break;
    }
  }
  return 'running';
}
