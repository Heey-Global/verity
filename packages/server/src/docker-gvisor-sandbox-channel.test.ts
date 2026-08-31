import { Duplex, PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { RunGrantRedemption, StreamingRedactorProfile } from '@verity/secret-contracts';

import {
  createDockerGvisorSandboxChannel,
  type AttachedDuplex,
} from './docker-gvisor-sandbox-channel.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import type { RawJobChunk } from './secret-job-executor.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
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

function claims() {
  return {
    protocolVersion: 1 as const,
    grantId: 'grant-1',
    requestHash: 'a'.repeat(64),
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' as const }],
    audience: 'verity-secret-job-executor' as const,
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

type RunJob = (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }>;

function newWorker(runJob: RunJob = echoSecretJob()) {
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

function dockerStdoutFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = 1;
  frame.writeUInt32BE(payload.length, 4);
  Buffer.from(payload).copy(frame, 8);
  return frame;
}

/** In-memory attach: driver writes reach the worker as raw stdin; worker replies are Docker-framed. */
function bridge(): {
  attach: AttachedDuplex;
  toWorker: PassThrough;
  fromWorker: PassThrough;
  closed: () => boolean;
} {
  const toWorker = new PassThrough();
  const fromWorker = new PassThrough();
  let closeCount = 0;
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb: () => void) {
      toWorker.write(chunk);
      cb();
    },
    destroy(err, cb) {
      toWorker.end();
      cb(err);
    },
  });
  fromWorker.on('data', (chunk: Buffer) => {
    if (!stream.destroyed) stream.push(chunk);
  });
  fromWorker.on('end', () => {
    if (!stream.destroyed) stream.push(null);
  });
  return {
    attach: {
      stream,
      close: () => {
        closeCount += 1;
        stream.destroy();
      },
    },
    toWorker,
    fromWorker,
    closed: () => closeCount > 0,
  };
}

/** Complete the handshake normally (so auth succeeds), then inject a malformed Docker frame once the
 * bootstrap arrives — driving a driver rejection AFTER authentication. */
async function pumpThenCorruptAfterBootstrap(
  worker: ReturnType<typeof createSecretWorkerRuntime>,
  toWorker: PassThrough,
  fromWorker: PassThrough,
): Promise<void> {
  try {
    for await (const serverMessage of decodeSecretWorkerMessages(toWorker)) {
      if (serverMessage.type === 'bootstrap') {
        fromWorker.write(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0])); // invalid Docker stream id
        break;
      }
      const replies = await worker.accept(serverMessage);
      for (const reply of replies) {
        fromWorker.write(dockerStdoutFrame(encodeSecretWorkerMessage(reply)));
      }
    }
  } catch {
    // ignore
  } finally {
    fromWorker.end();
  }
}

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
    // Driver may destroy the bridge on a failure path; ending the read side is enough.
  } finally {
    fromWorker.end();
  }
}

/** The injected broker seal: seal the redemption to the worker's own recipient key. */
function sealEnvelopeFor(recipientPublicKey: Uint8Array) {
  const seal = createSecretEnvelopeSealer({
    resolveRecipientPublicKey: () => Promise.resolve(recipientPublicKey),
  });
  const secrets = new Map<string, Uint8Array>([['API_TOKEN', Buffer.from(SECRET_VALUE)]]);
  return (redemption: RunGrantRedemption) => seal(claims(), redemption, secrets);
}

function channelFor(
  attach: AttachedDuplex,
  onTerminalOutcome?: NonNullable<
    Parameters<typeof createDockerGvisorSandboxChannel>[0]['onTerminalOutcome']
  >,
) {
  return createDockerGvisorSandboxChannel({
    dockerBaseUrl: 'unix:///var/run/docker.sock',
    redactorProfile: REDACTOR_PROFILE,
    recipientKeys: createSecretWorkerRecipientKeyRegistry({ now }),
    openAttach: () => Promise.resolve(attach),
    authenticatorOptions: { now },
    ...(onTerminalOutcome ? { onTerminalOutcome } : {}),
    now,
  });
}

function runInput(recipientPublicKey: Uint8Array, signal?: AbortSignal) {
  return {
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    absoluteDeadline: DEADLINE,
    claims: claims(),
    sealEnvelope: sealEnvelopeFor(recipientPublicKey),
    ...(signal ? { signal } : {}),
  };
}

describe('docker gvisor sandbox channel', () => {
  it('drives the authenticated session and exposes workload, redacted frames, and result', async () => {
    const worker = newWorker();
    const { attach, toWorker, fromWorker, closed } = bridge();
    const workerDone = pumpWorker(worker, toWorker, fromWorker);

    const run = await channelFor(attach).run(runInput(worker.recipientPublicKey()));

    // Workload is surfaced synchronously (captured at seal time, after authentication).
    expect(run.workload.jobId).toBe(JOB_ID);
    expect(run.workload.publicKeyId).toMatch(/^worker-key-[a-f0-9]{24}$/);

    const frames = [];
    for await (const frame of run.frames) frames.push(frame);
    const result = await run.result;
    await workerDone;

    expect(frames.length).toBeGreaterThan(0);
    expect(result.outcome).toBe('succeeded');
    const decoded = frames
      .map((f) =>
        f.encoding === 'base64' ? Buffer.from(f.payload, 'base64').toString('utf8') : f.payload,
      )
      .join('');
    expect(decoded).toContain('[REDACTED]');
    expect(decoded).not.toContain(SECRET_VALUE);
    expect(closed()).toBe(true); // attach is always closed once the session settles
  });

  it('surfaces a post-authentication driver rejection through frames and result', async () => {
    const worker = newWorker();
    const { attach, toWorker, fromWorker, closed } = bridge();
    const workerDone = pumpThenCorruptAfterBootstrap(worker, toWorker, fromWorker);

    // Auth succeeds (workload is exposed), then the corrupted stream makes the driver reject.
    const run = await channelFor(attach).run(runInput(worker.recipientPublicKey()));
    expect(run.workload.jobId).toBe(JOB_ID);

    await expect(
      (async () => {
        for await (const _frame of run.frames) void _frame;
      })(),
    ).rejects.toThrow(/protocol violation/);
    await expect(run.result).rejects.toThrow(/protocol violation/);
    await workerDone;
    expect(closed()).toBe(true);
  });

  it('rejects fail-closed (no workload) when the worker proof does not authenticate', async () => {
    const worker = newWorker();
    const { attach, toWorker, fromWorker } = bridge();
    let sealed = false;
    const workerDone = pumpWorker(worker, toWorker, fromWorker, { tamperProof: true });

    const channel = createDockerGvisorSandboxChannel({
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      redactorProfile: REDACTOR_PROFILE,
      recipientKeys: createSecretWorkerRecipientKeyRegistry({ now }),
      openAttach: () => Promise.resolve(attach),
      authenticatorOptions: { now },
      now,
    });

    await expect(
      channel.run({
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        absoluteDeadline: DEADLINE,
        claims: claims(),
        sealEnvelope: (redemption) => {
          sealed = true;
          return sealEnvelopeFor(worker.recipientPublicKey())(redemption);
        },
      }),
    ).rejects.toThrow(/authentication failed/);
    await workerDone;
    expect(sealed).toBe(false); // never sealed for an unauthenticated worker
  });

  it('maps a worker terminal error to a failed result', async () => {
    const worker = newWorker(() => Promise.reject(new Error('boom')));
    const { attach, toWorker, fromWorker } = bridge();
    const workerDone = pumpWorker(worker, toWorker, fromWorker);

    const outcomes: Array<{ kind: string; errorCode?: string }> = [];
    const run = await channelFor(attach, async (outcome) => {
      outcomes.push(outcome);
      await Promise.resolve();
      throw new Error('async observer must not affect execution');
    }).run(runInput(worker.recipientPublicKey()));
    const frames = [];
    for await (const frame of run.frames) frames.push(frame);
    const result = await run.result;
    await workerDone;

    expect(frames).toHaveLength(0);
    expect(result.outcome).toBe('failed');
    expect(outcomes).toEqual([{ kind: 'error', errorCode: 'internal' }]);
  });

  it('rejects fail-closed when the signal is already aborted', async () => {
    const { attach, closed } = bridge();
    await expect(
      channelFor(attach).run(runInput(newWorker().recipientPublicKey(), AbortSignal.abort())),
    ).rejects.toThrow();
    expect(closed()).toBe(true); // attach closed even on the pre-auth abort path
  });
});
