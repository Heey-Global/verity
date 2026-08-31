import { describe, expect, it } from 'vitest';

import type {
  RunGrantClaims,
  RunGrantRedemption,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { createSecretEnvelopeSealer, generateRecipientKeyPair } from './secret-envelope-crypto.js';
import type { RawJobChunk } from './secret-job-executor.js';
import {
  createSecretWorkerChannelAuthenticator,
  type SecretWorkerProof,
} from './secret-worker-channel-auth.js';
import { createSecretWorkerChannelStateMachine } from './secret-worker-channel-state.js';
import type { SecretWorkerWireMessage } from './secret-worker-protocol-codec.js';
import { createSecretWorkerRuntime } from './secret-worker-runtime.js';

const JOB_ID = 'job-1';
const CONTAINER_ID = 'a'.repeat(64);
const EXECUTOR_INSTANCE_ID = 'exec-1';
const SECRET_VALUE = 'fake-secret-value-abcdef';
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

/** A job body that echoes the secret so redaction is observable in the returned frames. */
function echoSecretJob(): (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }> {
  return async (secrets) => {
    const token = Buffer.from(secrets.get('API_TOKEN') ?? new Uint8Array());
    return {
      chunks: [{ stream: 'stdout', chunk: Buffer.concat([Buffer.from('token='), token]) }],
      exitCode: 0,
    };
  };
}

function wireChallenge(challenge: {
  protocolVersion: 1;
  challengeId: string;
  jobId: string;
  containerId: string;
  nonce: string;
  expiresAt: string;
}): SecretWorkerWireMessage {
  return { protocolVersion: 1, type: 'challenge', payload: challenge };
}

function wireBootstrap(envelope: unknown): SecretWorkerWireMessage {
  return { protocolVersion: 1, type: 'bootstrap', payload: envelope };
}

/** A syntactically valid envelope literal (passes secretEnvelopeSchema) whose crypto is never
 * opened — used to exercise the ordering/binding guards that reject before any crypto runs. */
function validEnvelopeLiteral(jobId: string): Record<string, unknown> {
  return {
    protocolVersion: 1,
    envelopeId: 'env-1',
    grantId: 'grant-1',
    jobId,
    recipientKeyId: 'rk-1',
    algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
    ephemeralPublicKey: Buffer.alloc(32, 7).toString('base64'),
    nonce: Buffer.alloc(12, 8).toString('base64'),
    aadHash: 'a'.repeat(64),
    ciphertext: Buffer.from('ciphertext').toString('base64'),
    expiresAt: '2026-07-19T00:05:00Z',
  };
}

function wireFrame(jobId: string): SecretWorkerWireMessage {
  return {
    protocolVersion: 1,
    type: 'frame',
    payload: {
      protocolVersion: 1,
      jobId,
      sequence: 0,
      stream: 'stdout',
      encoding: 'utf8',
      payload: 'x',
      emittedAt: '2026-07-19T00:01:00.000Z',
    },
  };
}

/** Drive the server side: issue a challenge, authenticate the worker's proof, and seal an envelope
 * to the authenticated workload identity — exactly what the server does before bootstrap. */
async function sealFor(
  proofPayload: unknown,
  recipientPublicKey: Uint8Array,
  auth: ReturnType<typeof createSecretWorkerChannelAuthenticator>,
) {
  const identity = auth.authenticate(proofPayload as SecretWorkerProof);
  const redemption: RunGrantRedemption = {
    protocolVersion: 1,
    grantId: 'grant-1',
    jobId: JOB_ID,
    requestHash: 'a'.repeat(64),
    workload: identity,
  };
  const seal = createSecretEnvelopeSealer({
    resolveRecipientPublicKey: (id) =>
      Promise.resolve(id === identity.publicKeyId ? recipientPublicKey : undefined),
  });
  const secrets = new Map<string, Uint8Array>([['API_TOKEN', Buffer.from(SECRET_VALUE)]]);
  const envelope = await seal(claims(), redemption, secrets);
  return { identity, envelope };
}

type RunJob = (
  secrets: ReadonlyMap<string, Uint8Array>,
) => Promise<{ chunks: readonly RawJobChunk[]; exitCode: number }>;

function newWorker(overrides?: { runJob?: RunJob; containerId?: string }) {
  return createSecretWorkerRuntime({
    jobId: JOB_ID,
    containerId: overrides?.containerId ?? CONTAINER_ID,
    executorInstanceId: EXECUTOR_INSTANCE_ID,
    claims: claims(),
    redactorProfile: REDACTOR_PROFILE,
    runJob: overrides?.runJob ?? echoSecretJob(),
    seams: { now },
  });
}

function issueChallenge(auth: ReturnType<typeof createSecretWorkerChannelAuthenticator>) {
  return auth.issue({
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    absoluteDeadline: '2026-07-19T00:10:00Z',
    claims: claims(),
    redactorProfile: REDACTOR_PROFILE,
  });
}

describe('secret worker runtime', () => {
  it('completes the full handshake → bootstrap → redacted frames end-to-end', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);

    // The server-side state machine validates the SAME transcript the worker produces.
    const serverSm = createSecretWorkerChannelStateMachine({
      jobId: JOB_ID,
      challengeId: challenge.challengeId,
      containerId: CONTAINER_ID,
    });
    const challengeMsg = wireChallenge(challenge);
    expect(serverSm.accept(challengeMsg).type).toBe('challenge');

    // Worker: challenge → proof.
    const afterChallenge = await worker.accept(challengeMsg);
    expect(afterChallenge).toHaveLength(1);
    const proofMsg = afterChallenge[0]!;
    expect(proofMsg.type).toBe('proof');
    expect(serverSm.accept(proofMsg).type).toBe('proof');

    // Server: authenticate the proof and seal the envelope to the derived identity.
    const { identity, envelope } = await sealFor(
      proofMsg.payload,
      worker.recipientPublicKey(),
      auth,
    );
    expect(identity.jobId).toBe(JOB_ID);
    expect(identity.publicKeyId).toMatch(/^worker-key-[a-f0-9]{24}$/);

    const bootstrapMsg = wireBootstrap(envelope);
    expect(serverSm.accept(bootstrapMsg).type).toBe('bootstrap');

    // Worker: bootstrap → redacted frames + terminal result.
    const replies = await worker.accept(bootstrapMsg);
    expect(worker.state()).toBe('closed');
    const frames = replies.filter((m) => m.type === 'frame');
    const result = replies.find((m) => m.type === 'result');
    expect(frames.length).toBeGreaterThan(0);
    expect(result).toBeDefined();

    // Every worker message is accepted by the server state machine in order.
    for (const frame of frames) expect(serverSm.accept(frame).type).toBe('frame');
    expect(serverSm.accept(result!).type).toBe('result');
    expect(serverSm.isClosed()).toBe(true);

    // The secret never escapes in the clear; the redactor replaced it.
    const decoded = frames
      .map((m) => {
        const payload = m.payload as { encoding: string; payload: string };
        return payload.encoding === 'base64'
          ? Buffer.from(payload.payload, 'base64').toString('utf8')
          : payload.payload;
      })
      .join('');
    expect(decoded).toContain('[REDACTED]');
    expect(decoded).not.toContain(SECRET_VALUE);
    expect((result!.payload as { outcome: string }).outcome).toBe('succeeded');
  });

  it('emits a failed result (no frames) when the envelope was sealed to a foreign key', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);
    const [proofMsg] = await worker.accept(wireChallenge(challenge));

    // Seal to a DIFFERENT recipient key than the worker holds: the open must fail closed.
    const foreign = generateRecipientKeyPair();
    const { envelope } = await sealFor(proofMsg!.payload, foreign.publicKey, auth);

    const replies = await worker.accept(wireBootstrap(envelope));
    expect(replies.filter((m) => m.type === 'frame')).toHaveLength(0);
    const result = replies.find((m) => m.type === 'result');
    expect((result!.payload as { outcome: string }).outcome).toBe('failed');
    expect(worker.state()).toBe('closed');
  });

  it('emits a terminal error without leaking the cause when the job body throws', async () => {
    const worker = newWorker({
      runJob: () => Promise.reject(new Error('secret-bearing failure detail')),
    });
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);
    const [proofMsg] = await worker.accept(wireChallenge(challenge));
    const { envelope } = await sealFor(proofMsg!.payload, worker.recipientPublicKey(), auth);

    const replies = await worker.accept(wireBootstrap(envelope));
    expect(replies).toHaveLength(1);
    const errorMsg = replies[0]!;
    expect(errorMsg.type).toBe('error');
    const payload = errorMsg.payload as { code: string; message: string };
    expect(payload.code).toBe('internal');
    expect(payload.message).not.toContain('secret-bearing failure detail');
    expect(worker.state()).toBe('closed');
  });

  it('rejects a well-formed bootstrap that arrives before the handshake', async () => {
    const worker = newWorker();
    // A fully valid envelope (passes secretEnvelopeSchema) must still be rejected by the ordering
    // guard, not just a malformed payload.
    await expect(worker.accept(wireBootstrap(validEnvelopeLiteral(JOB_ID)))).rejects.toThrow(
      /before challenge/,
    );
    expect(worker.state()).toBe('challenge');
  });

  it('rejects a well-formed bootstrap envelope that carries a foreign jobId', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    await worker.accept(wireChallenge(issueChallenge(auth)));
    await expect(worker.accept(wireBootstrap(validEnvelopeLiteral('job-2')))).rejects.toThrow(
      /foreign jobId/,
    );
  });

  it('rejects a server frame delivered during the bootstrap phase', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    await worker.accept(wireChallenge(issueChallenge(auth)));
    await expect(worker.accept(wireFrame(JOB_ID))).rejects.toThrow(/before bootstrap/);
  });

  it('rejects a second challenge after the proof was sent', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    await worker.accept(wireChallenge(issueChallenge(auth)));
    await expect(worker.accept(wireChallenge(issueChallenge(auth)))).rejects.toThrow(
      /before bootstrap/,
    );
  });

  it('rejects a challenge that targets a foreign job or container', async () => {
    const foreignJob = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);
    await expect(
      foreignJob.accept(wireChallenge({ ...challenge, jobId: 'job-2' })),
    ).rejects.toThrow(/foreign jobId/);

    const foreignContainer = newWorker();
    await expect(
      foreignContainer.accept(wireChallenge({ ...challenge, containerId: 'b'.repeat(64) })),
    ).rejects.toThrow(/foreign containerId/);
  });

  it('rejects any message after the runtime closes', async () => {
    const worker = newWorker();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);
    const [proofMsg] = await worker.accept(wireChallenge(challenge));
    const { envelope } = await sealFor(proofMsg!.payload, worker.recipientPublicKey(), auth);
    await worker.accept(wireBootstrap(envelope));
    await expect(worker.accept(wireBootstrap(envelope))).rejects.toThrow(/already closed/);
  });

  it('rejects a concurrent second bootstrap while the first is still in-flight', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = newWorker({
      runJob: async (secrets) => {
        await gate;
        return echoSecretJob()(secrets);
      },
    });
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const challenge = issueChallenge(auth);
    const [proofMsg] = await worker.accept(wireChallenge(challenge));
    const { envelope } = await sealFor(proofMsg!.payload, worker.recipientPublicKey(), auth);

    const first = worker.accept(wireBootstrap(envelope));
    // The second bootstrap arrives while the first is blocked in runJob; it must be rejected rather
    // than re-opening the envelope and re-running the job body.
    await expect(worker.accept(wireBootstrap(envelope))).rejects.toThrow(/already closed/);
    release();
    const replies = await first;
    expect(replies.some((m) => m.type === 'result')).toBe(true);
  });

  it('produces a fresh recipient key per worker instance', () => {
    const a = Buffer.from(newWorker().recipientPublicKey()).toString('hex');
    const b = Buffer.from(newWorker().recipientPublicKey()).toString('hex');
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'hex')).toHaveLength(32);
  });
});
