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
  if (events.length === 0) return 'idle';
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
