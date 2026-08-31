import type { SessionSummary } from './api.js';

/**
 * Unread tracking for the session list (#387). The server carries a monotonic
 * `eventCount` per session plus a server-persisted "last seen" mark
 * (`lastSeenEventCount`, the count when the operator last OPENED the session); a
 * session is unread when its event count has moved past that mark. The mark lives
 * on the server (no per-device scoping), so clearing an unread dot on one device
 * clears it on every device. Pure logic here — the React hook owns the network I/O
 * and the optimistic override map. Deliberately conservative: a session with no
 * mark (never opened on any device) is NOT unread, which matches "new since you
 * last opened it" and avoids the whole list lighting up on first launch.
 */

/**
 * Optimistic local overrides layered over the server-persisted `lastSeenEventCount`:
 * `sessionId → the eventCount just marked seen on this device`. An entry bridges the
 * poll latency between opening a session and the server-confirmed mark arriving on
 * the next `GET /sessions`; the hook clears it once the poll catches up.
 */
export type SeenOverrides = ReadonlyMap<string, number>;

/** The effective "last seen" event count for a session: a pending local override
 * (the operator just opened it here) wins over the server-persisted mark. Returns
 * `undefined` when neither exists — a session never opened on any device. */
export function effectiveSeen(
  session: SessionSummary,
  overrides: SeenOverrides,
): number | undefined {
  const override = overrides.get(session.sessionId);
  if (override !== undefined) return override;
  return session.lastSeenEventCount ?? undefined;
}

/** Whether a single session has unread activity given the current overrides. */
export function isUnread(session: SessionSummary, overrides: SeenOverrides): boolean {
  const seen = effectiveSeen(session, overrides);
  return seen !== undefined && session.eventCount !== undefined && session.eventCount > seen;
}

/** The set of session ids with unread activity (see {@link isUnread}). */
export function unreadSessionIds(
  sessions: readonly SessionSummary[],
  overrides: SeenOverrides,
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (isUnread(session, overrides)) ids.add(session.sessionId);
  }
  return ids;
}

/** Record that a session has been seen at `eventCount`, returning the next override
 * map. Never moves an override backward (a stale open mustn't undo a fresher mark);
 * an absent/undefined count is a no-op so opening a session an older server didn't
 * count for doesn't clear a genuine unread. Returns the same map reference when
 * nothing changes, so callers can skip a redundant write/render. */
export function advanceOverride(
  overrides: SeenOverrides,
  sessionId: string,
  eventCount?: number,
): SeenOverrides {
  if (eventCount === undefined) return overrides;
  const prev = overrides.get(sessionId);
  if (prev !== undefined && prev >= eventCount) return overrides;
  const next = new Map(overrides);
  next.set(sessionId, eventCount);
  return next;
}

/** Drop overrides the server has caught up to: an entry is stale once the polled
 * session's persisted `lastSeenEventCount` reached (or passed) it, at which point
 * the server value alone yields the same result. Also drops overrides for sessions
 * no longer in the list (deleted). Returns the same map reference when nothing is
 * reconciled, so the hook can skip a redundant render. */
export function reconcileOverrides(
  overrides: SeenOverrides,
  sessions: readonly SessionSummary[],
): SeenOverrides {
  if (overrides.size === 0) return overrides;
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  let next: Map<string, number> | undefined;
  for (const [sessionId, seen] of overrides) {
    const session = byId.get(sessionId);
    const confirmed =
      session === undefined ||
      (session.lastSeenEventCount !== undefined &&
        session.lastSeenEventCount !== null &&
        session.lastSeenEventCount >= seen);
    if (confirmed) {
      next ??= new Map(overrides);
      next.delete(sessionId);
    }
  }
  return next ?? overrides;
}
