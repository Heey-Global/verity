/**
 * A logger for components the embedded boot constructs before the Fastify
 * instance exists.
 *
 * `app.log` is the only real logger and `app` is built a thousand lines after
 * the first long-lived clients are wired. Capturing it in a closure up there is
 * the TDZ `ReferenceError` that once crash-looped every sealed boot; passing no
 * logger is worse than it sounds, since a component reading `options.log?.…`
 * does not get a quieter boot but a permanently silent one. Hand the component
 * this instead, and bind it once `app.log` exists.
 */

/** The levels are the ones `UplinkControlClientOptions['log']` declares. A
 * component reaching for `debug` or `fatal` fails to compile against this
 * rather than losing those lines quietly. */
export type LogSink = Pick<Console, 'info' | 'warn' | 'error'>;

export interface DeferredLogger extends LogSink {
  /** Point every later call at `target`. Last call wins. */
  bind(target: LogSink): void;
}

/** stderr at every level, rather than `console` itself: `console.info` writes
 * to stdout, and stdout is where pino's JSON lines go. A plain line interleaved
 * into that stream is a parse error for whatever reads it, while stderr is
 * where text nobody parses belongs. A pre-bind line is unstructured, unfiltered
 * and past any redaction wherever it lands, which is why the bind is the first
 * statement after `app` and the dial is the second. */
const STDERR: LogSink = {
  info: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.error(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export function createDeferredLogger(fallback: LogSink = STDERR): DeferredLogger {
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
