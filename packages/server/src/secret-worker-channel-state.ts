import {
  base64Schema,
  brokeredSecretsProtocolVersionSchema,
  isoUtcTimestampSchema,
  runGrantClaimsSchema,
  secretContractIdSchema,
  secretEnvelopeSchema,
  secretJobFrameSchema,
  secretJobTerminalResultSchema,
  streamingRedactorProfileSchema,
} from '@verity/secret-contracts';
import { z } from 'zod';

import type { SecretWorkerWireMessage } from './secret-worker-protocol-codec.js';

/**
 * Typed payload schemas plus the mandatory channel state sequence for the Brokered Secrets worker
 * protocol (ADR 0009, follow-up to the framing codec). The codec upstream only guarantees a
 * well-formed `{protocolVersion, type, payload}` envelope with an *unknown* payload; this module is
 * the layer that (a) parses each payload against a strict schema bound to the existing contracts and
 * (b) enforces the only legal ordering of messages over the duplex attach stream:
 *
 *   challenge → proof → bootstrap → frame* → (result | error)
 *
 * Every deviation — an out-of-order message, a second proof, a premature frame, any message after the
 * terminal result/error, a foreign `jobId`/`challengeId`/`containerId`, or a non-contiguous frame
 * sequence — is rejected fail-closed. The state machine never trusts a worker to self-order its
 * transcript.
 *
 * Scope: this layer enforces *ordering, shape, and binding only*. It performs NO cryptographic
 * verification — the Ed25519 proof-of-possession is verified separately by the authenticator
 * ({@link file://./secret-worker-channel-auth.ts}), which the integration MUST invoke on the `proof`
 * message. The ordering guarantee is what makes that verification meaningful: because no `bootstrap`
 * (which carries the secret envelope) and no `frame` is structurally accepted until a `proof` message
 * has passed, a caller that authenticates the proof before forwarding `bootstrap` can never hand a
 * worker the envelope or accept its output ahead of authentication. This machine models one *fresh*
 * worker attach — frame sequences are anchored at 0 and it carries no resume cursor; the client-side
 * replay/resume path is a separate contract (`secretJobAttachExchange`).
 */

/** Canonical 64-hex Docker container id — binds every handshake message to the one launch the server
 * already inspected and authorized. */
const dockerContainerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Base64 that must decode to exactly `bytes` octets — a syntactic gate matching the authenticator's
 * exact key/nonce/signature sizes so the wire schema does not drift looser than the crypto layer. */
function base64Bytes(bytes: number) {
  return base64Schema.refine(
    (value) => Buffer.from(value, 'base64').byteLength === bytes,
    `must decode to exactly ${bytes} bytes`,
  );
}

/** Server → worker: the one-shot authentication challenge (mirrors {@link SecretWorkerChallenge}). */
export const secretWorkerChallengePayloadSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    challengeId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    containerId: dockerContainerIdSchema,
    nonce: base64Bytes(32),
    expiresAt: isoUtcTimestampSchema,
    claims: runGrantClaimsSchema,
    redactorProfile: streamingRedactorProfileSchema,
  })
  .strict();
export type SecretWorkerChallengePayload = z.infer<typeof secretWorkerChallengePayloadSchema>;

/** Worker → server: the proof-of-possession over the challenge (mirrors {@link SecretWorkerProof}). */
export const secretWorkerProofPayloadSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    challengeId: secretContractIdSchema,
    jobId: secretContractIdSchema,
    containerId: dockerContainerIdSchema,
    executorInstanceId: secretContractIdSchema,
    // A DER SPKI Ed25519 key is 44 bytes; keep a bounded range here and let the authenticator do the
    // exact SPKI/curve check. The recipient key and signature have fixed sizes, so pin them exactly.
    signingPublicKey: base64Schema.min(1).max(512),
    recipientPublicKey: base64Bytes(32),
    signature: base64Bytes(64),
  })
  .strict();
export type SecretWorkerProofPayload = z.infer<typeof secretWorkerProofPayloadSchema>;

/** Worker → server: a terminal error that ends the channel without a validated result. */
const secretWorkerErrorPayloadSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    jobId: secretContractIdSchema,
    code: z.enum(['worker_fault', 'deadline_exceeded', 'policy_violation', 'internal']),
    message: z.string().min(1).max(512),
  })
  .strict();
export type SecretWorkerErrorPayload = z.infer<typeof secretWorkerErrorPayloadSchema>;

/** Discriminated view of a decoded wire message with its payload parsed to the per-type schema.
 * `bootstrap`, `frame`, and `result` reuse the canonical contract schemas verbatim so the wire
 * protocol cannot drift from the persisted/audited shapes. */
export const secretWorkerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('challenge'),
      payload: secretWorkerChallengePayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('proof'),
      payload: secretWorkerProofPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('bootstrap'),
      payload: secretEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('frame'),
      payload: secretJobFrameSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('result'),
      payload: secretJobTerminalResultSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: brokeredSecretsProtocolVersionSchema,
      type: z.literal('error'),
      payload: secretWorkerErrorPayloadSchema,
    })
    .strict(),
]);
export type SecretWorkerMessage = z.infer<typeof secretWorkerMessageSchema>;

export class SecretWorkerChannelStateError extends Error {}

/** The channel identity the server fixed at launch; every message is bound to it. */
export interface SecretWorkerChannelBinding {
  jobId: string;
  challengeId: string;
  containerId: string;
}

type SecretWorkerChannelState = 'challenge' | 'proof' | 'bootstrap' | 'streaming' | 'closed';

export interface SecretWorkerChannelStateMachine {
  /** The state the channel will interpret the *next* message in. */
  state(): SecretWorkerChannelState;
  /** True once a terminal `result`/`error` has been accepted; no further messages are legal. */
  isClosed(): boolean;
  /** Parse + order-check a decoded wire message, advancing the channel. Throws fail-closed on any
   * illegal transition, foreign binding, malformed payload, or non-contiguous frame sequence. */
  accept(message: SecretWorkerWireMessage): SecretWorkerMessage;
}

/**
 * Build a fresh state machine for one worker channel. The returned object is single-use and stateful:
 * feed it the decoded wire messages in arrival order; it returns the strongly-typed, order-validated
 * message or throws {@link SecretWorkerChannelStateError}.
 */
export function createSecretWorkerChannelStateMachine(
  binding: SecretWorkerChannelBinding,
): SecretWorkerChannelStateMachine {
  const jobId = secretContractIdSchema.parse(binding.jobId);
  const challengeId = secretContractIdSchema.parse(binding.challengeId);
  const containerId = dockerContainerIdSchema.parse(binding.containerId);

  let state: SecretWorkerChannelState = 'challenge';
  let nextFrameSequence = 0;

  function requireJob(actual: string): void {
    if (actual !== jobId) {
      throw new SecretWorkerChannelStateError('worker message carries a foreign jobId');
    }
  }

  function requireHandshakeBinding(payload: {
    jobId: string;
    challengeId: string;
    containerId: string;
  }): void {
    requireJob(payload.jobId);
    if (payload.challengeId !== challengeId) {
      throw new SecretWorkerChannelStateError('worker message carries a foreign challengeId');
    }
    if (payload.containerId !== containerId) {
      throw new SecretWorkerChannelStateError('worker message carries a foreign containerId');
    }
  }

  function unexpected(type: SecretWorkerMessage['type']): never {
    throw new SecretWorkerChannelStateError(`unexpected ${type} message in state ${state}`);
  }

  /** A `result` must account for exactly the frames streamed: present iff frames were emitted, and
   * then equal to the last frame's sequence. Omitting it after N frames would let a truncated stream
   * pass as complete, so absence is only legal for a zero-frame job. */
  function requireResultSequence(finalSequence: number | undefined): void {
    if (nextFrameSequence === 0) {
      if (finalSequence !== undefined) {
        throw new SecretWorkerChannelStateError('a zero-frame result must omit finalSequence');
      }
      return;
    }
    const lastEmitted = nextFrameSequence - 1;
    if (finalSequence === undefined) {
      throw new SecretWorkerChannelStateError(
        'a result after streamed frames must carry finalSequence',
      );
    }
    if (finalSequence !== lastEmitted) {
      throw new SecretWorkerChannelStateError(
        'terminal finalSequence does not match the streamed frames',
      );
    }
  }

  /** Bind and close on a terminal `result`/`error`. Accepted once the worker is authenticated
   * (bootstrap onward); a fault before/at bootstrap can still report a terminal `error`. */
  function closeTerminal(
    msg: Extract<SecretWorkerMessage, { type: 'result' | 'error' }>,
  ): SecretWorkerMessage {
    requireJob(msg.payload.jobId);
    if (msg.type === 'result') requireResultSequence(msg.payload.finalSequence);
    state = 'closed';
    return msg;
  }

  return {
    state: () => state,
    isClosed: () => state === 'closed',

    accept(message: SecretWorkerWireMessage): SecretWorkerMessage {
      if (state === 'closed') {
        throw new SecretWorkerChannelStateError('worker channel is already closed');
      }
      const parsed = secretWorkerMessageSchema.safeParse(message);
      if (!parsed.success) {
        throw new SecretWorkerChannelStateError('invalid worker message payload');
      }
      const msg = parsed.data;

      switch (state) {
        case 'challenge':
          if (msg.type !== 'challenge') unexpected(msg.type);
          requireHandshakeBinding(msg.payload);
          state = 'proof';
          return msg;

        case 'proof':
          if (msg.type !== 'proof') unexpected(msg.type);
          requireHandshakeBinding(msg.payload);
          state = 'bootstrap';
          return msg;

        case 'bootstrap':
          // A worker that faults after authentication but before streaming may close with `error`.
          if (msg.type === 'error') return closeTerminal(msg);
          if (msg.type !== 'bootstrap') unexpected(msg.type);
          requireJob(msg.payload.jobId);
          state = 'streaming';
          return msg;

        case 'streaming':
          if (msg.type === 'frame') {
            requireJob(msg.payload.jobId);
            if (msg.payload.sequence !== nextFrameSequence) {
              throw new SecretWorkerChannelStateError('non-contiguous worker frame sequence');
            }
            nextFrameSequence += 1;
            return msg;
          }
          if (msg.type === 'result' || msg.type === 'error') return closeTerminal(msg);
          return unexpected(msg.type);

        default:
          return unexpected(msg.type);
      }
    },
  };
}
