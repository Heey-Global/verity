import { Duplex, PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type {
  RunGrantRedemption,
  SecretJobFrame,
  SecretJobStartRequest,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { createBrokeredSecretJobExecutor } from './brokered-secret-job-executor.js';
import type { AttachedDuplex } from './docker-gvisor-sandbox-channel.js';
import type {
  ContainerInspect,
  ContainerSpec,
  DockerClient,
  DockerRuntimeRegistration,
} from './docker.js';
import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import type { RawJobChunk, SecretJobFrameSink } from './secret-job-executor.js';
import type { SecretJobGrant } from './secret-job-grant-resolver.js';
import { createSecretWorkerChannelAuthenticator } from './secret-worker-channel-auth.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';
import {
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
  type SecretWorkerWireMessage,
} from './secret-worker-protocol-codec.js';
import { createSecretWorkerRuntime } from './secret-worker-runtime.js';

const JOB_ID = 'job-1';
// The launched container id must equal the worker's own (the challenge binds containerId), so the
// fake docker returns exactly this id from createContainer.
const CONTAINER_ID = 'a'.repeat(64);
const EXECUTOR_INSTANCE_ID = 'exec-1';
const SECRET_VALUE = 'fake-secret-value-abcdef';
const DEADLINE = '2026-07-19T00:10:00Z';
const now = () => new Date('2026-07-19T00:01:00Z');

const runtimeOptions = {
  expectedRuntimePath: '/opt/verity/runsc/release-20260714.0/runsc',
  expectedRuntimeArgs: ['--platform=systrap', '--network=none'],
} as const;

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

function grant(capability = 'cap-1'): SecretJobGrant {
  return { capability, claims: claims() };
}

function startRequest(): SecretJobStartRequest {
  return {
    protocolVersion: 1,
    requestId: 'request-1',
    projectId: 'project-1',
    requestHash: 'a'.repeat(64),
    jobId: JOB_ID,
    grantId: 'grant-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    executorImageDigest: 'e'.repeat(64),
    absoluteDeadline: DEADLINE,
  };
}

type RunJob = (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }>;

/** A job body that echoes the injected secret, so redaction is observable in the frames. */
function echoSecretJob(): RunJob {
  return (secrets) => {
    const token = Buffer.from(secrets.get('API_TOKEN') ?? new Uint8Array());
    return Promise.resolve({
      chunks: [{ stream: 'stdout' as const, chunk: Buffer.concat([Buffer.from('token='), token]) }],
      exitCode: 0,
    });
  };
}

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

/** The fake broker: its `redeem` seals the redemption to the worker's own recipient key, exactly as
 * the real broker would after redeeming a capability. */
function fakeBroker(worker: ReturnType<typeof createSecretWorkerRuntime>) {
  const seal = createSecretEnvelopeSealer({
    resolveRecipientPublicKey: () => Promise.resolve(worker.recipientPublicKey()),
  });
  const secrets = new Map<string, Uint8Array>([['API_TOKEN', Buffer.from(SECRET_VALUE)]]);
  const redeem = vi.fn((_capability: string, redemption: RunGrantRedemption) =>
    seal(claims(), redemption, secrets),
  );
  return { broker: { redeem }, redeem };
}

function fakeDocker(overrides: { startContainer?: (id: string) => Promise<void> } = {}) {
  const specs: ContainerSpec[] = [];
  const createContainer = vi.fn(async (containerSpec: ContainerSpec) => {
    specs.push(containerSpec);
    return { id: CONTAINER_ID, warnings: [] };
  });
  const startContainer = vi.fn(overrides.startContainer ?? (async (id: string) => void id));
  const stopContainer = vi.fn(async (id: string) => void id);
  const removeContainer = vi.fn(async (id: string) => void id);
  const inspectContainer = vi.fn<(id: string) => Promise<ContainerInspect>>();
  const inspectRuntime = vi.fn(async (): Promise<DockerRuntimeRegistration> => ({
    path: runtimeOptions.expectedRuntimePath,
    args: [...runtimeOptions.expectedRuntimeArgs],
  }));
  return {
    client: {
      createContainer,
      startContainer,
      stopContainer,
      removeContainer,
      inspectContainer,
      inspectRuntime,
    } as unknown as DockerClient,
    specs,
    createContainer,
    startContainer,
    removeContainer,
    inspectRuntime,
  };
}

function collectingFrames(): { sink: SecretJobFrameSink; frames: SecretJobFrame[] } {
  const frames: SecretJobFrame[] = [];
  return {
    sink: {
      persist(frame) {
        frames.push(frame);
      },
    },
    frames,
  };
}

function decodeFrames(frames: SecretJobFrame[]): string {
  return frames
    .map((f) =>
      f.encoding === 'base64' ? Buffer.from(f.payload, 'base64').toString('utf8') : f.payload,
    )
    .join('');
}

function composeWithWorker(opts: { runJob?: RunJob; tamperProof?: boolean } = {}) {
  const worker = newWorker(opts.runJob);
  const { attach, toWorker, fromWorker, closed } = bridge();
  const workerDone = pumpWorker(worker, toWorker, fromWorker, {
    ...(opts.tamperProof ? { tamperProof: true } : {}),
  });
  const { broker, redeem } = fakeBroker(worker);
  const docker = fakeDocker();
  const { sink, frames } = collectingFrames();
  const executor = createBrokeredSecretJobExecutor({
    broker,
    docker: docker.client,
    dockerBaseUrl: 'unix:///var/run/docker.sock',
    frames: sink,
    redactorProfile: REDACTOR_PROFILE,
    recipientKeys: createSecretWorkerRecipientKeyRegistry({ now }),
    expectedRuntimePath: runtimeOptions.expectedRuntimePath,
    expectedRuntimeArgs: runtimeOptions.expectedRuntimeArgs,
    executorImageRepository: 'executor',
    now,
    seams: {
      openAttach: () => Promise.resolve(attach),
      authenticator: createSecretWorkerChannelAuthenticator({ now }),
      scheduleDeadline: () => ({ cancel: () => undefined }),
    },
  });
  return { executor, worker, redeem, docker, frames, workerDone, closed };
}

describe('brokered secret job executor', () => {
  it('runs the full pipeline: bind → launch (secret-free) → authenticate → seal → redacted result, then unbinds', async () => {
    const c = composeWithWorker();

    const result = await c.executor.runJob(grant(), startRequest());
    await c.workerDone;

    expect(result.outcome).toBe('succeeded');

    // The capability from the bound grant reached the broker exactly once (single-use redemption).
    expect(c.redeem).toHaveBeenCalledTimes(1);
    expect(c.redeem.mock.calls[0]?.[0]).toBe('cap-1');

    // The frames the sink saw are already redacted; the secret never appears in cleartext.
    const decoded = decodeFrames(c.frames);
    expect(decoded).toContain('[REDACTED]');
    expect(decoded).not.toContain(SECRET_VALUE);

    // A single sandbox was launched from a secret-free create spec, then torn down and the attach closed.
    expect(c.docker.createContainer).toHaveBeenCalledTimes(1);
    const specJson = JSON.stringify(c.docker.specs[0]);
    expect(specJson).not.toContain(SECRET_VALUE);
    expect(specJson).not.toContain('cap-1');
    expect(c.docker.removeContainer).toHaveBeenCalled();
    expect(c.closed()).toBe(true);

    // The grant binding was dropped on the success path.
    expect(c.executor.boundGrants()).toBe(0);
    expect(c.executor.jobState(JOB_ID)).toBe('reaped');
  });

  it('preserves authenticate-before-seal: a tampered proof never seals and unbinds fail-closed', async () => {
    const c = composeWithWorker({ tamperProof: true });

    await expect(c.executor.runJob(grant(), startRequest())).rejects.toThrow(
      /authentication failed/,
    );
    await c.workerDone;

    // The broker was never asked to redeem, because the seal is only reached after a valid auth.
    expect(c.redeem).not.toHaveBeenCalled();
    // The binding is dropped even though the launch threw.
    expect(c.executor.boundGrants()).toBe(0);
  });

  it('unbinds and never redeems when the launch itself fails before the sandbox authenticates', async () => {
    const worker = newWorker();
    const { broker, redeem } = fakeBroker(worker);
    // startContainer fails, so launch rejects before channel.run/openAttach is ever reached.
    const docker = fakeDocker({
      startContainer: () => Promise.reject(new Error('start failed')),
    });
    const { sink } = collectingFrames();
    const executor = createBrokeredSecretJobExecutor({
      broker,
      docker: docker.client,
      dockerBaseUrl: 'unix:///var/run/docker.sock',
      frames: sink,
      redactorProfile: REDACTOR_PROFILE,
      recipientKeys: createSecretWorkerRecipientKeyRegistry({ now }),
      expectedRuntimePath: runtimeOptions.expectedRuntimePath,
      expectedRuntimeArgs: runtimeOptions.expectedRuntimeArgs,
      executorImageRepository: 'executor',
      now,
      seams: {
        openAttach: () => Promise.reject(new Error('attach must not be opened on a failed launch')),
        authenticator: createSecretWorkerChannelAuthenticator({ now }),
        scheduleDeadline: () => ({ cancel: () => undefined }),
      },
    });

    await expect(executor.runJob(grant(), startRequest())).rejects.toThrow();

    expect(redeem).not.toHaveBeenCalled();
    expect(docker.removeContainer).toHaveBeenCalled(); // the created container is force-removed
    expect(executor.boundGrants()).toBe(0); // binding dropped on the launch-failure path
    expect(executor.jobState(JOB_ID)).toBeUndefined(); // record dropped so replay re-launches cleanly
  });
});
