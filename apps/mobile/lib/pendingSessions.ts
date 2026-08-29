/**
 * The session creations that are still in flight, keyed by the session id the app
 * minted for them.
 *
 * Creating a session is slow — `POST /sessions` refreshes the base branch from
 * origin, adds a git worktree, and mirrors the repo's module links into it — so
 * waiting for it before drawing anything left the operator on a spinner for
 * seconds. Instead the app mints the id itself ({@link newSessionId}), opens the
 * chat on the spot, and lets the request finish in the background.
 *
 * That splits "which session" from "does the server know about it yet", and the
 * two are not always resolved on the same screen: a phone renders the chat inline
 * on `/new`, while a tablet redirects into the split home, where the pane mounts
 * the chat from the id in the route. A module-level registry is what lets the
 * second case work at all — a promise cannot be threaded through a URL.
 *
 * `useSession` looks the id up on mount and hands the promise to the session model
 * as its `ready` gate, so the stream, the polls, and the first turn all wait for
 * the real session while the operator already sees (and types into) the chat.
 */
import { randomUUID } from 'expo-crypto';

/** Resolved creations are forgotten; a rejected one is kept, so a screen that
 * mounts after the failure still learns the session will never exist instead of
 * silently talking to an id the server never minted. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Mint a session id for a creation the app is about to start. Uses the same UUID
 * shape the server mints — `POST /sessions` accepts it verbatim and is idempotent
 * on it, so a retried request can never produce a second session.
 */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * Register the in-flight creation of `sessionId` so any screen that opens this
 * session waits for it.
 */
export function registerPendingSession(sessionId: string, created: Promise<void>): void {
  const tracked = created.then(() => {
    // Only drop OUR entry: ids are never reused, but a late resolve must not clear
    // a newer registration if one ever were.
    if (inFlight.get(sessionId) === tracked) inFlight.delete(sessionId);
  });
  // Consumers attach their own handlers; without this a creation nobody opened
  // would surface as an unhandled rejection.
  void tracked.catch(() => undefined);
  inFlight.set(sessionId, tracked);
}

/** The pending creation of `sessionId`, or `undefined` when the session already
 * exists server-side — the usual case, since every session opened from the list
 * was created long ago. */
export function pendingSession(sessionId: string): Promise<void> | undefined {
  return inFlight.get(sessionId);
}
