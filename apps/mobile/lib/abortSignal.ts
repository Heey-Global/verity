// React Native installs its AbortController/AbortSignal from the
// `abort-controller` polyfill (see react-native/Libraries/Core/setUpXHR.js).
// That implementation only offers `aborted`, `onabort` and the event
// listeners: `signal.throwIfAborted()` is undefined there and `signal.reason`
// is never set. Calling the method crashes with "undefined is not a function"
// on a device while Jest, which runs on Node's complete implementation, stays
// green. Use this helper instead; `abortSignal.test.ts` guards the sources.

/** Rejection used when a signal without a `reason` has been aborted. */
export class AbortError extends Error {
  constructor() {
    super('The operation was aborted.');
    this.name = 'AbortError';
  }
}

/**
 * Throws when `signal` has been aborted, like `AbortSignal.throwIfAborted()`,
 * but relying only on `aborted`. A runtime that records the abort reason gets
 * that reason thrown, matching the standard method.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = (signal as { reason?: unknown }).reason;
  throw reason === undefined ? new AbortError() : reason;
}
