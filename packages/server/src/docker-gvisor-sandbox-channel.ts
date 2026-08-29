import type { Duplex } from 'node:stream';

import {
  secretJobTerminalResultSchema,
  type ExecutorWorkloadIdentity,
  type RunGrantClaims,
  type RunGrantRedemption,
  type SecretEnvelope,
  type SecretJobFrame,
  type SecretJobTerminalResult,
  type StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { openDockerUnixAttach } from './docker.js';
import { createSecretWorkerChannelAuthenticator } from './secret-worker-channel-auth.js';
import type { SecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
import {
  driveSecretWorkerChannel,
  type SecretWorkerChannelOutcome,
} from './secret-worker-channel-driver.js';

/**
 * The real Executor-side lifecycle channel for the Brokered Secrets gVisor sandbox (ADR 0009). It is
 * the adapter that turns a started worker container into the {@link LaunchedSandbox}-shaped
 * `{ workload, frames, result }` the launcher/executor consume, by opening the Docker attach duplex
 * and driving the full authenticated protocol through {@link driveSecretWorkerChannel}.
 *
 * The driver is authoritative for the security invariant (authenticate the worker's proof BEFORE
 * sealing the envelope); this module only adapts I/O shapes:
 *   - it opens the networkless Unix-socket attach (no HTTP proxy surface),
 *   - it bridges the driver's PUSH frame sink into a PULL {@link AsyncIterable} the executor streams,
 *   - it surfaces the authenticated {@link ExecutorWorkloadIdentity} (captured when the driver seals),
 *   - it maps a worker terminal `error` to a `failed` result and propagates a driver rejection.
 *
 * It handles no secret material: `sealEnvelope` (the broker redeem+seal) is injected, the envelope is
 * opaque, and every frame the driver yields is already redacted.
 */

/** Per-job inputs the launcher hands the channel. `claims`/`sealEnvelope` carry no secret bytes:
 * claims are ids/hashes, and `sealEnvelope` is a broker handle that resolves the sealed envelope. */
export interface GvisorSandboxChannelRunInput {
  jobId: string;
  containerId: string;
  absoluteDeadline: string;
  claims: RunGrantClaims;
  sealEnvelope: (redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
  /** Aborts the session fail-closed (deadline reached / job cancelled). */
  signal?: AbortSignal;
}

/** What the channel yields once the worker has authenticated; frames/result keep streaming after. */
export interface GvisorSandboxChannelRun {
  workload: ExecutorWorkloadIdentity;
  frames: AsyncIterable<SecretJobFrame>;
  result: Promise<SecretJobTerminalResult>;
}

export interface GvisorSandboxChannel {
  run(input: GvisorSandboxChannelRunInput): Promise<GvisorSandboxChannelRun>;
}

/** A hijacked attach duplex plus its closer. Matches {@link openDockerUnixAttach}'s return. */
export interface AttachedDuplex {
  stream: Duplex;
  close(): void;
}

export interface DockerGvisorSandboxChannelOptions {
  /** Docker unix-socket base URL; the attach refuses HTTP proxy URLs (keeps the worker networkless). */
  dockerBaseUrl: string;
  /** Frozen redaction policy transported only in the authenticated attach handshake. */
  redactorProfile: StreamingRedactorProfile;
  /** Mandatory proof→sealer key handoff; the default authenticator always registers into it. */
  recipientKeys: SecretWorkerRecipientKeyRegistry;
  /** Injectable attach opener (defaults to {@link openDockerUnixAttach}); tests supply an in-memory
   * duplex bridged to a worker runtime. */
  openAttach?: (input: { containerId: string; signal?: AbortSignal }) => Promise<AttachedDuplex>;
  /** The channel authenticator forwarded to the driver (issues the challenge, verifies the proof).
   * Omit for a fresh per-session default; injected in tests to fix the clock. */
  authenticator?: ReturnType<typeof createSecretWorkerChannelAuthenticator>;
  /** Secret-free terminal observer for integration diagnostics. Payloads and error messages are
   * deliberately excluded; callers can distinguish a validated worker result from a protocol/job
   * fault without gaining access to secret-bearing context. */
  onTerminalOutcome?: (outcome: {
    kind: SecretWorkerChannelOutcome['kind'];
    errorCode?: Extract<SecretWorkerChannelOutcome, { kind: 'error' }>['error']['code'];
  }) => void | Promise<void>;
  now?: () => Date;
}

/** A push→pull bridge: the driver pushes redacted frames, the executor pulls them as an async
 * iterable. There is no backpressure — the driver's `persist` is synchronous and secret-job frames
 * are individually capped and short-lived — so a slow consumer just buffers. Completion (or a driver
 * failure) is signalled to a pending consumer. */
class FrameQueue {
  #items: SecretJobFrame[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<SecretJobFrame>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #done = false;
  #error: Error | undefined;

  push(frame: SecretJobFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: frame, done: false });
    else this.#items.push(frame);
  }

  end(): void {
    this.#settle();
  }

  fail(error: unknown): void {
    if (this.#error === undefined) {
      this.#error = error instanceof Error ? error : new Error('worker frame stream failed');
    }
    this.#settle();
  }

  #settle(): void {
    this.#done = true;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      if (this.#error !== undefined) waiter.reject(this.#error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncGenerator<SecretJobFrame> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#done) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      const next = await new Promise<IteratorResult<SecretJobFrame>>((resolve, reject) => {
        this.#waiters.push({ resolve, reject });
      });
      if (next.done) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      yield next.value;
    }
  }
}

function outcomeToResult(
  outcome: SecretWorkerChannelOutcome,
  jobId: string,
  now: () => Date,
): SecretJobTerminalResult {
  if (outcome.kind === 'result') return outcome.result;
  // A worker terminal `error` is a failed run; the executor records it and reaps. The result schema
  // has no reason field, so the only cause we can carry is the terminal outcome enum — surface a
  // `deadline_exceeded` distinctly, otherwise `failed`. The error `message` is deliberately dropped
  // (it could echo job context; the code enum is the safe signal).
  return secretJobTerminalResultSchema.parse({
    protocolVersion: 1,
    jobId,
    outcome: outcome.error.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'failed',
    finishedAt: now().toISOString(),
  });
}

export function createDockerGvisorSandboxChannel(
  options: DockerGvisorSandboxChannelOptions,
): GvisorSandboxChannel {
  const now = options.now ?? (() => new Date());
  const authenticator =
    options.authenticator ??
    createSecretWorkerChannelAuthenticator({
      now,
      onAuthenticatedRecipient: (recipient) => options.recipientKeys.register(recipient),
    });
  const openAttach =
    options.openAttach ??
    ((input) =>
      openDockerUnixAttach({
        baseUrl: options.dockerBaseUrl,
        containerId: input.containerId,
        ...(input.signal ? { signal: input.signal } : {}),
      }));

  return {
    async run(input: GvisorSandboxChannelRunInput): Promise<GvisorSandboxChannelRun> {
      const attach = await openAttach({
        containerId: input.containerId,
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const queue = new FrameQueue();
      let workload: ExecutorWorkloadIdentity | undefined;
      let resolveAuthenticated!: (identity: ExecutorWorkloadIdentity) => void;
      const authenticated = new Promise<ExecutorWorkloadIdentity>((resolve) => {
        resolveAuthenticated = resolve;
      });

      // The driver builds the redemption and calls sealEnvelope with it right after it authenticates
      // the proof — so this wrapper is exactly where the authenticated workload becomes known.
      const sealEnvelope = (redemption: RunGrantRedemption): Promise<SecretEnvelope> => {
        workload = redemption.workload;
        resolveAuthenticated(redemption.workload);
        return input.sealEnvelope(redemption);
      };

      const result = driveSecretWorkerChannel({
        stream: attach.stream,
        jobId: input.jobId,
        containerId: input.containerId,
        absoluteDeadline: input.absoluteDeadline,
        claims: input.claims,
        redactorProfile: options.redactorProfile,
        sealEnvelope,
        frames: { persist: (frame) => queue.push(frame) },
        authenticator,
        ...(input.signal ? { signal: input.signal } : {}),
      }).then(
        (outcome) => {
          queue.end();
          try {
            const observed = options.onTerminalOutcome?.({
              kind: outcome.kind,
              ...(outcome.kind === 'error' ? { errorCode: outcome.error.code } : {}),
            });
            void Promise.resolve(observed).catch(() => undefined);
          } catch {
            // Observability is never authoritative for sandbox execution. A broken diagnostic
            // callback must not turn a validated terminal outcome into a failed/hung job.
          }
          return outcomeToResult(outcome, input.jobId, now);
        },
        (error: unknown) => {
          queue.fail(error);
          throw error;
        },
      );
      // The driver destroys the stream on exit; also close the attach handle. Attach a handler so a
      // rejection during the pre-auth race is never an unhandled rejection.
      const settled = result.finally(() => attach.close());

      // Return only once the worker has authenticated (so `workload` is known). If the driver fails
      // before that — auth failure, EOF before proof, or an aborted deadline — surface the rejection.
      await Promise.race([authenticated, settled.then(() => undefined).catch(() => undefined)]);
      if (workload === undefined) {
        await settled; // throws the driver's fail-closed error
        throw new Error('worker channel ended before authentication');
      }

      return { workload, frames: queue.iterate(), result: settled };
    },
  };
}
