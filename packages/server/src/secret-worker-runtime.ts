import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import {
  executorWorkloadIdentitySchema,
  type ExecutorWorkloadIdentity,
  type RunGrantClaims,
  type SecretEnvelope,
  type StreamingRedactorProfile,
} from '@verity/secret-contracts';

import { generateRecipientKeyPair, type RawX25519KeyPair } from './secret-envelope-crypto.js';
import {
  runSandboxWorkload,
  type RawJobChunk,
  type SandboxWorkloadContext,
} from './secret-job-executor.js';
import {
  secretWorkerProofTranscript,
  type SecretWorkerChallenge,
} from './secret-worker-channel-auth.js';
import {
  secretWorkerMessageSchema,
  secretWorkerProofPayloadSchema,
  type SecretWorkerMessage,
} from './secret-worker-channel-state.js';
import type { SecretWorkerWireMessage } from './secret-worker-protocol-codec.js';

/**
 * Worker-side protocol runtime for the Brokered Secrets one-job executor (ADR 0009) — the in-sandbox
 * counterpart to the server's authenticator ({@link file://./secret-worker-channel-auth.ts}) and
 * channel state machine ({@link file://./secret-worker-channel-state.ts}). It runs inside the gVisor
 * container with no network and no mounts, and speaks the framed protocol over the attach duplex:
 *
 *   ← challenge          (server → worker)
 *   → proof              (worker → server, Ed25519 proof-of-possession over the challenge transcript)
 *   ← bootstrap          (server → worker, the sealed {@link SecretEnvelope} addressed to this worker)
 *   → frame* → result    (worker → server, ONLY redacted frames and a terminal result ever escape)
 *
 * The runtime generates its own single-use Ed25519 signing keypair and X25519 recipient keypair, so
 * the private material never leaves the sandbox. It derives the SAME {@link ExecutorWorkloadIdentity}
 * the server derives from the proof, which is what lets it rebuild the redemption/AAD and open the
 * envelope the server sealed. The actual secret handling — envelope open, per-stream redaction, frame
 * paging, zeroization, and fail-closed behaviour on a bad tag or a redaction collision — is delegated
 * unchanged to {@link runSandboxWorkload}; this module only adds the wire handshake and ordering.
 *
 * Ordering is enforced fail-closed on the worker side too: a bootstrap before the handshake, a second
 * challenge, or any server message after the terminal result is rejected. A worker cannot be coaxed
 * into opening the envelope before it has authenticated itself.
 */

class SecretWorkerRuntimeError extends Error {}

/** Deterministic seams for tests; production injects none and gets fresh keys and a live clock. */
export interface SecretWorkerRuntimeSeams {
  signingKeyPair?: { publicKey: KeyObject; privateKey: KeyObject };
  recipientKeyPair?: RawX25519KeyPair;
  now?: () => Date;
}

export interface SecretWorkerRuntimeOptions {
  /** This worker's launch identity, fixed by the server at container create. */
  jobId: string;
  containerId: string;
  executorInstanceId: string;
  /** The grant claims delivered in the worker's launch context; used to rebuild the envelope AAD. */
  claims: RunGrantClaims;
  redactorProfile: StreamingRedactorProfile;
  /** The secret-bearing job body. Receives the opened secret map; only its output chunks escape,
   * and only after redaction. */
  runJob: (secrets: ReadonlyMap<string, Uint8Array>) => Promise<{
    chunks: readonly RawJobChunk[];
    exitCode: number;
  }>;
  seams?: SecretWorkerRuntimeSeams;
}

type WorkerState = 'challenge' | 'bootstrap' | 'closed';

export interface SecretWorkerRuntime {
  /** The raw X25519 recipient public key the server seals the envelope to. */
  recipientPublicKey(): Uint8Array;
  state(): WorkerState;
  /** Consume one server → worker wire message and return the ordered worker → server messages to
   * send in reply. Throws {@link SecretWorkerRuntimeError} fail-closed on any protocol violation. */
  accept(message: SecretWorkerWireMessage): Promise<SecretWorkerWireMessage[]>;
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSecretWorkerRuntime(
  options: SecretWorkerRuntimeOptions,
): SecretWorkerRuntime {
  const now = options.seams?.now ?? (() => new Date());
  const signingKeyPair = options.seams?.signingKeyPair ?? generateKeyPairSync('ed25519');
  const recipientKeyPair = options.seams?.recipientKeyPair ?? generateRecipientKeyPair();
  const signingPublicKeyDer = signingKeyPair.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const recipientPublicKey = Buffer.from(recipientKeyPair.publicKey);

  let state: WorkerState = 'challenge';
  // The workload identity is only known after signing the proof (its attestationHash binds the
  // challenge transcript); it is stored for the bootstrap phase to rebuild the redemption/AAD.
  let workload: ExecutorWorkloadIdentity | undefined;

  function buildProof(challenge: SecretWorkerChallenge): {
    proof: SecretWorkerWireMessage;
    workload: ExecutorWorkloadIdentity;
  } {
    const unsigned = {
      protocolVersion: 1 as const,
      challengeId: challenge.challengeId,
      jobId: options.jobId,
      containerId: options.containerId,
      executorInstanceId: options.executorInstanceId,
      signingPublicKey: signingPublicKeyDer,
      recipientPublicKey: recipientPublicKey.toString('base64'),
    };
    const transcript = secretWorkerProofTranscript(challenge, unsigned);
    const signature = sign(null, transcript, signingKeyPair.privateKey).toString('base64');
    const payload = secretWorkerProofPayloadSchema.parse({ ...unsigned, signature });
    // Derived exactly as the server authenticator does, so the server seals the envelope to the same
    // recipient key id and the AAD the worker rebuilds matches byte-for-byte.
    const derived = executorWorkloadIdentitySchema.parse({
      executorInstanceId: options.executorInstanceId,
      jobId: options.jobId,
      publicKeyId: `worker-key-${sha256Hex(recipientPublicKey).slice(0, 24)}`,
      attestationHash: sha256Hex(transcript),
    });
    return { proof: { protocolVersion: 1, type: 'proof', payload }, workload: derived };
  }

  async function runBootstrap(envelope: SecretEnvelope): Promise<SecretWorkerWireMessage[]> {
    if (workload === undefined) {
      throw new SecretWorkerRuntimeError('bootstrap before a signed proof');
    }
    const context: SandboxWorkloadContext = {
      jobId: options.jobId,
      claims: options.claims,
      // The envelope is delivered over the wire (the server already redeemed + sealed), so `redeem`
      // is a pure adapter that hands back the bootstrap envelope; `capability` is unused.
      capability: 'brokered-secrets-wire',
      workload,
      recipientPrivateKey: recipientKeyPair.privateKey,
      redactorProfile: options.redactorProfile,
      redeem: () => Promise.resolve(envelope),
      runJob: options.runJob,
      now,
    };

    let output;
    try {
      output = await runSandboxWorkload(context);
    } catch {
      // A non-terminal fault (e.g. the job body threw). Secrets are already zeroized in
      // runSandboxWorkload's finally; report a terminal error without leaking the cause.
      const errorPayload = {
        protocolVersion: 1 as const,
        jobId: options.jobId,
        code: 'internal' as const,
        message: 'worker execution fault',
      };
      return [{ protocolVersion: 1, type: 'error', payload: errorPayload }];
    }

    const messages: SecretWorkerWireMessage[] = output.frames.map((frame) => ({
      protocolVersion: 1,
      type: 'frame',
      payload: frame,
    }));
    messages.push({ protocolVersion: 1, type: 'result', payload: output.result });
    return messages;
  }

  return {
    recipientPublicKey: () => Uint8Array.prototype.slice.call(recipientPublicKey),
    state: () => state,

    async accept(message: SecretWorkerWireMessage): Promise<SecretWorkerWireMessage[]> {
      if (state === 'closed') {
        throw new SecretWorkerRuntimeError('worker runtime is already closed');
      }
      const parsed = secretWorkerMessageSchema.safeParse(message);
      if (!parsed.success) {
        throw new SecretWorkerRuntimeError('invalid server message payload');
      }
      const msg: SecretWorkerMessage = parsed.data;

      if (state === 'challenge') {
        if (msg.type !== 'challenge') {
          throw new SecretWorkerRuntimeError(`unexpected ${msg.type} message before challenge`);
        }
        if (msg.payload.jobId !== options.jobId) {
          throw new SecretWorkerRuntimeError('challenge targets a foreign jobId');
        }
        if (msg.payload.containerId !== options.containerId) {
          throw new SecretWorkerRuntimeError('challenge targets a foreign containerId');
        }
        const built = buildProof(msg.payload);
        workload = built.workload;
        state = 'bootstrap';
        return [built.proof];
      }

      // state === 'bootstrap'
      if (msg.type !== 'bootstrap') {
        throw new SecretWorkerRuntimeError(`unexpected ${msg.type} message before bootstrap`);
      }
      if (msg.payload.jobId !== options.jobId) {
        throw new SecretWorkerRuntimeError('bootstrap envelope carries a foreign jobId');
      }
      // Close synchronously BEFORE awaiting the job body: a second bootstrap delivered while this one
      // is in-flight must be rejected ('already closed') rather than re-opening the envelope and
      // re-running the job. The channel is always terminal after bootstrap regardless of outcome.
      state = 'closed';
      return await runBootstrap(msg.payload);
    },
  };
}
