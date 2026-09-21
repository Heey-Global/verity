/**
 * The transient class of turn failure: the project Sandbox was asleep, waking, or
 * still being rebuilt when the turn tried to run.
 *
 * Nothing about such a session is broken — the container comes back and the next
 * turn runs — but the failure used to be persisted as an ordinary terminal
 * `error`, and the status projection maps `error` to `crashed`. That badge is
 * DERIVED from the log and the derivation's backward scan stops at the event it
 * settles on, so a Sandbox that was healthy again a minute later still left the
 * session red until the operator sent another message by hand. Background
 * resolutions (auto-title, the reattach after a restart) hit this constantly:
 * they deliberately fail fast rather than wait out a wake.
 *
 * So the class travels on the Error itself, from wherever the Sandbox state is
 * read to wherever the conductor persists the failure, which writes it as
 * {@link SANDBOX_NOT_READY_ERROR_KIND} instead. The marker is a GLOBALLY
 * registered symbol on purpose: it survives every package boundary, and stays
 * one key even if two copies of this module end up loaded.
 */
const SANDBOX_NOT_READY = Symbol.for('verity.error.sandbox-not-ready');

/**
 * `error.kind` for a turn that could not run because the Sandbox was between
 * lifecycle states. Terminal for the turn like `run_failed`, but the status
 * projection maps it to `idle` rather than `crashed`, and it fires no crash
 * push.
 */
export const SANDBOX_NOT_READY_ERROR_KIND = 'sandbox_not_ready';

/** Mark `error` as a transient Sandbox-lifecycle failure and return it. */
export function markSandboxNotReady<E extends Error>(error: E): E {
  Object.defineProperty(error, SANDBOX_NOT_READY, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/** A marked {@link Error}, ready to throw. */
export function sandboxNotReadyError(message: string, options?: ErrorOptions): Error {
  return markSandboxNotReady(new Error(message, options));
}

/**
 * The `error.kind` a failed turn is persisted under: the transient Sandbox class
 * when the failure carries the marker, the ordinary `run_failed` otherwise.
 *
 * One function, rather than a conditional at the append site, so the kind the
 * conductor WRITES and the kind the status projection READS stay one decision —
 * a session badging `crashed` again is exactly the kind of drift nobody notices.
 */
export function turnFailureErrorKind(error: unknown): string {
  return isSandboxNotReadyError(error) ? SANDBOX_NOT_READY_ERROR_KIND : 'run_failed';
}

/**
 * Whether `error`, or anything it wraps as a `cause`, carries the marker. The
 * cause chain is walked because the seams between the state check and the
 * conductor re-wrap failures (`new Error(msg, { cause })`); it is bounded so a
 * self-referential cause cannot spin here.
 */
export function isSandboxNotReadyError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as Record<symbol, unknown>)[SANDBOX_NOT_READY] === true) return true;
    if (!('cause' in current)) return false;
    current = current.cause;
  }
  return false;
}
