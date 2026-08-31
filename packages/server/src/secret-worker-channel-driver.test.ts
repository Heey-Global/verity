import { PassThrough, Duplex } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type {
  RunGrantClaims,
  RunGrantRedemption,
  SecretJobFrame,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { createSecretEnvelopeSealer, generateRecipientKeyPair } from './secret-envelope-crypto.js';
import type { RawJobChunk, SecretJobFrameSink } from './secret-job-executor.js';
import { createSecretWorkerChannelAuthenticator } from './secret-worker-channel-auth.js';
import {
  driveSecretWorkerChannel,
  SecretWorkerChannelDriverError,
} from './secret-worker-channel-driver.js';
import {
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
  type SecretWorkerWireMessage,
} from './secret-worker-protocol-codec.js';
import { createSecretWorkerRuntime } from './secret-worker-runtime.js';

const JOB_ID = 'job-1';
const CONTAINER_ID = 'a'.repeat(64);
const EXECUTOR_INSTANCE_ID = 'exec-1';
const SECRET_VALUE = 'fake-secret-value-abcdef';
const DEADLINE = '2026-07-19T00:10:00Z';
const now = () => new Date('2026-07-19T00:01:00Z');

const REDACTOR_PROFILE: StreamingRedactorProfile = {
  id: 'redactor-1',
  version: 1,
  implementationDigest: 'd'.repeat(64),
  algorithm: 'byte-longest-first-v1',
  minimumSecretBytes: 4,
  maximumSecretBytes: 4096,
  maximumActiveSecrets: 64,
  maximumInputChunkBytes: 65_536,
  maximumScanComparisons: 8_388_608,
  maximumOutputBytes: 1_048_576,
  replacement: '[REDACTED]',
};

function claims(): RunGrantClaims {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: 'a'.repeat(64),
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-19T00:00:00Z',
    expiresAt: '2026-07-19T00:05:00Z',
    nonce: 'n'.repeat(32),
  };
}

function echoSecretJob(): (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }> {
  return (secrets) => {
    const token = Buffer.from(secrets.get('API_TOKEN') ?? new Uint8Array());
    return Promise.resolve({
      chunks: [{ stream: 'stdout' as const, chunk: Buffer.concat([Buffer.from('token='), token]) }],
      exitCode: 0,
    });
  };
}

/** Wrap a payload in Docker's 8-byte stdout attach frame header (stream id 1). */
function dockerStdoutFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = 1;
  frame.writeUInt32BE(payload.length, 4);
  Buffer.from(payload).copy(frame, 8);
  return frame;
}

function collectingSink(): SecretJobFrameSink & { frames: SecretJobFrame[] } {
  const frames: SecretJobFrame[] = [];
  return { frames, persist: (frame) => void frames.push(frame) };
}

function decodeFrames(frames: SecretJobFrame[]): string {
  return frames
    .map((f) =>
      f.encoding === 'base64' ? Buffer.from(f.payload, 'base64').toString('utf8') : f.payload,
    )
    .join('');
}

/** Build the injected sealer: seal to the worker's own recipient key so the open succeeds. */
function sealerFor(recipientPublicKey: Uint8Array) {
  const seal = createSecretEnvelopeSealer({
    resolveRecipientPublicKey: () => Promise.resolve(recipientPublicKey),
  });
  const secrets = new Map<string, Uint8Array>([['API_TOKEN', Buffer.from(SECRET_VALUE)]]);
  return (redemption: RunGrantRedemption) => seal(claims(), redemption, secrets);
}

/** An in-memory attach bridge: the driver's writes (stdin) reach the worker as raw messages; the
 * worker's replies are Docker-stdout-framed back to the driver's read side. */
function bridge() {
  const toWorker = new PassThrough(); // driver → worker stdin (raw, not multiplexed)
  const fromWorker = new PassThrough(); // worker → driver stdout (Docker-multiplexed)
  // A hand-built duplex — reads pull from fromWorker, writes push to toWorker — so a driver-initiated
  // destroy() does not abort the two independent test streams (which Duplex.from's internal pump does,
  // surfacing an unhandled AbortError). This mirrors a real attach socket: one duplex, two directions.
  const driverStream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb: () => void) {
      toWorker.write(chunk);
      cb();
    },
    destroy(err, cb) {
      // Destroying the attach socket closes the container's stdin; mirror that so a worker blocked on
      // its next stdin message sees EOF instead of hanging when the driver fails/finishes early.
      toWorker.end();
      cb(err);
    },
  });
  fromWorker.on('data', (chunk: Buffer) => {
    if (!driverStream.destroyed) driverStream.push(chunk);
  });
  fromWorker.on('end', () => {
    if (!driverStream.destroyed) driverStream.push(null);
  });
  return { toWorker, fromWorker, driverStream };
}

/** Pump one worker runtime against the bridge, optionally corrupting the proof to force auth failure. */
async function pumpWorker(
  worker: ReturnType<typeof createSecretWorkerRuntime>,
  toWorker: PassThrough,
  fromWorker: PassThrough,
  opts: { tamperProof?: boolean } = {},
): Promise<void> {
  try {
    for await (const serverMessage of decodeSecretWorkerMessages(toWorker)) {
      const replies = await worker.accept(serverMessage);
      for (const reply of replies) {
        const out: SecretWorkerWireMessage =
          opts.tamperProof && reply.type === 'proof'
            ? {
                ...reply,
                payload: { ...(reply.payload as object), executorInstanceId: 'exec-tampered' },
              }
            : reply;
        fromWorker.write(dockerStdoutFrame(encodeSecretWorkerMessage(out)));
      }
      if (worker.state() === 'closed') break;
    }
  } catch {
    // The driver may destroy the bridge on a failure path; ending the read side is enough.
  } finally {
    fromWorker.end();
  }
}

function newWorker(runJob = echoSecretJob()) {
  return createSecretWorkerRuntime({
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    executorInstanceId: EXECUTOR_INSTANCE_ID,
    claims: claims(),
    redactorProfile: REDACTOR_PROFILE,
    runJob,
    seams: { now },
  });
}

describe('secret worker channel driver', () => {
  it('authenticates the worker and drives a full redacted end-to-end session', async () => {
    const worker = newWorker();
    const { toWorker, fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    const workerDone = pumpWorker(worker, toWorker, fromWorker);
    const outcome = await driveSecretWorkerChannel({
      stream: driverStream,
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      absoluteDeadline: DEADLINE,
      claims: claims(),
      redactorProfile: REDACTOR_PROFILE,
      sealEnvelope: sealerFor(worker.recipientPublicKey()),
      frames: sink,
      authenticator,
    });
    await workerDone;

    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(outcome.result.outcome).toBe('succeeded');
    expect(sink.frames.length).toBeGreaterThan(0);
    const decoded = decodeFrames(sink.frames);
    expect(decoded).toContain('[REDACTED]');
    expect(decoded).not.toContain(SECRET_VALUE);
    // The challenge was consumed by a successful authentication.
    expect(authenticator.pendingCount()).toBe(0);
  });

  it('fails closed and seals nothing when the proof does not authenticate', async () => {
    const worker = newWorker();
    const { toWorker, fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });
    let sealed = false;

    const workerDone = pumpWorker(worker, toWorker, fromWorker, { tamperProof: true });
    await expect(
      driveSecretWorkerChannel({
        stream: driverStream,
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        redactorProfile: REDACTOR_PROFILE,
        sealEnvelope: (redemption) => {
          sealed = true;
          return sealerFor(worker.recipientPublicKey())(redemption);
        },
        frames: sink,
        authenticator,
      }),
    ).rejects.toThrow(/authentication failed/);
    await workerDone;

    expect(sealed).toBe(false); // no envelope is ever sealed for an unauthenticated worker
    expect(sink.frames).toHaveLength(0);
    expect(authenticator.pendingCount()).toBe(0); // challenge consumed (not left dangling)
  });

  it('fails closed when the worker stream ends before a terminal message', async () => {
    const { fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    // Worker never replies: end its stdout immediately so the driver sees EOF.
    fromWorker.end();

    await expect(
      driveSecretWorkerChannel({
        stream: driverStream,
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        redactorProfile: REDACTOR_PROFILE,
        sealEnvelope: sealerFor(generateRecipientKeyPair().publicKey),
        frames: sink,
        authenticator,
      }),
    ).rejects.toThrow(/closed before a terminal message/);
    expect(authenticator.pendingCount()).toBe(0); // unconsumed challenge revoked
  });

  it('aborts fail-closed and revokes the challenge when the signal is already aborted', async () => {
    const { driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    await expect(
      driveSecretWorkerChannel({
        stream: driverStream,
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        redactorProfile: REDACTOR_PROFILE,
        sealEnvelope: sealerFor(generateRecipientKeyPair().publicKey),
        frames: sink,
        authenticator,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(SecretWorkerChannelDriverError);
    expect(authenticator.pendingCount()).toBe(0);
    expect(driverStream.destroyed).toBe(true);
  });

  it('surfaces a worker terminal error as a fail outcome', async () => {
    const worker = newWorker(() => Promise.reject(new Error('boom')));
    const { toWorker, fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    const workerDone = pumpWorker(worker, toWorker, fromWorker);
    const outcome = await driveSecretWorkerChannel({
      stream: driverStream,
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      absoluteDeadline: DEADLINE,
      claims: claims(),
      redactorProfile: REDACTOR_PROFILE,
      sealEnvelope: sealerFor(worker.recipientPublicKey()),
      frames: sink,
      authenticator,
    });
    await workerDone;

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.error.code).toBe('internal');
    expect(sink.frames).toHaveLength(0);
  });

  it('rejects a protocol violation: an out-of-order terminal before the proof', async () => {
    const { fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    // A structurally valid `result` sent in place of the expected `proof`: the state machine rejects
    // it and the driver normalizes the violation.
    const rogueResult: SecretWorkerWireMessage = {
      protocolVersion: 1,
      type: 'result',
      payload: {
        protocolVersion: 1,
        jobId: JOB_ID,
        outcome: 'succeeded',
        finishedAt: '2026-07-19T00:02:00.000Z',
      },
    };
    fromWorker.write(dockerStdoutFrame(encodeSecretWorkerMessage(rogueResult)));
    fromWorker.end();

    await expect(
      driveSecretWorkerChannel({
        stream: driverStream,
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        redactorProfile: REDACTOR_PROFILE,
        sealEnvelope: sealerFor(generateRecipientKeyPair().publicKey),
        frames: sink,
        authenticator,
      }),
    ).rejects.toThrow(/protocol violation/);
    expect(authenticator.pendingCount()).toBe(0);
  });

  it('rejects a malformed Docker attach frame as a protocol violation', async () => {
    const { fromWorker, driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });

    // Invalid Docker multiplex stream id (only 1/2 are legal) → the codec rejects fail-closed.
    fromWorker.write(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]));
    fromWorker.end();

    await expect(
      driveSecretWorkerChannel({
        stream: driverStream,
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        redactorProfile: REDACTOR_PROFILE,
        sealEnvelope: sealerFor(generateRecipientKeyPair().publicKey),
        frames: sink,
        authenticator,
      }),
    ).rejects.toThrow(/protocol violation/);
  });

  it('aborts fail-closed mid-session when the signal fires after start', async () => {
    const { driverStream } = bridge();
    const sink = collectingSink();
    const authenticator = createSecretWorkerChannelAuthenticator({ now });
    const controller = new AbortController();

    // No worker replies: the driver has issued the challenge and is blocked reading stdout. Abort
    // after it is under way so the mid-read destroy path (not the pre-aborted branch) is exercised.
    const pending = driveSecretWorkerChannel({
      stream: driverStream,
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      absoluteDeadline: DEADLINE,
      claims: claims(),
      redactorProfile: REDACTOR_PROFILE,
      sealEnvelope: sealerFor(generateRecipientKeyPair().publicKey),
      frames: sink,
      authenticator,
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(authenticator.pendingCount()).toBe(0);
    expect(driverStream.destroyed).toBe(true);
  });
});
