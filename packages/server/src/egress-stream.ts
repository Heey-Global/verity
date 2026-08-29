import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

/**
 * Longest silence tolerated BETWEEN two upstream chunks of a response that has
 * already started. Not a ceiling on the response as a whole: a model stream that
 * keeps producing runs as long as it likes, and a single deliberate gap — a long
 * tool turn upstream, a slow first token after a retry — stays well inside this.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** Largest delay Node preserves instead of coercing to a 1 ms timeout. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * An upstream that goes quiet mid-stream is invisible to both ends: the gateway
 * holds a response that will never continue, the sandbox holds the request that
 * is waiting for it, and neither side has anything to time out on, because the
 * connection is healthy and the last chunk arrived normally. Every layer above
 * then reads "still working" — including the in-flight liveness sweep, which
 * finds a Runner that is alive and simply has nothing left to say.
 *
 * Destroying the body turns that silence into an ordinary transport failure,
 * which is a shape the agent, the gateway telemetry, and the operator all
 * already understand.
 *
 * Deliberately NOT named `AbortError`: a gateway-initiated teardown is not a
 * client cancellation, and anything that classifies by `error.name` — retry
 * policy, alert suppression — must not read this as one. The gateways label it
 * by type instead.
 */
export class EgressStreamIdleError extends Error {
  constructor() {
    super('upstream stream went idle');
    this.name = 'EgressStreamIdleError';
  }
}

/** Whether a configured deadline can be armed at all. Non-finite is the shape a
 *  value parsed from configuration takes when it is malformed, and `setTimeout`
 *  treats `NaN` as "fire immediately" — which would abort EVERY stream. Such a
 *  value therefore reads as no supervision, exactly as 0 does, rather than as the
 *  most aggressive possible setting. */
export function isArmableStreamIdleTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS;
}

/**
 * Stream an upstream response body to the sandbox, under supervision.
 *
 * The deadline covers only the wait FOR upstream: it is cleared while a chunk is
 * being written downstream and re-armed once that write has flushed, so neither a
 * slow consumer nor backpressure is mistaken for a dead producer. A stream that
 * keeps arriving, however slowly, is therefore never touched.
 *
 * Two neighbouring stalls are deliberately NOT covered here, because both are
 * bounded elsewhere rather than unnoticed: an upstream that never returns
 * response headers at all (this function is reached only after `writeHead`, and
 * the request carries the caller's abort signal), and a sandbox that stops
 * reading, which parks the downstream write — the response `close` handler in
 * each gateway aborts the upstream request when that peer goes away. What is
 * fixed here is the one stall with no observer anywhere: a healthy connection
 * whose producer simply stopped.
 *
 * A non-positive or non-finite `idleTimeoutMs` disables the supervision, which is
 * the behaviour that predates it.
 */
export async function forwardBody(
  body: Readable,
  response: ServerResponse,
  forwarded: (bytes: number) => void,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<void> {
  let idle: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (idle === undefined) return;
    clearTimeout(idle);
    idle = undefined;
  };
  const arm = (): void => {
    disarm();
    if (!isArmableStreamIdleTimeout(idleTimeoutMs)) return;
    idle = setTimeout(() => {
      // A throw here would be an uncaught exception on the timer tick — one
      // request's stall must never be able to take the Server down with it.
      try {
        body.destroy(new EgressStreamIdleError());
      } catch {
        // Nothing left to do: the stream is unusable either way, and the request
        // fails through its own error path.
      }
    }, idleTimeoutMs);
    // A pending deadline must never be the reason the Server stays alive.
    idle.unref?.();
  };
  try {
    arm();
    for await (const chunk of body as AsyncIterable<string | Buffer>) {
      disarm();
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      await new Promise<void>((resolve, reject) => {
        response.write(chunk, (error) =>
          error === null || error === undefined ? resolve() : reject(error),
        );
      });
      forwarded(bytes);
      arm();
    }
  } catch (error) {
    // This function owns the body's lifetime, so a failure on the DOWNSTREAM side
    // must not leave the upstream stream both unconsumed and unsupervised, holding
    // its socket until the provider's own timeout.
    body.destroy();
    throw error;
  } finally {
    disarm();
  }
  response.end();
}
