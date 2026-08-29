import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RunGrantClaims, StreamingRedactorProfile } from '@verity/secret-contracts';

import type { SecretWorkerChallenge, SecretWorkerProof } from './secret-worker-channel-auth.js';
import type { SecretWorkerWireMessage } from './secret-worker-protocol-codec.js';
import {
  createSecretWorkerChannelStateMachine,
  secretWorkerMessageSchema,
  SecretWorkerChannelStateError,
  type SecretWorkerChallengePayload,
  type SecretWorkerMessage,
  type SecretWorkerProofPayload,
} from './secret-worker-channel-state.js';

const CONTAINER_ID = 'a'.repeat(64);
const CHALLENGE_ID = 'wch-0123456789abcdef0123456789abcdef';
const JOB_ID = 'job-1';
const ISO = '2026-07-21T00:00:00.000Z';
const CLAIMS: RunGrantClaims = {
  protocolVersion: 1,
  grantId: 'grant-1',
  requestHash: 'a'.repeat(64),
  projectId: 'project-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  profile: { id: 'profile-1', version: 1, policyHash: 'b'.repeat(64) },
  aliases: [{ id: 'alias-1', version: 1 }],
  providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
  audience: 'verity-secret-job-executor',
  issuedAt: '2026-07-20T23:59:00.000Z',
  expiresAt: '2026-07-21T00:05:00.000Z',
  nonce: 'n'.repeat(32),
};
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

const binding = { jobId: JOB_ID, challengeId: CHALLENGE_ID, containerId: CONTAINER_ID } as const;

function b64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

function wire(type: SecretWorkerMessage['type'], payload: unknown): SecretWorkerWireMessage {
  return { protocolVersion: 1, type, payload };
}

const challenge = wire('challenge', {
  protocolVersion: 1,
  challengeId: CHALLENGE_ID,
  jobId: JOB_ID,
  containerId: CONTAINER_ID,
  nonce: b64(32, 1),
  expiresAt: ISO,
  claims: CLAIMS,
  redactorProfile: REDACTOR_PROFILE,
});

const proof = wire('proof', {
  protocolVersion: 1,
  challengeId: CHALLENGE_ID,
  jobId: JOB_ID,
  containerId: CONTAINER_ID,
  executorInstanceId: 'executor-1',
  signingPublicKey: b64(44, 2),
  recipientPublicKey: b64(32, 3),
  signature: b64(64, 4),
});

const bootstrap = wire('bootstrap', {
  protocolVersion: 1,
  envelopeId: 'env-1',
  grantId: 'grant-1',
  jobId: JOB_ID,
  recipientKeyId: 'rk-1',
  algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
  ephemeralPublicKey: b64(32, 7),
  nonce: b64(12, 8),
  aadHash: 'a'.repeat(64),
  ciphertext: Buffer.from('ciphertext').toString('base64'),
  expiresAt: ISO,
});

function frame(sequence: number): SecretWorkerWireMessage {
  return wire('frame', {
    protocolVersion: 1,
    jobId: JOB_ID,
    sequence,
    stream: 'stdout',
    encoding: 'utf8',
    payload: `line-${sequence}`,
    emittedAt: ISO,
  });
}

function result(finalSequence?: number): SecretWorkerWireMessage {
  return wire('result', {
    protocolVersion: 1,
    jobId: JOB_ID,
    outcome: 'succeeded',
    ...(finalSequence === undefined ? {} : { finalSequence }),
    finishedAt: ISO,
  });
}

const workerError = wire('error', {
  protocolVersion: 1,
  jobId: JOB_ID,
  code: 'worker_fault',
  message: 'boom',
});

describe('secret worker channel state machine', () => {
  it('drives the full challenge → proof → bootstrap → frame* → result sequence', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    expect(channel.state()).toBe('challenge');

    expect(channel.accept(challenge).type).toBe('challenge');
    expect(channel.state()).toBe('proof');

    expect(channel.accept(proof).type).toBe('proof');
    expect(channel.state()).toBe('bootstrap');

    expect(channel.accept(bootstrap).type).toBe('bootstrap');
    expect(channel.state()).toBe('streaming');

    expect(channel.accept(frame(0)).type).toBe('frame');
    expect(channel.accept(frame(1)).type).toBe('frame');
    expect(channel.state()).toBe('streaming');

    expect(channel.accept(result(1)).type).toBe('result');
    expect(channel.state()).toBe('closed');
    expect(channel.isClosed()).toBe(true);
  });

  it('accepts a terminal error and a zero-frame result as valid closures', () => {
    const errored = createSecretWorkerChannelStateMachine(binding);
    errored.accept(challenge);
    errored.accept(proof);
    errored.accept(bootstrap);
    expect(errored.accept(workerError).type).toBe('error');
    expect(errored.isClosed()).toBe(true);

    const empty = createSecretWorkerChannelStateMachine(binding);
    empty.accept(challenge);
    empty.accept(proof);
    empty.accept(bootstrap);
    expect(empty.accept(result()).type).toBe('result');
    expect(empty.isClosed()).toBe(true);
  });

  it('rejects a premature frame before the handshake completes', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    expect(() => channel.accept(frame(0))).toThrow(SecretWorkerChannelStateError);
    // The rejected message must not have advanced the channel.
    expect(channel.state()).toBe('challenge');
  });

  it('rejects a proof that skips the challenge', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    expect(() => channel.accept(proof)).toThrow(/unexpected proof/);
  });

  it('rejects a bootstrap before the proof', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    expect(() => channel.accept(bootstrap)).toThrow(/unexpected bootstrap/);
  });

  it('rejects a second proof after the handshake advanced', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    expect(() => channel.accept(proof)).toThrow(/unexpected proof/);
  });

  it('rejects any message after the terminal result closes the channel', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    channel.accept(bootstrap);
    channel.accept(result());
    expect(() => channel.accept(frame(0))).toThrow(/already closed/);
    expect(() => channel.accept(result())).toThrow(/already closed/);
  });

  it('rejects a foreign challengeId, containerId, and jobId fail-closed', () => {
    const foreignChallengeId = createSecretWorkerChannelStateMachine(binding);
    expect(() =>
      foreignChallengeId.accept(
        wire('challenge', {
          protocolVersion: 1,
          challengeId: 'wch-ffffffffffffffffffffffffffffffff',
          jobId: JOB_ID,
          containerId: CONTAINER_ID,
          nonce: b64(32, 1),
          expiresAt: ISO,
          claims: CLAIMS,
          redactorProfile: REDACTOR_PROFILE,
        }),
      ),
    ).toThrow(/foreign challengeId/);

    const foreignContainer = createSecretWorkerChannelStateMachine(binding);
    expect(() =>
      foreignContainer.accept(
        wire('challenge', {
          protocolVersion: 1,
          challengeId: CHALLENGE_ID,
          jobId: JOB_ID,
          containerId: 'b'.repeat(64),
          nonce: b64(32, 1),
          expiresAt: ISO,
          claims: CLAIMS,
          redactorProfile: REDACTOR_PROFILE,
        }),
      ),
    ).toThrow(/foreign containerId/);

    const foreignJob = createSecretWorkerChannelStateMachine(binding);
    foreignJob.accept(challenge);
    foreignJob.accept(proof);
    foreignJob.accept(bootstrap);
    expect(() =>
      foreignJob.accept(
        wire('frame', {
          protocolVersion: 1,
          jobId: 'job-2',
          sequence: 0,
          stream: 'stdout',
          encoding: 'utf8',
          payload: 'x',
          emittedAt: ISO,
        }),
      ),
    ).toThrow(/foreign jobId/);
  });

  it('rejects a non-contiguous frame sequence', () => {
    const skipsZero = createSecretWorkerChannelStateMachine(binding);
    skipsZero.accept(challenge);
    skipsZero.accept(proof);
    skipsZero.accept(bootstrap);
    expect(() => skipsZero.accept(frame(1))).toThrow(/non-contiguous/);

    const gap = createSecretWorkerChannelStateMachine(binding);
    gap.accept(challenge);
    gap.accept(proof);
    gap.accept(bootstrap);
    gap.accept(frame(0));
    expect(() => gap.accept(frame(2))).toThrow(/non-contiguous/);
  });

  it('rejects a terminal finalSequence that disagrees with the streamed frames', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    channel.accept(bootstrap);
    channel.accept(frame(0));
    expect(() => channel.accept(result(5))).toThrow(/finalSequence/);
  });

  it('rejects a finalSequence on a zero-frame result', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    channel.accept(bootstrap);
    expect(() => channel.accept(result(0))).toThrow(/finalSequence/);
  });

  it('rejects a result that omits finalSequence after frames streamed', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    channel.accept(bootstrap);
    channel.accept(frame(0));
    // Omitting finalSequence after a streamed frame would let a truncated stream pass as complete.
    expect(() => channel.accept(result())).toThrow(/must carry finalSequence/);
  });

  it('accepts a terminal error raised during the bootstrap phase', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    expect(channel.state()).toBe('bootstrap');
    expect(channel.accept(workerError).type).toBe('error');
    expect(channel.isClosed()).toBe(true);
  });

  it('rejects a terminal error before authentication (challenge/proof phase)', () => {
    const atChallenge = createSecretWorkerChannelStateMachine(binding);
    expect(() => atChallenge.accept(workerError)).toThrow(/unexpected error/);

    const atProof = createSecretWorkerChannelStateMachine(binding);
    atProof.accept(challenge);
    expect(() => atProof.accept(workerError)).toThrow(/unexpected error/);
  });

  it('rejects any message after a terminal error closes the channel', () => {
    const channel = createSecretWorkerChannelStateMachine(binding);
    channel.accept(challenge);
    channel.accept(proof);
    channel.accept(bootstrap);
    channel.accept(workerError);
    expect(() => channel.accept(frame(0))).toThrow(/already closed/);
    expect(() => channel.accept(workerError)).toThrow(/already closed/);
  });

  it('binds the proof, bootstrap, result, and error messages to the channel identity', () => {
    const foreignProofChallenge = createSecretWorkerChannelStateMachine(binding);
    foreignProofChallenge.accept(challenge);
    expect(() =>
      foreignProofChallenge.accept(
        wire('proof', {
          ...(proof.payload as object),
          challengeId: 'wch-ffffffffffffffffffffffffffffffff',
        }),
      ),
    ).toThrow(/foreign challengeId/);

    const foreignProofContainer = createSecretWorkerChannelStateMachine(binding);
    foreignProofContainer.accept(challenge);
    expect(() =>
      foreignProofContainer.accept(
        wire('proof', { ...(proof.payload as object), containerId: 'c'.repeat(64) }),
      ),
    ).toThrow(/foreign containerId/);

    const foreignBootstrap = createSecretWorkerChannelStateMachine(binding);
    foreignBootstrap.accept(challenge);
    foreignBootstrap.accept(proof);
    expect(() =>
      foreignBootstrap.accept(
        wire('bootstrap', { ...(bootstrap.payload as object), jobId: 'job-2' }),
      ),
    ).toThrow(/foreign jobId/);

    const foreignResult = createSecretWorkerChannelStateMachine(binding);
    foreignResult.accept(challenge);
    foreignResult.accept(proof);
    foreignResult.accept(bootstrap);
    expect(() =>
      foreignResult.accept(
        wire('result', {
          protocolVersion: 1,
          jobId: 'job-2',
          outcome: 'succeeded',
          finishedAt: ISO,
        }),
      ),
    ).toThrow(/foreign jobId/);

    const foreignError = createSecretWorkerChannelStateMachine(binding);
    foreignError.accept(challenge);
    foreignError.accept(proof);
    foreignError.accept(bootstrap);
    expect(() =>
      foreignError.accept(
        wire('error', { protocolVersion: 1, jobId: 'job-2', code: 'internal', message: 'x' }),
      ),
    ).toThrow(/foreign jobId/);
  });

  it('rejects a malformed payload and a type/payload mismatch before ordering', () => {
    const malformed = createSecretWorkerChannelStateMachine(binding);
    expect(() => malformed.accept(wire('challenge', { challengeId: CHALLENGE_ID }))).toThrow(
      /invalid worker message payload/,
    );

    // A `frame` type carrying a challenge-shaped payload is rejected by the discriminated union.
    const mismatched = createSecretWorkerChannelStateMachine(binding);
    expect(() => mismatched.accept(wire('frame', challenge.payload))).toThrow(
      /invalid worker message payload/,
    );
  });

  it('rejects a construction binding with a malformed container id', () => {
    expect(() =>
      createSecretWorkerChannelStateMachine({ ...binding, containerId: 'not-hex' }),
    ).toThrow();
  });

  it('parses each message type through the exported discriminated schema', () => {
    for (const message of [challenge, proof, bootstrap, frame(0), result(), workerError]) {
      expect(secretWorkerMessageSchema.parse(message).type).toBe(message.type);
    }
  });

  it('keeps the wire challenge/proof payloads assignable to the authenticator types', () => {
    expectTypeOf<SecretWorkerChallengePayload>().toEqualTypeOf<SecretWorkerChallenge>();
    expectTypeOf<SecretWorkerProofPayload>().toEqualTypeOf<SecretWorkerProof>();
  });
});
