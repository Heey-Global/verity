import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { RunGrantClaims, StreamingRedactorProfile } from '@verity/secret-contracts';

import {
  createSecretWorkerChannelAuthenticator,
  SecretWorkerChannelAuthError,
  secretWorkerProofTranscript,
  type SecretWorkerChallenge,
  type SecretWorkerProof,
} from './secret-worker-channel-auth.js';
import { createSecretWorkerRecipientKeyRegistry } from './secret-worker-recipient-key-registry.js';

const clock = { value: new Date('2026-07-20T00:00:00.000Z') };
const now = () => clock.value;
const fixedRandom = () => new Uint8Array(32).fill(7);
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
  issuedAt: '2026-07-20T00:00:00.000Z',
  expiresAt: '2026-07-20T00:05:00.000Z',
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
const INITIALIZATION = { claims: CLAIMS, redactorProfile: REDACTOR_PROFILE };

function createProof(challenge: SecretWorkerChallenge, overrides: Partial<SecretWorkerProof> = {}) {
  const signing = generateKeyPairSync('ed25519');
  const unsigned = {
    protocolVersion: 1 as const,
    challengeId: challenge.challengeId,
    jobId: challenge.jobId,
    containerId: challenge.containerId,
    executorInstanceId: 'executor-1',
    signingPublicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    recipientPublicKey: Buffer.alloc(32, 9).toString('base64'),
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      secretWorkerProofTranscript(challenge, unsigned),
      signing.privateKey,
    ).toString('base64'),
  };
}

function issue() {
  const auth = createSecretWorkerChannelAuthenticator({ now, random: fixedRandom });
  const challenge = auth.issue({
    jobId: 'job-1',
    containerId: 'container-1',
    absoluteDeadline: '2026-07-20T00:10:00.000Z',
    ...INITIALIZATION,
  });
  return { auth, challenge };
}

describe('secret worker channel authentication', () => {
  it('registers the proof-bound recipient key only after successful authentication', async () => {
    const registry = createSecretWorkerRecipientKeyRegistry({ now });
    const auth = createSecretWorkerChannelAuthenticator({
      now,
      random: fixedRandom,
      onAuthenticatedRecipient: (recipient) => registry.register(recipient),
    });
    const challenge = auth.issue({
      jobId: 'job-1',
      containerId: 'container-1',
      absoluteDeadline: '2026-07-20T00:10:00.000Z',
      ...INITIALIZATION,
    });
    const proof = createProof(challenge);
    const identity = auth.authenticate(proof);
    await expect(registry.resolve(identity.publicKeyId, identity.jobId)).resolves.toEqual(
      Buffer.from(proof.recipientPublicKey, 'base64'),
    );
  });

  it('authenticates a fresh proof and derives a safe workload identity', () => {
    const { auth, challenge } = issue();
    const identity = auth.authenticate(createProof(challenge));

    expect(identity).toMatchObject({
      executorInstanceId: 'executor-1',
      jobId: 'job-1',
    });
    expect(identity.publicKeyId).toMatch(/^worker-key-[a-f0-9]{24}$/);
    expect(identity.attestationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(auth.pendingCount()).toBe(0);
  });

  it('rejects replay after a successful authentication', () => {
    const { auth, challenge } = issue();
    const proof = createProof(challenge);
    auth.authenticate(proof);
    expect(() => auth.authenticate(proof)).toThrow(/unknown or consumed/);
  });

  it('revokes an abandoned challenge idempotently', () => {
    const { auth, challenge } = issue();
    auth.revoke(challenge.challengeId);
    auth.revoke(challenge.challengeId);
    expect(auth.pendingCount()).toBe(0);
    expect(() => auth.authenticate(createProof(challenge))).toThrow(/unknown or consumed/);
  });

  it.each([
    ['foreign job', { jobId: 'job-2' }],
    ['foreign container', { containerId: 'container-2' }],
  ])('rejects and consumes a %s proof', (_label, override) => {
    const { auth, challenge } = issue();
    const proof = createProof(challenge, override);
    expect(() => auth.authenticate(proof)).toThrow(/context mismatch/);
    expect(() => auth.authenticate(createProof(challenge))).toThrow(/unknown or consumed/);
  });

  it('rejects and consumes a tampered signed field', () => {
    const { auth, challenge } = issue();
    const proof = createProof(challenge);
    proof.executorInstanceId = 'executor-tampered';
    expect(() => auth.authenticate(proof)).toThrow(/signature rejected/);
    expect(() => auth.authenticate(createProof(challenge))).toThrow(/unknown or consumed/);
  });

  it('rejects challenge initialization metadata tampered in transit', () => {
    const { auth, challenge } = issue();
    const tampered = {
      ...challenge,
      redactorProfile: { ...challenge.redactorProfile, implementationDigest: 'e'.repeat(64) },
    };
    expect(() => auth.authenticate(createProof(tampered))).toThrow(/signature rejected/);
    expect(auth.pendingCount()).toBe(0);
  });

  it('rejects expired challenges and deadlines', () => {
    const { auth, challenge } = issue();
    clock.value = new Date(challenge.expiresAt);
    expect(() => auth.authenticate(createProof(challenge))).toThrow(/expired/);
    clock.value = new Date('2026-07-20T00:00:00.000Z');

    expect(() =>
      auth.issue({
        jobId: 'job-1',
        containerId: 'container-1',
        absoluteDeadline: '2026-07-19T23:59:59.000Z',
        ...INITIALIZATION,
      }),
    ).toThrow(/deadline already elapsed/);
  });

  it('rejects non-Ed25519 keys and malformed recipient keys fail-closed', () => {
    const first = issue();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaProof = createProof(first.challenge, {
      signingPublicKey: rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    });
    expect(() => first.auth.authenticate(rsaProof)).toThrow(/worker signing key/);

    const second = issue();
    expect(() =>
      second.auth.authenticate(createProof(second.challenge, { recipientPublicKey: 'YQ==' })),
    ).toThrow(/invalid key length/);
  });

  it('bounds pending authentication state', () => {
    let counter = 0;
    const auth = createSecretWorkerChannelAuthenticator({
      now,
      maximumPendingChallenges: 1,
      random: () => new Uint8Array(32).fill(++counter),
    });
    auth.issue({
      jobId: 'job-1',
      containerId: 'container-1',
      absoluteDeadline: '2026-07-20T00:10:00.000Z',
      ...INITIALIZATION,
    });
    expect(() =>
      auth.issue({
        jobId: 'job-2',
        containerId: 'container-2',
        absoluteDeadline: '2026-07-20T00:10:00.000Z',
        ...INITIALIZATION,
      }),
    ).toThrow(/capacity exhausted/);
  });

  it('fails closed on an RNG challenge collision', () => {
    const auth = createSecretWorkerChannelAuthenticator({ now, random: fixedRandom });
    const input = {
      jobId: 'job-1',
      containerId: 'container-1',
      absoluteDeadline: '2026-07-20T00:10:00.000Z',
      ...INITIALIZATION,
    };
    auth.issue(input);
    expect(() => auth.issue({ ...input, jobId: 'job-2' })).toThrow(/challenge collision/);
    expect(auth.pendingCount()).toBe(1);
  });

  it('validates constructor bounds', () => {
    expect(() => createSecretWorkerChannelAuthenticator({ challengeTtlMs: 0 })).toThrow();
    expect(() => createSecretWorkerChannelAuthenticator({ challengeTtlMs: 60_001 })).toThrow();
    expect(() => createSecretWorkerChannelAuthenticator({ maximumPendingChallenges: 0 })).toThrow();
    expect(SecretWorkerChannelAuthError).toBeDefined();
  });
});
