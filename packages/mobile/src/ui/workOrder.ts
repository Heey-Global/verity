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

/** Work tiers; retained active sessions keep their places and newcomers append. */
export function workOrder(
  sessions: readonly SessionSummary[],
  overrides: SeenOverrides = new Map(),
  previous: readonly SessionSummary[] = [],
): SessionSummary[] {
  const activeRanks = new Map(
    previous
      .filter((session) => workTier(session) === 1)
      .map((session, index) => [session.sessionId, index]),
  );
  return sessions
    .map((session, index) => ({ session, index, tier: workTier(session, overrides) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.tier === 1
          ? (activeRanks.get(a.session.sessionId) ?? Infinity) -
              (activeRanks.get(b.session.sessionId) ?? Infinity) ||
            (a.session.sortOrder ?? Infinity) - (b.session.sortOrder ?? Infinity) ||
            a.session.sessionId.localeCompare(b.session.sessionId)
          : (b.session.lastActivityAt ?? 0) - (a.session.lastActivityAt ?? 0)) ||
        a.index - b.index,
    )
    .map(({ session }) => session);
}
