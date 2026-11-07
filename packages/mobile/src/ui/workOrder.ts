import type { SessionSummary } from '../api.js';
import { isUnread, type SeenOverrides } from '../unread.js';

/** Working sessions, kept in a fixed order. */
const ACTIVE_TIER = 1;
/** The bottom tier: merged sessions nothing else holds up. */
const MERGED_TIER = 5;

/**
 * Where a session stands in a project's Work list: lower comes first.
 *
 * What needs the operator or is moving leads, whether or not it is a favorite —
 * a favorite that waits for an answer must not sit below one that is idle. Then
 * favorites, then the rest. The tiers mirror the row's own markers (the
 * Needs input/Crashed label, the working dot, the blue unread dot, the star), so
 * the order explains itself.
 *
 * A session whose pull request has merged and that nothing else holds up sinks
 * to the bottom, below sessions that never had a pull request: its work is done
 * and it is a candidate for deletion. Steering it again makes it active, which
 * lifts it back up; starring it keeps it with the favorites.
 */
function workTier(session: SessionSummary, overrides: SeenOverrides = new Map()): number {
  if (session.status === 'awaiting_input' || session.status === 'crashed') return 0;
  if (
    session.status === 'running' ||
    session.status === 'awaiting_dependency' ||
    session.backgroundWorking === true
  )
    return ACTIVE_TIER;
  if (isUnread(session, overrides)) return 2;
  if (session.favorite === true) return 3;
  if (isMerged(session)) return MERGED_TIER;
  return 4;
}

/** Whether the session's pull request has merged, by the same fields its tile reads. */
function isMerged(session: Pick<SessionSummary, 'pr' | 'pullRequest'>): boolean {
  return (session.pullRequest?.phase ?? session.pr?.phase) === 'merged';
}

/**
 * When a session entered its tier, read from its last activity, so a session
 * that just asked, crashed, got an answer or went quiet joins its tier at the
 * bottom instead of jumping to the top. Starring or reading a session does not
 * touch its activity, so those changes keep its place by activity. A merged pull
 * request rarely changes again, so its last update stands for the merge; without
 * one the session's own last activity stands in.
 */
function enteredAt(session: SessionSummary, tier: number): number {
  if (tier === MERGED_TIER) {
    const merged = Date.parse(session.pullRequest?.updatedAt ?? '');
    if (!Number.isNaN(merged)) return merged;
  }
  return session.lastActivityAt ?? 0;
}

/**
 * Work tiers. Active sessions keep a fixed order (their saved positions), so a
 * row does not move while the operator reaches for it; every other tier lists
 * its sessions in the order they entered it, the latest at the bottom.
 */
export function workOrder(
  sessions: readonly SessionSummary[],
  overrides: SeenOverrides = new Map(),
): SessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index, tier: workTier(session, overrides) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.tier === ACTIVE_TIER
          ? (a.session.sortOrder ?? Infinity) - (b.session.sortOrder ?? Infinity) ||
            a.session.sessionId.localeCompare(b.session.sessionId)
          : enteredAt(a.session, a.tier) - enteredAt(b.session, b.tier)) ||
        a.index - b.index,
    )
    .map(({ session }) => session);
}
