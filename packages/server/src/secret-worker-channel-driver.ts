import type { Duplex } from 'node:stream';

import type {
  RunGrantClaims,
  RunGrantRedemption,
  SecretEnvelope,
  SecretJobTerminalResult,
  StreamingRedactorProfile,
} from '@verity/secret-contracts';

import type { SecretJobFrameSink } from './secret-job-executor.js';
import {
  createSecretWorkerChannelAuthenticator,
  SecretWorkerChannelAuthError,
  type SecretWorkerChallenge,
} from './secret-worker-channel-auth.js';
import {
  createSecretWorkerChannelStateMachine,
  SecretWorkerChannelStateError,
  type SecretWorkerErrorPayload,
} from './secret-worker-channel-state.js';
import {
  decodeDockerAttachFrames,
  decodeSecretWorkerMessages,
  encodeSecretWorkerMessage,
  SecretWorkerProtocolError,
  type SecretWorkerWireMessage,
} from './secret-worker-protocol-codec.js';

/**
 * Server-side channel driver for the Brokered Secrets worker protocol (ADR 0009). This is the piece
 * that composes the already-built parts over one live attach duplex and closes the integration
 * contract the channel state machine documents: the server MUST cryptographically authenticate the
 * worker's `proof` BEFORE it seals and forwards the secret `bootstrap` envelope.
 *
 * Wiring, per attach session (all driven through ONE {@link createSecretWorkerChannelStateMachine}
 * instance so ordering has a single source of truth):
 *
 *   1. issue a one-shot challenge bound to (jobId, containerId, absoluteDeadline) and write it to the
 *      worker's stdin;
 *   2. read the worker's framed stdout — Docker attach demultiplex → length-prefixed message decode;
 *   3. on `proof`: authenticate it. On failure, revoke the challenge and fail closed — no envelope is
 *      ever sealed for an unauthenticated worker. On success, build the redemption from the derived
 *      workload identity, seal the envelope, and write it as `bootstrap`;
 *   4. on `frame`: persist the (already redacted) frame to the sink;
 *   5. on `result`/`error`: finish; anything out of order, foreign, or after the terminal is rejected
 *      by the state machine.
 *
 * The transport asymmetry is deliberate and matches Docker: the server writes RAW length-prefixed
 * messages to stdin (stdin is not multiplexed), and reads Docker-multiplexed frames from stdout. Only
 * `stdout` frames carry the protocol; `stderr` is never interpreted as protocol. The driver holds no
 * secret material — the envelope is opaque ciphertext and the frames are already redacted.
 */

export class SecretWorkerChannelDriverError extends Error {}

export type SecretWorkerChannelOutcome =
  | { kind: 'result'; result: SecretJobTerminalResult }
  | { kind: 'error'; error: SecretWorkerErrorPayload };

export interface SecretWorkerChannelDriverOptions {
  /** The hijacked attach duplex: writes become container stdin; reads are multiplexed stdout/stderr. */
  stream: Duplex;
  jobId: string;
  containerId: string;
  absoluteDeadline: string;
  /** The grant claims for this job; forwarded verbatim into the redemption the server seals to. */
  claims: RunGrantClaims;
  /** Frozen redaction policy sent through the proof-bound challenge, never Docker env or argv. */
  redactorProfile: StreamingRedactorProfile;
  /** Redeem the single-use capability and seal the envelope to the authenticated workload. Injected
   * so the driver stays agnostic of secret resolution and never touches plaintext. */
  sealEnvelope: (redemption: RunGrantRedemption) => Promise<SecretEnvelope>;
  /** Sink for the redacted frames the worker streams. */
  frames: SecretJobFrameSink;
  /** The channel authenticator (issues the challenge, verifies the proof). One per job or shared. */
  authenticator?: ReturnType<typeof createSecretWorkerChannelAuthenticator>;
  /** Aborts the session fail-closed (deadline reached or job cancelled); destroys the stream. */
  signal?: AbortSignal;
}

/**
 * Drive one worker attach session to a terminal outcome. Resolves with the worker's terminal result
 * or error; rejects fail-closed with {@link SecretWorkerChannelDriverError} on any protocol violation,
 * failed authentication, aborted deadline, or a stream that ends before a terminal message.
 */
export async function driveSecretWorkerChannel(
  options: SecretWorkerChannelDriverOptions,
): Promise<SecretWorkerChannelOutcome> {
  const { stream, jobId, containerId, claims } = options;
  const authenticator = options.authenticator ?? createSecretWorkerChannelAuthenticator();

  // A hijacked attach socket that we destroy ourselves (deadline, abort, terminal) can emit a late
  // 'error' with no consumer. Real read errors still surface through the async iterator below into
  // the try/catch; this benign listener only stops a self-inflicted destroy from crashing the process.
  stream.on('error', () => {});

  const write = (message: SecretWorkerWireMessage): void => {
    stream.write(encodeSecretWorkerMessage(message));
  };

  let challenge: SecretWorkerChallenge | undefined;
  let challengeConsumed = false;
  let aborted = false;
  // Reassigned once a challenge exists; the same reference is removed in the finally.
  let onAbort: () => void = () => {};

  try {
    // 1. Issue the challenge and open the state machine bound to it. (Inside the try so an issue-time
    //    throw still hits the finally — no leaked listener and the stream is destroyed.)
    challenge = authenticator.issue({
      jobId,
      containerId,
      absoluteDeadline: options.absoluteDeadline,
      claims,
      redactorProfile: options.redactorProfile,
    });
    const activeChallenge = challenge;
    const sm = createSecretWorkerChannelStateMachine({
      jobId,
      challengeId: activeChallenge.challengeId,
      containerId,
    });

    onAbort = (): void => {
      aborted = true;
      if (!challengeConsumed) authenticator.revoke(activeChallenge.challengeId);
      stream.destroy();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        throw new SecretWorkerChannelDriverError('worker channel aborted');
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const challengeMessage: SecretWorkerWireMessage = {
      protocolVersion: 1,
      type: 'challenge',
      payload: activeChallenge,
    };
    sm.accept(challengeMessage);
    write(challengeMessage);

    // 2. Only stdout frames carry the protocol; stderr is never interpreted as protocol.
    async function* protocolBytes(): AsyncGenerator<Uint8Array> {
      for await (const frame of decodeDockerAttachFrames(stream)) {
        if (frame.stream === 'stdout') yield frame.payload;
      }
    }

    for await (const wire of decodeSecretWorkerMessages(protocolBytes())) {
      const msg = sm.accept(wire);

      if (msg.type === 'proof') {
        // 3. THE integration contract: authenticate the proof before sealing anything. ANY throw
        //    here (bad signature, expired, replay, or a malformed derived identity) is fail-closed;
        //    the challenge is consumed either way, and sealEnvelope is never reached.
        let workload;
        try {
          workload = authenticator.authenticate(msg.payload);
        } catch {
          throw new SecretWorkerChannelDriverError('worker authentication failed');
        } finally {
          challengeConsumed = true;
        }
        const redemption: RunGrantRedemption = {
          protocolVersion: 1,
          grantId: claims.grantId,
          jobId,
          requestHash: claims.requestHash,
          workload,
        };
        const envelope = await options.sealEnvelope(redemption);
        const bootstrapMessage: SecretWorkerWireMessage = {
          protocolVersion: 1,
          type: 'bootstrap',
          payload: envelope,
        };
        sm.accept(bootstrapMessage);
        write(bootstrapMessage);
        continue;
      }

      if (msg.type === 'frame') {
        await options.frames.persist(msg.payload);
        continue;
      }

      if (msg.type === 'result') {
        return { kind: 'result', result: msg.payload };
      }
      if (msg.type === 'error') {
        return { kind: 'error', error: msg.payload };
      }
      // challenge/bootstrap are server→worker only; the state machine already rejects them inbound.
      throw new SecretWorkerChannelDriverError(`unexpected inbound ${msg.type} message`);
    }

    // The stream ended before a terminal message: the worker died. Fail closed.
    throw new SecretWorkerChannelDriverError('worker channel closed before a terminal message');
  } catch (error) {
    // An abort (deadline/cancel) takes precedence: destroying the stream mid-read surfaces as a raw
    // premature-close error, which we normalize here.
    if (aborted) throw new SecretWorkerChannelDriverError('worker channel aborted');
    if (
      error instanceof SecretWorkerChannelStateError ||
      error instanceof SecretWorkerProtocolError
    ) {
      throw new SecretWorkerChannelDriverError(
        `worker channel protocol violation: ${error.message}`,
      );
    }
    // An issue-time auth error (elapsed deadline / capacity); authenticate() failures are already
    // wrapped above. Everything else — including our own SecretWorkerChannelDriverError — rethrows.
    if (error instanceof SecretWorkerChannelAuthError) {
      throw new SecretWorkerChannelDriverError(error.message);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (challenge && !challengeConsumed) authenticator.revoke(challenge.challengeId);
    if (!stream.destroyed) stream.destroy();
  }
}
