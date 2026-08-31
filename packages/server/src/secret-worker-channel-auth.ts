import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

import {
  canonicalJson,
  executorWorkloadIdentitySchema,
  type ExecutorWorkloadIdentity,
  type RunGrantClaims,
  type StreamingRedactorProfile,
} from '@verity/secret-contracts';
import type { AuthenticatedRecipientKey } from './secret-worker-recipient-key-registry.js';

const CHALLENGE_BYTES = 32;
const RECIPIENT_PUBLIC_KEY_BYTES = 32;
const MAX_SIGNING_KEY_BYTES = 256;

export class SecretWorkerChannelAuthError extends Error {}

export interface SecretWorkerChallenge {
  protocolVersion: 1;
  challengeId: string;
  jobId: string;
  containerId: string;
  nonce: string;
  expiresAt: string;
  claims: RunGrantClaims;
  redactorProfile: StreamingRedactorProfile;
}

export interface SecretWorkerProof {
  protocolVersion: 1;
  challengeId: string;
  jobId: string;
  containerId: string;
  executorInstanceId: string;
  signingPublicKey: string;
  recipientPublicKey: string;
  signature: string;
}

type PendingChallenge = SecretWorkerChallenge & { absoluteDeadlineMs: number };

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeCanonicalBase64(value: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SecretWorkerChannelAuthError('worker proof contains invalid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new SecretWorkerChannelAuthError('worker proof contains non-canonical base64');
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new SecretWorkerChannelAuthError('worker proof contains an invalid key length');
  }
  return decoded;
}

/** Stable transcript signed by the worker. The server challenge is included so a proof is
 * one-shot; the Docker container id and absolute deadline bind it to the launch the server already
 * inspected and authorized. */
export function secretWorkerProofTranscript(
  challenge: SecretWorkerChallenge,
  proof: Omit<SecretWorkerProof, 'signature'>,
): Uint8Array {
  return Buffer.from(
    [
      'verity.secret-worker-channel.v1',
      challenge.challengeId,
      challenge.nonce,
      challenge.expiresAt,
      canonicalJson(challenge.claims),
      canonicalJson(challenge.redactorProfile),
      proof.jobId,
      proof.containerId,
      proof.executorInstanceId,
      proof.signingPublicKey,
      proof.recipientPublicKey,
    ].join('\0'),
    'utf8',
  );
}

export function createSecretWorkerChannelAuthenticator(options?: {
  now?: () => Date;
  random?: (bytes: number) => Uint8Array;
  challengeTtlMs?: number;
  maximumPendingChallenges?: number;
  /** Receives the raw X25519 key only after its proof has verified successfully. */
  onAuthenticatedRecipient?: (recipient: AuthenticatedRecipientKey) => void;
}) {
  const now = options?.now ?? (() => new Date());
  const random = options?.random ?? randomBytes;
  const challengeTtlMs = options?.challengeTtlMs ?? 15_000;
  const maximumPendingChallenges = options?.maximumPendingChallenges ?? 1_024;
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs <= 0 || challengeTtlMs > 60_000) {
    throw new Error('worker challenge TTL must be between 1 and 60000 ms');
  }
  if (!Number.isSafeInteger(maximumPendingChallenges) || maximumPendingChallenges <= 0) {
    throw new Error('maximum pending worker challenges must be positive');
  }

  const pending = new Map<string, PendingChallenge>();

  function purgeExpired(instantMs: number): void {
    for (const [id, challenge] of pending) {
      if (
        Date.parse(challenge.expiresAt) <= instantMs ||
        challenge.absoluteDeadlineMs <= instantMs
      ) {
        pending.delete(id);
      }
    }
  }

  return {
    issue(input: {
      jobId: string;
      containerId: string;
      absoluteDeadline: string;
      claims: RunGrantClaims;
      redactorProfile: StreamingRedactorProfile;
    }): SecretWorkerChallenge {
      const instantMs = now().getTime();
      const absoluteDeadlineMs = Date.parse(input.absoluteDeadline);
      if (!Number.isFinite(absoluteDeadlineMs) || absoluteDeadlineMs <= instantMs) {
        throw new SecretWorkerChannelAuthError('worker deadline already elapsed');
      }
      purgeExpired(instantMs);
      if (pending.size >= maximumPendingChallenges) {
        throw new SecretWorkerChannelAuthError('worker challenge capacity exhausted');
      }
      const nonce = Buffer.from(random(CHALLENGE_BYTES));
      if (nonce.length !== CHALLENGE_BYTES)
        throw new Error('worker challenge RNG returned wrong length');
      const nonceBase64 = nonce.toString('base64');
      const challengeId = `wch-${sha256(nonce).slice(0, 32)}`;
      if (pending.has(challengeId))
        throw new SecretWorkerChannelAuthError('worker challenge collision');
      const expiresAt = new Date(
        Math.min(instantMs + challengeTtlMs, absoluteDeadlineMs),
      ).toISOString();
      const challenge: PendingChallenge = {
        protocolVersion: 1,
        challengeId,
        jobId: input.jobId,
        containerId: input.containerId,
        nonce: nonceBase64,
        expiresAt,
        claims: input.claims,
        redactorProfile: input.redactorProfile,
        absoluteDeadlineMs,
      };
      pending.set(challengeId, challenge);
      return {
        protocolVersion: challenge.protocolVersion,
        challengeId: challenge.challengeId,
        jobId: challenge.jobId,
        containerId: challenge.containerId,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        claims: challenge.claims,
        redactorProfile: challenge.redactorProfile,
      };
    },

    authenticate(proof: SecretWorkerProof): ExecutorWorkloadIdentity {
      const challenge = pending.get(proof.challengeId);
      // Consume before parsing or verification: malformed/tampered attempts cannot be retried as
      // an oracle, and a valid proof cannot be replayed after either success or failure.
      if (challenge !== undefined) pending.delete(proof.challengeId);
      if (challenge === undefined) {
        throw new SecretWorkerChannelAuthError('unknown or consumed worker challenge');
      }
      const instantMs = now().getTime();
      if (
        Date.parse(challenge.expiresAt) <= instantMs ||
        challenge.absoluteDeadlineMs <= instantMs
      ) {
        throw new SecretWorkerChannelAuthError('worker challenge expired');
      }
      if (
        proof.protocolVersion !== 1 ||
        proof.jobId !== challenge.jobId ||
        proof.containerId !== challenge.containerId
      ) {
        throw new SecretWorkerChannelAuthError('worker proof context mismatch');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proof.executorInstanceId)) {
        throw new SecretWorkerChannelAuthError('invalid executor instance id');
      }
      const signingKeyDer = decodeCanonicalBase64(proof.signingPublicKey);
      if (signingKeyDer.length === 0 || signingKeyDer.length > MAX_SIGNING_KEY_BYTES) {
        throw new SecretWorkerChannelAuthError('invalid worker signing key');
      }
      const recipientPublicKey = decodeCanonicalBase64(
        proof.recipientPublicKey,
        RECIPIENT_PUBLIC_KEY_BYTES,
      );
      const signature = decodeCanonicalBase64(proof.signature);
      const unsignedProof: Omit<SecretWorkerProof, 'signature'> = {
        protocolVersion: proof.protocolVersion,
        challengeId: proof.challengeId,
        jobId: proof.jobId,
        containerId: proof.containerId,
        executorInstanceId: proof.executorInstanceId,
        signingPublicKey: proof.signingPublicKey,
        recipientPublicKey: proof.recipientPublicKey,
      };
      let verified: boolean;
      try {
        const signingKey = createPublicKey({ key: signingKeyDer, format: 'der', type: 'spki' });
        if (signingKey.asymmetricKeyType !== 'ed25519') {
          throw new SecretWorkerChannelAuthError('worker signing key must be Ed25519');
        }
        verified = verifySignature(
          null,
          secretWorkerProofTranscript(challenge, unsignedProof),
          signingKey,
          signature,
        );
      } catch (error) {
        if (error instanceof SecretWorkerChannelAuthError) throw error;
        throw new SecretWorkerChannelAuthError('invalid worker signing key');
      }
      if (!verified) throw new SecretWorkerChannelAuthError('worker proof signature rejected');

      const workload = executorWorkloadIdentitySchema.parse({
        executorInstanceId: proof.executorInstanceId,
        jobId: proof.jobId,
        publicKeyId: `worker-key-${sha256(recipientPublicKey).slice(0, 24)}`,
        attestationHash: sha256(secretWorkerProofTranscript(challenge, unsignedProof)),
      });
      options?.onAuthenticatedRecipient?.({
        workload,
        recipientPublicKey: Uint8Array.prototype.slice.call(recipientPublicKey),
        expiresAt: challenge.expiresAt,
      });
      return workload;
    },

    /** Idempotently invalidate an unconsumed challenge when attach or launch aborts. */
    revoke(challengeId: string): void {
      pending.delete(challengeId);
    },

    pendingCount(): number {
      purgeExpired(now().getTime());
      return pending.size;
    },
  };
}
