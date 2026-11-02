import { setTimeout as sleep } from 'node:timers/promises';
import { DockerError } from '../docker.js';
import { classifyUpdateError } from './update-attempt.js';

/**
 * Waits between the update preparation's pull attempts. Four attempts in all,
 * about four minutes of waiting at most.
 *
 * A failed preparation pull is terminal for the operation (the journal moves to
 * `failed` and the device has to ask again), and the runner's own quick retries
 * deliberately skip preparing phases. So the retry that keeps a flaky link from
 * costing the operator a click has to live around the pull itself. Each attempt
 * is bounded by the Docker client's idle window and overall ceiling, and the
 * waits grow so a registry or link that is down for a few minutes is waited out
 * rather than hammered.
 */
export const UPDATE_PULL_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 180_000];

/**
 * In-stream failures the daemon reports with no typed kind, but which are the
 * registry connection failing rather than the image being wrong: an HTTP 5xx
 * from the registry or a body cut off mid-blob. The classic store words a 5xx as
 * `received unexpected HTTP status: 503 …`, the containerd store as
 * `unexpected status from GET request to <url>: 503 Service Unavailable` (or
 * HEAD).
 */
const TRANSIENT_STREAM_FAILURE =
  /received unexpected HTTP status: 5\d\d|unexpected status from (?:GET|HEAD) request to \S+: 5\d\d|unexpected EOF/i;

/**
 * Whether another attempt can reasonably succeed.
 *
 * Retried: a stall (`pull_stalled`) and a transport failure — the typed
 * `network` kind, or a daemon-reported message the attempt classifier already
 * reads as a network failure or network timeout.
 *
 * Not retried: the overall ceiling (`timeout`). A pull that was still moving
 * after hours would spend the same hours again. A missing or denied image, a
 * full disk, and every other daemon error are not transient either.
 */
export function isRetryablePullError(error: unknown): boolean {
  if (!(error instanceof DockerError)) return false;
  switch (error.kind) {
    case 'pull_stalled':
    case 'network':
      return true;
    case 'timeout':
    case 'image_not_found':
    case 'container_not_found':
    case 'conflict':
      return false;
    case 'other': {
      if (TRANSIENT_STREAM_FAILURE.test(error.message)) return true;
      const cause = classifyUpdateError(error);
      return cause === 'network' || cause === 'network-timeout';
    }
  }
}

export interface PullRetryOptions {
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly log?: (message: string) => void;
}

/**
 * Run `pull` until it succeeds, a failure is not retryable, or the delays run
 * out; the last failure is rethrown unchanged so the attempt record classifies
 * what actually happened.
 *
 * Whether a retry re-downloads what the failed attempt already fetched depends
 * on the daemon's image store; see the note in `docker-update-preparation.ts`.
 */
export async function pullWithRetry(
  imageRef: string,
  pull: () => Promise<void>,
  options: PullRetryOptions = {},
): Promise<void> {
  const delays = options.delaysMs ?? UPDATE_PULL_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pull();
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryablePullError(error)) throw error;
      options.log?.(
        `pull of ${imageRef} failed (attempt ${String(attempt + 1)} of ${String(delays.length + 1)}): ${
          error instanceof Error ? error.message : String(error)
        }; retrying in ${String(Math.round(delay / 1000))}s`,
      );
      await (options.sleep ?? sleep)(delay);
    }
  }
}
