/**
 * A logger for components the embedded boot constructs before the Fastify
 * instance exists.
 *
 * The control plane's logger is `app.log`, and `app` is built roughly a
 * thousand lines after the first long-lived clients are wired. A component
 * started in that window has three options today, and two of them are wrong:
 * capture `app` in a closure and risk the TDZ `ReferenceError` that once
 * crash-looped every sealed boot, or take no logger at all — which is not a
 * quieter boot but a permanently silent component, since the option is read at
 * every call site and an absent one makes each of them a no-op. That is how
 * ten log calls in the Uplink control client produced zero lines in production
 * while an incident ran.
 *
 * So: hand the component this, and bind it once `app.log` exists. Calls before
 * the bind go to the fallback rather than being dropped, because the boot
 * window is exactly when a client that cannot reach its service starts saying
 * so.
 *
 * A line written before the bind is a plain console line: not JSON, not level
 * filtered, and past any pino redaction. That is the same trade the credential
 * projection above it already makes, and it is bounded — the bind is the first
 * statement after the Fastify instance exists. It holds only while nothing
 * routed through here logs a secret. The one component wired to it today does
 * not: the Uplink client logs protocol version, installation id, close code,
 * close reason and refusal reason, and never the subscription key.
 */

/** The levels are the ones `UplinkControlClientOptions['log']` declares. A
 * component reaching for `debug` or `fatal` fails to compile against this
 * rather than losing those lines quietly, which is the right direction for the
 * failure to point. */
export type LogSink = Pick<Console, 'info' | 'warn' | 'error'>;

export interface DeferredLogger extends LogSink {
  /** Point every later call at `target`. Last call wins. */
  bind(target: LogSink): void;
}

export function createDeferredLogger(fallback: LogSink = console): DeferredLogger {
  let target: LogSink | undefined;
  // Resolved per call, not captured: the whole point is that the component
  // holds this object from before the real logger exists, so the indirection
  // has to survive every call it makes through it.
  const forward =
    (level: keyof LogSink) =>
    (...args: unknown[]): void => {
      const sink = target ?? fallback;
      sink[level](...args);
    };
  return {
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    bind(next: LogSink): void {
      target = next;
    },
  };
}
