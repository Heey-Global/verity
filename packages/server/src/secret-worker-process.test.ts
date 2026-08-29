import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { RunGrantRedemption, StreamingRedactorProfile } from '@verity/secret-contracts';

import { createSecretEnvelopeSealer } from './secret-envelope-crypto.js';
import type { RawJobChunk } from './secret-job-executor.js';
import {
  createSecretWorkerChannelAuthenticator,
  type SecretWorkerProof,
} from './secret-worker-channel-auth.js';
import {
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
  type SecretWorkerWireMessage,
} from './secret-worker-protocol-codec.js';
import {
  buildSecretWorkerRuntime,
  runBootstrappedSecretWorkerProcess,
  runSecretWorkerProcess,
  secretWorkerLaunchConfigSchema,
} from './secret-worker-process.js';

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

function validConfig() {
  return {
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    executorInstanceId: EXECUTOR_INSTANCE_ID,
    claims: claims(),
    redactorProfile: REDACTOR_PROFILE,
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

function encodeMsg(type: SecretWorkerWireMessage['type'], payload: unknown): Buffer {
  return encodeSecretWorkerMessage({ protocolVersion: 1, type, payload });
}

/** Server-side seal for a decoded proof: authenticate, then seal to the worker's own recipient key. */
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
    resolveRecipientPublicKey: () => Promise.resolve(recipientPublicKey),
  });
  const secrets = new Map<string, Uint8Array>([['API_TOKEN', Buffer.from(SECRET_VALUE)]]);
  return seal(claims(), redemption, secrets);
}

describe('secret worker process', () => {
  it('bootstraps the runtime from the proof-bound challenge without launch config', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const auth = createSecretWorkerChannelAuthenticator({ now });
    const pump = runBootstrappedSecretWorkerProcess({
      input,
      output,
      runJob: echoSecretJob(),
      executorInstanceId: () => EXECUTOR_INSTANCE_ID,
      seams: { now },
    });
    const outMessages = decodeSecretWorkerMessages(output)[Symbol.asyncIterator]();
    const challenge = auth.issue({
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      absoluteDeadline: DEADLINE,
      claims: claims(),
      redactorProfile: REDACTOR_PROFILE,
    });
    input.write(encodeMsg('challenge', challenge));
    const proof = (await outMessages.next()).value as SecretWorkerWireMessage;
    expect((proof.payload as { executorInstanceId: string }).executorInstanceId).toBe(
      EXECUTOR_INSTANCE_ID,
    );
    const recipient = Buffer.from(
      (proof.payload as { recipientPublicKey: string }).recipientPublicKey,
      'base64',
    );
    input.write(encodeMsg('bootstrap', await sealFor(proof.payload, recipient, auth)));
    for (;;) {
      const reply = (await outMessages.next()).value as SecretWorkerWireMessage;
      if (reply.type === 'result' || reply.type === 'error') break;
    }
    await expect(pump).resolves.toBeUndefined();
  });

  it('rejects bootstrapping when the first message is not a challenge', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pump = runBootstrappedSecretWorkerProcess({ input, output, runJob: echoSecretJob() });
    input.write(encodeMsg('proof', {}));
    await expect(pump).rejects.toThrow(/requires challenge/);
    input.end();
  });

  it('pumps the framed protocol between stdin/stdout and the runtime end-to-end', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });
    const auth = createSecretWorkerChannelAuthenticator({ now });

    const pump = runSecretWorkerProcess({ input, output, runtime });
    const outMessages = decodeSecretWorkerMessages(output)[Symbol.asyncIterator]();

    // Server → worker: challenge on stdin.
    const challenge = auth.issue({
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      absoluteDeadline: DEADLINE,
      claims: claims(),
      redactorProfile: REDACTOR_PROFILE,
    });
    input.write(encodeMsg('challenge', challenge));

    // Worker → server: proof on stdout.
    const proof = (await outMessages.next()).value as SecretWorkerWireMessage;
    expect(proof.type).toBe('proof');

    // Server: authenticate + seal, then bootstrap on stdin.
    const envelope = await sealFor(proof.payload, runtime.recipientPublicKey(), auth);
    input.write(encodeMsg('bootstrap', envelope));

    // Worker → server: redacted frames then a terminal result.
    const replies: SecretWorkerWireMessage[] = [];
    for (;;) {
      const message = (await outMessages.next()).value as SecretWorkerWireMessage;
      replies.push(message);
      if (message.type === 'result' || message.type === 'error') break;
    }
    await pump;

    const frames = replies.filter((m) => m.type === 'frame');
    const result = replies.find((m) => m.type === 'result');
    expect(frames.length).toBeGreaterThan(0);
    expect((result!.payload as { outcome: string }).outcome).toBe('succeeded');

    const decoded = frames
      .map((m) => {
        const p = m.payload as { encoding: string; payload: string };
        return p.encoding === 'base64'
          ? Buffer.from(p.payload, 'base64').toString('utf8')
          : p.payload;
      })
      .join('');
    expect(decoded).toContain('[REDACTED]');
    expect(decoded).not.toContain(SECRET_VALUE);
    expect(runtime.state()).toBe('closed');
  });

  it('rejects fail-closed when the runtime rejects a message (bootstrap before challenge)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });

    const pump = runSecretWorkerProcess({ input, output, runtime });
    // A well-formed envelope arriving before the handshake is a protocol violation.
    input.write(
      encodeMsg('bootstrap', {
        protocolVersion: 1,
        envelopeId: 'env-1',
        grantId: 'grant-1',
        jobId: JOB_ID,
        recipientKeyId: 'rk-1',
        algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
        ephemeralPublicKey: Buffer.alloc(32, 7).toString('base64'),
        nonce: Buffer.alloc(12, 8).toString('base64'),
        aadHash: 'a'.repeat(64),
        ciphertext: Buffer.from('ciphertext').toString('base64'),
        expiresAt: '2026-07-19T00:05:00Z',
      }),
    );

    await expect(pump).rejects.toThrow(/before challenge/);
  });

  it('rejects fail-closed on malformed stdin bytes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });

    const pump = runSecretWorkerProcess({ input, output, runtime });
    // A zero-length length prefix is rejected by the codec before it reaches the runtime.
    input.write(Buffer.from([0, 0, 0, 0]));

    await expect(pump).rejects.toThrow(/worker message length/);
    input.end();
  });

  it('rejects fail-closed (does not crash) on an asynchronous stdout error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });

    const pump = runSecretWorkerProcess({ input, output, runtime });
    // Simulate the server tearing down the attach read side (EPIPE) as an async 'error' event.
    await new Promise((resolve) => setImmediate(resolve));
    output.destroy(new Error('simulated stdout EPIPE'));

    await expect(pump).rejects.toThrow(/EPIPE/);
    input.end();
  });

  it('resolves when stdin ends before a terminal message', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });

    const pump = runSecretWorkerProcess({ input, output, runtime });
    input.end(); // no messages at all

    await expect(pump).resolves.toBeUndefined();
    expect(runtime.state()).toBe('challenge');
  });

  it('validates the launch config fail-closed', () => {
    expect(() => secretWorkerLaunchConfigSchema.parse(validConfig())).not.toThrow();
    // Non-canonical container id.
    expect(() =>
      buildSecretWorkerRuntime({ ...validConfig(), containerId: 'not-hex' }, echoSecretJob()),
    ).toThrow();
    // Missing claims.
    const withoutClaims = validConfig();
    Reflect.deleteProperty(withoutClaims, 'claims');
    expect(() => buildSecretWorkerRuntime(withoutClaims, echoSecretJob())).toThrow();
    // Unknown extra field (strict).
    expect(() =>
      buildSecretWorkerRuntime({ ...validConfig(), extra: true }, echoSecretJob()),
    ).toThrow();
  });

  it('builds a runtime with a fresh 32-byte recipient key from a valid config', () => {
    const runtime = buildSecretWorkerRuntime(validConfig(), echoSecretJob(), { now });
    expect(runtime.recipientPublicKey()).toHaveLength(32);
    expect(runtime.state()).toBe('challenge');
  });
});
