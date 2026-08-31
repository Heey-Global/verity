import {
  createKeyHandoffSenderIdentity,
  sameKeyHandoffBinding,
  sealUnlockedKey,
  type KeyHandoffBinding,
  type KeyHandoffSenderIdentity,
} from './secret-key-handoff.js';
import type { SecretKeyHandoffClient } from './server-update-controller.js';

/**
 * The outgoing Server's side of the secret-key handoff (ADR 0008 D8).
 *
 * Without it an update ends with a Server that serves every unencrypted route
 * and refuses every secret until someone types the master password — a manual
 * step after a change the operator asked for once. This responder removes it by
 * encrypting the in-memory data key to an ephemeral public key that only the
 * promoted container holds, and leaving the result in the Updater's mailbox.
 *
 * It runs while this Server is still fully serving. The ADR describes the
 * handoff as part of the cutover, but nothing about it requires the outgoing
 * process to be quiesced: the key is the same key before and after, and sealing
 * it early means the promoted Server can adopt it the moment it wins the
 * generation instead of waiting on a process that is about to be stopped. Every
 * property the ADR asks for still holds — the key is never written down, an
 * Updater doing its job relays only ciphertext, a restarted standby invalidates
 * the offer it was sealed to, and using it requires holding the current
 * generation.
 *
 * The offer this seals to is NOT authenticated as the candidate's. A compromised
 * Updater can publish an offer of its own and read the key out of the answer,
 * and nothing here can prevent it: it creates the candidate container, so every
 * channel to that container runs through it. That is not a boundary this handoff
 * gives up — the Updater holds the Docker socket, so it can already exec into
 * this process, mount its volumes, or replace its image with one that captures
 * the master password. What the exchange does buy is confidentiality against
 * everyone else, including the Gateway and anything that later reads disk.
 *
 * Nothing here may fail an update. Every outcome short of a completed handoff
 * degrades to "the promoted Server starts sealed", which is exactly what
 * happened before this existed, so a refusal, an unreachable Updater or a
 * locked Server is a shrug rather than an error.
 */
export type SecretKeyHandoffStep =
  /** Not the Server that should be handing anything over. */
  | 'inactive'
  /** No update is at a point where a handoff means anything. */
  | 'idle'
  /** Told the Updater which identity the promoted Server must require. */
  | 'announced'
  /** Identity is published; the promoted Server has not offered yet. */
  | 'awaiting-offer'
  /** This Server is sealed itself, so it has no key to hand over. */
  | 'locked'
  /** Already answered this offer, or answered as many as one update may ask. */
  | 'exhausted'
  /** The mailbox would not take the envelope, so nothing was handed over. */
  | 'refused'
  /** The key is sealed to the offer and left in the mailbox. */
  | 'handed-off';

export interface SecretKeyHandoffResponderDeps {
  readonly client: SecretKeyHandoffClient;
  /** The unlocked key material, or undefined while this Server is sealed. */
  readonly readKeyMaterial: () => string | undefined;
  /**
   * Whether this process is still the Server a handoff should come from.
   * Defaults to always. A Server that has lost the control plane is on its way
   * out and must not keep offering its key to whatever comes next.
   */
  readonly isActive?: () => boolean;
  /**
   * How many offers one update may have answered before this Server stops.
   *
   * A standby that restarts makes a new offer, which is legitimate and must be
   * answerable — but each one costs an encryption of the live data key, so the
   * peer does not get to ask without end.
   */
  readonly maxSealsPerOperation?: number;
}

export interface SecretKeyHandoffResponder {
  /** Advance the handoff by at most one message. Throws only on transport. */
  step(): Promise<SecretKeyHandoffStep>;
  /** Forget the identity and the progress made against the current update. */
  stop(): void;
}

interface Attempt {
  readonly binding: KeyHandoffBinding;
  readonly identity: KeyHandoffSenderIdentity;
  readonly answered: Set<string>;
  seals: number;
}

const DEFAULT_MAX_SEALS = 8;

export function createSecretKeyHandoffResponder(
  deps: SecretKeyHandoffResponderDeps,
): SecretKeyHandoffResponder {
  const maxSeals = deps.maxSealsPerOperation ?? DEFAULT_MAX_SEALS;
  let attempt: Attempt | undefined;
  let generation = 0;

  return {
    async step() {
      /**
       * Whether this step still speaks for the Server it started as.
       *
       * A read of the mailbox is a round trip, and both the control-plane fence
       * and `stop` can go against this process inside it. Nothing may be sealed
       * on the way back from that: the whole point of the fence is that a Server
       * on its way out stops handing its key to whatever comes next. Rechecked
       * after every await, so no path reaches an encryption of the live key
       * without having been active an instant earlier.
       */
      const mine = generation;
      const superseded = (): boolean => mine !== generation || deps.isActive?.() === false;

      if (superseded()) return 'inactive';
      const handoff = await deps.client.read();
      if (superseded()) return 'inactive';
      if (handoff === null) {
        attempt = undefined;
        return 'idle';
      }
      if (attempt === undefined || !sameKeyHandoffBinding(attempt.binding, handoff.binding)) {
        // A new update gets a new signing identity, so material sealed for one
        // can never be presented as an answer for another.
        attempt = {
          binding: handoff.binding,
          identity: createKeyHandoffSenderIdentity(),
          answered: new Set(),
          seals: 0,
        };
      }
      // Held for the rest of the step, because `stop` may drop the shared one
      // from under a publication that is already on its way out. Bookkeeping
      // then lands on the attempt the envelope was actually sealed for, and a
      // stop stays what it is — the end of this Server's part in the handoff,
      // not a crash inside it.
      const current = attempt;
      if (handoff.senderIdentityPublicKey !== current.identity.publicKey) {
        await deps.client.publish({ senderIdentityPublicKey: current.identity.publicKey });
        // An identity is a public key and announcing one hands nothing over, but
        // the step is over either way — the next one starts from a fresh read.
        return superseded() ? 'inactive' : 'announced';
      }
      const offer = handoff.offer;
      if (offer === undefined) return 'awaiting-offer';
      if (current.answered.has(offer.nonce) || current.seals >= maxSeals) return 'exhausted';
      const material = deps.readKeyMaterial();
      if (material === undefined) return 'locked';

      // Counted before the attempt, not after: an encryption of the live data key
      // costs this Server the same work whether or not it lands, and the seal
      // budget is what stops the peer asking without end — including through a
      // seal that keeps throwing, which would otherwise retry forever.
      current.seals += 1;
      const key = Buffer.from(material, 'utf8');
      let envelope;
      try {
        envelope = sealUnlockedKey(key, offer, current.identity);
      } finally {
        key.fill(0);
      }
      // The mailbox refuses an envelope whose binding or offer no longer matches
      // what it holds — the update moved on, or the Updater restarted. Nothing
      // was handed over, so this must not be reported as a handoff, and the offer
      // stays unanswered: the next read either finds a fresh binding to announce
      // against or the same offer, still worth answering.
      // This is the last revocable moment, and it is already past: once the
      // envelope is on its way to the mailbox, losing the fence or being stopped
      // cannot take it back. So there is deliberately no `superseded()` check
      // after it — the seal happened while this Server was active, and saying
      // otherwise would report a handoff the successor can use as one that did
      // not occur. The envelope is bound to the Updater's own journal, so what a
      // late publication reaches is the candidate of the operation actually
      // running, holding the same key this store already had.
      if (!(await deps.client.publish({ envelope }))) return 'refused';
      current.answered.add(offer.nonce);
      return 'handed-off';
    },

    stop() {
      attempt = undefined;
      // Retires whatever step is between awaits, so a stop is immediate rather
      // than "immediate unless the Updater was slow to answer".
      generation += 1;
    },
  };
}

export interface SecretKeyHandoffResponderLoopDeps extends SecretKeyHandoffResponderDeps {
  /** How often to look for an update while none is in flight. */
  readonly idleIntervalMs?: number;
  /** How often to advance a handoff that is under way. */
  readonly activeIntervalMs?: number;
  /**
   * Called each time the key has been sealed to an offer and left in the
   * mailbox. Observability only, but the one moment worth telling the operator
   * about: it is the difference between the next generation coming up unlocked
   * and coming up at a master-password prompt.
   */
  readonly onHandedOff?: () => void;
  /** Observability only — a failed step is never fatal. */
  readonly onError?: (error: unknown) => void;
}

export interface SecretKeyHandoffResponderLoop {
  stop(): void;
}

const DEFAULT_IDLE_INTERVAL_MS = 5_000;
const DEFAULT_ACTIVE_INTERVAL_MS = 500;

/**
 * Poll the Updater's mailbox for as long as this Server runs.
 *
 * Polling rather than being told, because the Updater cannot call in: it holds
 * the Docker socket and runs with `network_mode: none`, so the control socket
 * only ever carries requests in this direction. The idle cadence is what a
 * Server pays when nothing is happening — one small read over a unix socket —
 * and it only speeds up once the Updater reports an update with a candidate.
 */
export function startSecretKeyHandoffResponder(
  deps: SecretKeyHandoffResponderLoopDeps,
): SecretKeyHandoffResponderLoop {
  const responder = createSecretKeyHandoffResponder(deps);
  const idle = deps.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  const active = deps.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    let outcome: SecretKeyHandoffStep = 'idle';
    try {
      outcome = await responder.step();
      // Reported even if the loop is stopping: the seal happened, and the
      // successor can use it whether or not this process polls again.
      if (outcome === 'handed-off') deps.onHandedOff?.();
    } catch (error) {
      deps.onError?.(error);
    }
    if (stopped) return;
    timer = setTimeout(
      () => void tick(),
      outcome === 'idle' || outcome === 'inactive' ? idle : active,
    );
    // Never a reason to keep the process alive: the handoff is an optimisation.
    timer.unref();
  };
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      responder.stop();
    },
  };
}
