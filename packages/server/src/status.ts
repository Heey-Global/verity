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
