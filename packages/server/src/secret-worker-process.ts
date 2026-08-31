import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import {
  runGrantClaimsSchema,
  secretContractIdSchema,
  streamingRedactorProfileSchema,
} from '@verity/secret-contracts';
import { z } from 'zod';

import type { RawJobChunk } from './secret-job-executor.js';
import {
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
} from './secret-worker-protocol-codec.js';
import {
  createSecretWorkerRuntime,
  type SecretWorkerRuntime,
  type SecretWorkerRuntimeSeams,
} from './secret-worker-runtime.js';
import { secretWorkerChallengePayloadSchema } from './secret-worker-channel-state.js';

/**
 * The in-sandbox worker PROCESS glue for the Brokered Secrets one-job executor (ADR 0009). The
 * {@link createSecretWorkerRuntime} brain is transport-agnostic; this module is the thin, testable
 * layer that (a) validates the non-secret launch config the container receives and (b) pumps the
 * length-prefixed protocol between the process's stdin/stdout and that runtime.
 *
 * Transport, from inside the container:
 *   - stdin carries RAW length-prefixed server→worker messages (challenge, bootstrap). Docker does
 *     not multiplex stdin, so it is decoded directly with {@link decodeSecretWorkerMessages}.
 *   - stdout carries the worker→server replies (proof, frame*, result|error), each a raw
 *     length-prefixed message. Docker's attach multiplexer wraps them into stdout frames on the wire;
 *     the server side demultiplexes. The worker itself only ever writes plain encoded messages.
 *
 * The process holds the private keys and opens the envelope, but only redacted frames and a terminal
 * message are ever written to stdout — that guarantee lives in the runtime, not here. This layer adds
 * no secret handling; it is pure plumbing plus a fail-closed launch-config gate.
 */

/** Canonical 64-hex Docker container id, matching the challenge/state-machine binding. */
const dockerContainerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The non-secret launch context the server injects into the container (env/argv, never a mount).
 * Claims are metadata — they carry no secret material — so passing them into a networkless, mountless
 * sandbox does not widen the trust boundary; the secrets themselves only ever arrive sealed, over the
 * authenticated bootstrap envelope. Parsed strictly so a malformed launch aborts before any I/O.
 */
export const secretWorkerLaunchConfigSchema = z
  .object({
    jobId: secretContractIdSchema,
    containerId: dockerContainerIdSchema,
    executorInstanceId: secretContractIdSchema,
    claims: runGrantClaimsSchema,
    redactorProfile: streamingRedactorProfileSchema,
  })
  .strict();
export type SecretWorkerLaunchConfig = z.infer<typeof secretWorkerLaunchConfigSchema>;

/** The secret-bearing job body: receives the opened secret map, returns its raw output + exit code. */
export type SecretWorkerJobRunner = (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }>;

/**
 * Validate the launch config (fail-closed on anything malformed) and construct the worker runtime
 * bound to it. The `runJob` and optional deterministic seams are injected by the caller — the bin
 * entrypoint supplies a real subprocess-exec runJob; tests supply a fake.
 */
export function buildSecretWorkerRuntime(
  config: unknown,
  runJob: SecretWorkerJobRunner,
  seams?: SecretWorkerRuntimeSeams,
): SecretWorkerRuntime {
  const parsed = secretWorkerLaunchConfigSchema.parse(config);
  return createSecretWorkerRuntime({
    jobId: parsed.jobId,
    containerId: parsed.containerId,
    executorInstanceId: parsed.executorInstanceId,
    claims: parsed.claims,
    redactorProfile: parsed.redactorProfile,
    runJob,
    ...(seams ? { seams } : {}),
  });
}

/** Write one encoded message, resolving only once it has flushed (respecting stream backpressure). */
function writeMessage(output: Writable, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Pump the framed protocol between `input` (stdin) and `output` (stdout) through the worker runtime
 * until the runtime reaches its terminal state or the input ends. Each decoded server message is fed
 * to the runtime and every reply it produces is written back in order. Resolves when the session is
 * complete; rejects fail-closed if the runtime rejects a message (a protocol violation), a decode
 * fails, a write fails, or either stream emits an asynchronous `'error'` (e.g. the server tears down
 * the attach socket → EPIPE on stdout). The stream `'error'` listeners are the reason this is not a
 * bare `for await`: a late EPIPE with no listener would crash the process instead of rejecting.
 * Does not close `output` — the caller (the bin entrypoint / test) owns stream lifecycle.
 */
export function runSecretWorkerProcess(options: {
  input: Readable;
  output: Writable;
  runtime: SecretWorkerRuntime;
}): Promise<void> {
  const { input, output, runtime } = options;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const succeed = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    // A stdout EPIPE (server closed the read side) arrives as an async 'error' event, not through a
    // write callback; without a listener it crashes the process. Route both streams' errors to a
    // clean fail-closed rejection.
    input.on('error', fail);
    output.on('error', fail);

    void (async () => {
      for await (const serverMessage of decodeSecretWorkerMessages(input)) {
        const replies = await runtime.accept(serverMessage);
        for (const reply of replies) {
          await writeMessage(output, encodeSecretWorkerMessage(reply));
        }
        if (runtime.state() === 'closed') break;
      }
    })()
      .then(succeed, fail)
      .finally(() => {
        input.removeListener('error', fail);
        output.removeListener('error', fail);
      });
  });
}

/**
 * Production process bootstrap: initialize the runtime from the first, strictly validated challenge
 * instead of Docker env/argv. Claims and the redactor policy therefore travel only over the attach
 * channel and are cryptographically covered by the worker's proof transcript. The executor instance
 * id is minted inside the sandbox and never supplied by the server.
 */
export function runBootstrappedSecretWorkerProcess(options: {
  input: Readable;
  output: Writable;
  runJob: SecretWorkerJobRunner;
  executorInstanceId?: () => string;
  seams?: SecretWorkerRuntimeSeams;
}): Promise<void> {
  const { input, output } = options;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    input.on('error', fail);
    output.on('error', fail);

    void (async () => {
      let runtime: SecretWorkerRuntime | undefined;
      for await (const message of decodeSecretWorkerMessages(input)) {
        if (runtime === undefined) {
          if (message.type !== 'challenge') {
            throw new Error('worker initialization requires challenge as the first message');
          }
          const challenge = secretWorkerChallengePayloadSchema.parse(message.payload);
          runtime = buildSecretWorkerRuntime(
            {
              jobId: challenge.jobId,
              containerId: challenge.containerId,
              executorInstanceId: options.executorInstanceId?.() ?? `worker-${randomUUID()}`,
              claims: challenge.claims,
              redactorProfile: challenge.redactorProfile,
            },
            options.runJob,
            options.seams,
          );
        }
        const replies = await runtime.accept(message);
        for (const reply of replies) {
          await writeMessage(output, encodeSecretWorkerMessage(reply));
        }
        if (runtime.state() === 'closed') break;
      }
      if (runtime === undefined || runtime.state() !== 'closed') {
        throw new Error('worker input closed before a terminal message');
      }
    })()
      .then(succeed, fail)
      .finally(() => {
        input.removeListener('error', fail);
        output.removeListener('error', fail);
      });
  });
}
