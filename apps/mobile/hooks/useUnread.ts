import {
  type VerityClient,
  type SeenOverrides,
  type SessionSummary,
  advanceOverride,
  reconcileOverrides,
  unreadSessionIds,
} from '@verity/mobile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface UseUnread {
  /** Session ids with new activity since the operator last opened them. */
  unread: Set<string>;
  /** Mark a session seen at its current event count — call when opening it so its
   * unread dot clears on every device. A `undefined` count (older server) is a safe
   * no-op. */
  markSeen: (sessionId: string, eventCount?: number) => void;
}

/**
 * Cross-device unread tracking for the session list (#387). The "last seen" mark is
 * persisted server-side (`session.lastSeenEventCount`), so opening a session on one
 * device clears its unread dot on all of them. This hook derives the unread set from
 * the polled sessions and layers a short-lived optimistic override so the dot clears
 * instantly on tap rather than waiting for the next `GET /sessions`; the override is
 * dropped once the poll confirms the server caught up ({@link reconcileOverrides}).
 * The compare/advance logic is the pure `@verity/mobile` helpers; this hook owns the
 * override state + the `PATCH /sessions/:id/seen` write.
 */
export function useUnread(client: VerityClient, sessions: readonly SessionSummary[]): UseUnread {
  const [overrides, setOverrides] = useState<SeenOverrides>(() => new Map());
  // Highest event count already PATCHed per session, so the split-pane auto-mark
  // effect (which fires markSeen for the open session on EVERY 2s poll) doesn't
  // re-send an unchanged mark. Kept in a ref so `markSeen` stays referentially
  // stable regardless of poll cadence.
  const sentRef = useRef<Map<string, number>>(new Map());

  // Once the polled list confirms the server mark reached an optimistic override,
  // drop the override so the server value (which follows across devices) takes over.
  useEffect(() => {
    setOverrides((current) => reconcileOverrides(current, sessions));
  }, [sessions]);

  const markSeen = useCallback(
    (sessionId: string, eventCount?: number) => {
      if (eventCount === undefined) return;
      // Skip a redundant write: we've already told the server about this count (or a
      // newer one). Advancing is monotonic, so an older count is never re-sent.
      const alreadySent = sentRef.current.get(sessionId);
      if (alreadySent !== undefined && alreadySent >= eventCount) return;
      sentRef.current.set(sessionId, eventCount);
      setOverrides((prev) => advanceOverride(prev, sessionId, eventCount));
      // Persist the mark so the dot clears on every device. A failed write rolls the
      // override + sent-mark back to server truth so a dot isn't stranded cleared
      // locally only, and the next open/poll can retry the write. Both rollbacks are
      // guarded on the value still equaling THIS failed count, so a newer in-flight
      // markSeen(sessionId, N2) that already advanced past N1 is left untouched.
      void client.setSessionSeen(sessionId, eventCount).catch(() => {
        if (sentRef.current.get(sessionId) === eventCount) sentRef.current.delete(sessionId);
        setOverrides((current) => {
          if (current.get(sessionId) !== eventCount) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
      });
    },
    [client],
  );

  const unread = useMemo(() => unreadSessionIds(sessions, overrides), [sessions, overrides]);
  return { unread, markSeen };
}
