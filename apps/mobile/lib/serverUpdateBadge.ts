/**
 * Whether the app chrome should show that a Server update is waiting.
 *
 * ADR 0008 D11 keeps starting an update an explicit, master-password-guarded
 * action, and this does not change that. It changes who has to remember to look:
 * before this, availability was resolved only when the settings screen asked, so a
 * deployment whose owner never opened that screen stayed on its installed release
 * while believing itself current.
 *
 * Deliberately its own tiny client rather than a shared context: every screen in
 * this app already builds one with `createVerityClient()`, and threading a
 * provider through the root layout for one boolean would be the larger change.
 */

import { useEffect, useState } from 'react';
import { serverUpdateAwaitsAttention, subscribeServerUpdateStatusMutations } from '@verity/mobile';
import { createVerityClient, getVerityBaseUrl } from './client';

/**
 * Five minutes, because that is the server's own availability cache: asking more
 * often re-reads the same answer, and the question is "is there a release", not
 * "has one appeared in the last few seconds". The push notification is what makes
 * it timely; this is what keeps the chrome honest between pushes.
 */
export const SERVER_UPDATE_BADGE_POLL_MS = 5 * 60_000;

/**
 * `enabled` is the screen asking for the badge, not a preference. Every screen in
 * the stack renders this header and the previous ones stay mounted behind it, so a
 * hook that polled unconditionally would run one timer per screen the operator has
 * pushed and fire a request on every navigation — for a dot only the overview
 * draws. Passing the caller's own `isHome` keeps exactly one poller alive.
 */
export function useServerUpdateBadge(enabled: boolean): boolean {
  /**
   * The server an update is pending for, rather than a bare flag — the dot is a
   * claim about one particular server, and this hook outlives the choice of it.
   * The header stays mounted while the operator re-pairs, so a plain boolean would
   * carry an old server's `true` onto a new one and keep it there: the poll below
   * deliberately ignores failures, and there may be no client to ask at all. Keyed
   * to the base URL, an answer expires the moment it stops being about the server
   * in front of the operator.
   */
  const [pendingFor, setPendingFor] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeServerUpdateStatusMutations((status) => {
        if (!enabled) return;
        const baseUrl = getVerityBaseUrl();
        setPendingFor(baseUrl !== null && serverUpdateAwaitsAttention(status) ? baseUrl : null);
      }),
    [enabled],
  );

  useEffect(() => {
    if (!enabled) {
      // Nothing is polling any more, so nothing is keeping this fresh. Whatever
      // was true when the operator navigated away must be re-earned on the way
      // back rather than shown while the first request is still in flight.
      setPendingFor(null);
      return;
    }
    let cancelled = false;

    const read = (): void => {
      // Both read per pass rather than captured: the client is null until the
      // operator has chosen a server, and that can happen after this header
      // mounted. Captured once, the badge would stay dark until the app restarts.
      const baseUrl = getVerityBaseUrl();
      const client = createVerityClient();
      if (client === null || baseUrl === null) {
        // No server configured — there is nothing a dot could be about.
        setPendingFor(null);
        return;
      }
      void client
        .getServerUpdates()
        .then((status) => {
          if (!cancelled) setPendingFor(serverUpdateAwaitsAttention(status) ? baseUrl : null);
        })
        // A server that cannot answer is not evidence that an update is waiting.
        // In particular, the previous `true` may be the answer from immediately
        // before that same server activated the update.
        // The last successful answer may predate an update cutover. Once that
        // server disappears, retaining `true` turns a transient outage into a
        // stale badge for the full five-minute poll interval.
        .catch(() => {
          if (!cancelled) setPendingFor(null);
        });
    };

    read();
    const timer = setInterval(read, SERVER_UPDATE_BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return enabled && pendingFor !== null && pendingFor === getVerityBaseUrl();
}
