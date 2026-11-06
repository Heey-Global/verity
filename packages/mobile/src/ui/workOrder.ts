import type { SessionSummary } from '../api.js';
import { isUnread, type SeenOverrides } from '../unread.js';

/**
 * Where a session stands in a project's Work list: lower comes first.
 *
 * What needs the operator or is moving leads, whether or not it is a favorite —
 * a favorite that waits for an answer must not sit below one that is idle. Then
 * favorites, then the rest. The tiers mirror the row's own markers (the
 * Needs input/Crashed label, the working dot, the blue unread dot, the star), so
 * the order explains itself.
 */
function workTier(session: SessionSummary, overrides: SeenOverrides = new Map()): number {
  if (session.status === 'awaiting_input' || session.status === 'crashed') return 0;
  if (
    session.status === 'running' ||
    session.status === 'awaiting_dependency' ||
    session.backgroundWorking === true
  )
    return 1;
  if (isUnread(session, overrides)) return 2;
  if (session.favorite === true) return 3;
  return 4;
}

/** A project's sessions in Work order: by {@link workTier}, then latest activity first. */
export function workOrder(
  sessions: readonly SessionSummary[],
  overrides: SeenOverrides = new Map(),
): SessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index, tier: workTier(session, overrides) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (b.session.lastActivityAt ?? 0) - (a.session.lastActivityAt ?? 0) ||
        a.index - b.index,
    )
    .map(({ session }) => session);
}
