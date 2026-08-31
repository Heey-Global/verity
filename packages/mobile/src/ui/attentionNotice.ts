/**
 * Rendering gate for the `attention` signals the server sends (pure ->
 * unit-testable), modelled on {@link ./rateLimit.ts}: the screen renders at most
 * ONE line, and the decision about which line — and whether there is one at all —
 * is made here rather than in the component.
 *
 * Used for BOTH placements the server has, because the rendering question is the
 * same one twice:
 *
 * - the SERVER-level signals on the `?envelope=1` session list (sealed, Updater
 *   not answering) — conditions under which the list looks perfectly healthy and
 *   is not, rendered as one banner above it;
 * - the SESSION-level signals on a session summary (a sandbox replaced under the
 *   session), rendered on that session's own row.
 *
 * Distinct from `./attention.ts`, which DERIVES what a session wants from the
 * operator out of its status and PR. This only decides how to show a line the
 * server already wrote.
 */

import type { AttentionSignal } from '../api.js';

/**
 * A remedy this build knows how to open. The server names remedies by intent and
 * may name one this app has never heard of; {@link attentionAction} is where that
 * becomes "no button" rather than a dead tap or a crash.
 */
export type AttentionAction = 'codex-login';

const KNOWN_ACTIONS: Readonly<Record<AttentionAction, string>> = {
  'codex-login': 'Sign in to Codex',
};

/**
 * The action a signal offers, or null when it offers none this build can open.
 *
 * `Object.hasOwn` rather than `in`: the string comes off the wire, and `in` walks
 * the prototype chain — `'toString'` would pass it and hand back an "action" that
 * is a function on Object.prototype.
 */
export function attentionAction(action: string | undefined): AttentionAction | null {
  return action !== undefined && Object.hasOwn(KNOWN_ACTIONS, action)
    ? (action as AttentionAction)
    : null;
}

/** The button label for an action. */
export function attentionActionLabel(action: AttentionAction): string {
  return KNOWN_ACTIONS[action];
}

export interface AttentionNotice {
  /** Keys the notice and lets a future client special-case a condition. */
  code: string;
  /** Already operator-facing; rendered verbatim. */
  message: string;
  /** How many conditions are active, so the notice can say there are more. */
  count: number;
  /** The single remedy this notice offers as a tap, when it has one. */
  action?: AttentionAction | undefined;
}

/**
 * The one notice to show, or null when there is nothing to say.
 *
 * Only the first signal is rendered even when several are active. The server
 * emits these in severity order and the banner is one line above a list the
 * operator came to read — stacking banners would push the list off screen for a
 * message they can only act on one at a time anyway. `count` is what lets the
 * notice admit the others exist.
 */
export function attentionNotice(
  signals: readonly AttentionSignal[] | undefined,
): AttentionNotice | null {
  const first = signals?.[0];
  if (first === undefined) return null;
  // The action belongs to the signal being SHOWN, not to whichever active signal
  // happens to have one: a button under the sealed-server line that opens the
  // Codex login would be acting on a sentence nobody is reading.
  const action = attentionAction(first.action);
  return {
    code: first.code,
    message: first.message,
    count: signals?.length ?? 1,
    ...(action === null ? {} : { action }),
  };
}

/** The notice's text, including the "+N more" tail when several are active. */
export function attentionNoticeText(notice: AttentionNotice): string {
  return notice.count > 1 ? `${notice.message} (+${notice.count - 1} more)` : notice.message;
}
