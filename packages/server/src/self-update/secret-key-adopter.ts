import { createKeyHandoffReceiver, type KeyHandoffOffer } from './secret-key-handoff.js';
import type { SecretKeyHandoffClient } from './server-update-controller.js';
import { UPDATER_REQUEST_TIMEOUT_MS } from './updater-status.js';

/**
 * The promoted Server's side of the secret-key handoff (ADR 0008 D8).
 *
 * A container started for an update publishes an offer — an ephemeral X25519
 * public key generated in this process and never written anywhere — into the
 * Updater's mailbox, and waits for the outgoing Server to leave the data key
 * sealed to it. Nothing else can open the result: the private half exists only
 * in this process's memory, so a restart makes every envelope already sealed to
 * it worthless, and a relay doing its job only ever handles ciphertext.
 *
 * A relay that is not doing its job cannot get a key adopted here either. The
 * sender identity is pinned before the offer goes out, and what is opened is
 * still checked against the store's own verifier, so a substituted key is
 * refused. It can withhold and it can read — see the responder for why reading
 * is not a boundary the handoff gives up — but it cannot plant.
 *
 * All of that happens while this process is still behind the activation gate,
 * and none of it produces a key: an envelope is checked when it arrives and
 * opened only in `claim`, which the caller reaches after it holds the
 * control-plane generation. Possession of the sealed envelope is not possession
 * of the key, which is what lets the offer go out as early as it must.
 *
 * This is an optimisation over the master-password prompt, never a requirement.
 * Any failure — no offer answered, an unreachable Updater, a sender this process
 * does not trust — ends with the promoted Server sealed, which is exactly what
 * happened before this existed.
 */

const DEFAULT_POLL_INTERVAL_MS = 250;
/**
 * How long to wait for the envelope once the generation has been won.
 *
 * By then the answer either exists or never will: the activation gate this
 * process was blocked on is published in `activating-candidate`, one phase
 * *after* `quiescing-old` has stopped the only process that could seal anything.
 * Whatever the mailbox holds at that moment is all it will ever hold, and the
 * poll loop has been claiming from it every 250 ms throughout the wait. This is
 * therefore not a search — it is a grace window for the round trips already in
 * flight.
 *
 * Which is why it is a multiple of what one of those round trips is allowed to
 * take, and not something shorter that reads as "brisk": the poll that is in
 * flight when the gate opens may be a read whose claim has yet to follow, and
 * cutting either off early would leave the promoted Server at a master-password
 * prompt over a key that had already been sealed for it. A few seconds of
 * startup are cheap next to that; the Updater answers this socket in
 * microseconds when it is healthy, so the window only ever elapses when
 * something is wrong.
 */
const DEFAULT_CLAIM_TIMEOUT_MS = 2 * UPDATER_REQUEST_TIMEOUT_MS;

export interface SecretKeyAdoptionDeps {
  readonly client: SecretKeyHandoffClient;
  /**
   * The update this container was started for. The mailbox must be addressed to
   * it; anything else is a handoff for a different Server and is ignored rather
   * than answered.
   */
  readonly operationId: string;
  readonly pollIntervalMs?: number;
  /** Observability only — a failed poll is never fatal. */
  readonly onError?: (error: unknown) => void;
}

export interface SecretKeyAdoption {
  /**
   * Wait for the handed-off key material, then stop.
   *
   * Resolves undefined when nothing arrives in time, so the caller can always
   * treat this as "unlocked if we were lucky".
   */
  claim(timeoutMs?: number): Promise<string | undefined>;
  stop(): void;
}

/**
 * A verified envelope, still sealed.
 *
 * What the poll loop produces, because everything it does happens while this
 * process is behind the activation gate — and ADR 0008 D8 puts the decrypted key
 * in a memory slot on the far side of that gate. So the loop settles the means
 * to open the envelope rather than what is inside it, and the plaintext comes
 * into existence in `claim`, once the generation has been won.
 */
interface SealedSecretKey {
  open(): Promise<string | undefined>;
}

/**
 * Start offering and waiting, as early in startup as possible.
 *
 * The offer has to be published before this process blocks on the activation
 * gate: the outgoing Server can only seal to an offer it can see, and it is
 * fully serving during exactly that window. By the time the generation has been
 * won, the answer is usually already waiting.
 */
export function startSecretKeyAdoption(deps: SecretKeyAdoptionDeps): SecretKeyAdoption {
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let receiver: ReturnType<typeof createKeyHandoffReceiver> | undefined;
  let offered: KeyHandoffOffer | undefined;
  let sealedBy: string | undefined;
  let settle: (sealed: SealedSecretKey | undefined) => void = () => undefined;
  const adopted = new Promise<SealedSecretKey | undefined>((resolve) => {
    settle = resolve;
  });

  const forget = (): void => {
    receiver?.destroy();
    receiver = undefined;
    offered = undefined;
    sealedBy = undefined;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Never a reason to keep the process alive for a poll: the handoff is an
      // optimisation, and the caller decides how long it is worth waiting.
      setTimeout(resolve, ms).unref();
    });

  /**
   * Whether the caller gave up while the await above was outstanding.
   *
   * Every step of a poll is a round trip to the Updater, and `claim` can time out
   * or `stop` can run inside any of them. Resuming from there must not put a
   * fresh offer into the mailbox — which retires whatever was sealed to the
   * previous one — and must not open an envelope whose key nobody will read: the
   * startup that would have used it has already gone on sealed. Checked after
   * each round trip, so what follows is only ever reached while still wanted.
   *
   * A publication cannot start after that either, which is the property to keep
   * when editing this: nothing is awaited between the check and the request it
   * guards. Once a request has left, no check can recall it — the checks after
   * one are there to drop the private key it would otherwise keep alive.
   */
  const abandoned = (): boolean => {
    if (!stopped) return false;
    forget();
    return true;
  };

  const poll = async (): Promise<SealedSecretKey | undefined> => {
    const state = await deps.client.read();
    if (abandoned()) return undefined;
    // Not addressed to this update: either no update is in flight or the mailbox
    // belongs to a different candidate. Either way there is nothing to answer.
    if (state === null || state.binding.operationId !== deps.operationId) {
      forget();
      return undefined;
    }
    const sender = state.senderIdentityPublicKey;
    if (sender === undefined) {
      forget();
      return undefined;
    }
    // A new signing identity means the Server on the other side restarted. The
    // offer it never saw is worthless, and an envelope from the old identity is
    // not something this process should open.
    if (receiver === undefined || sealedBy !== sender) {
      forget();
      const fresh = createKeyHandoffReceiver(state.binding, sender);
      receiver = fresh;
      offered = fresh.offer;
      sealedBy = sender;
      // Either failure leaves a private key nobody will ever use: an offer the
      // relay refused, or a caller that stopped waiting while it was on its way.
      if (!(await deps.client.publish({ offer: fresh.offer })) || abandoned()) forget();
      return undefined;
    }
    // The relay lost the offer (a new operation, or the Updater restarted), so
    // republish rather than wait forever on an answer that cannot come.
    if (state.offer?.nonce !== offered?.nonce) {
      if (
        offered !== undefined &&
        (!(await deps.client.publish({ offer: offered })) || abandoned())
      )
        forget();
      return undefined;
    }
    const envelope = await deps.client.claimEnvelope();
    if (envelope === null || abandoned()) return undefined;
    const held = receiver;
    try {
      // Checked but not opened. Everything that decides whether this envelope is
      // worth opening is decidable now — it is signed over, and the signature
      // covers the offer it answers — and now is when a bad one can still be
      // replaced: the Server that could seal another is still running. What is
      // deliberately not done here is the decryption, which belongs behind the
      // activation gate this process has not passed yet.
      held.verify(envelope);
    } catch (error) {
      // Start over with a fresh offer: the outgoing Server answers a new nonce,
      // so a single bad relay is survivable.
      forget();
      throw error;
    }
    return {
      open: async () => {
        // The caller may have given up between the envelope arriving and this:
        // `stop` destroys the receiver, and opening is the one path that would
        // otherwise still reach it.
        if (abandoned()) return undefined;
        held.accept(envelope);
        // The buffer is zeroed on the way out of `use`. What is kept is a string,
        // which cannot be wiped — but that is where an unlocked cipher holds the
        // key anyway, so this adds no exposure the process does not already have.
        return await held.use((key) => Promise.resolve(key.toString('utf8')));
      },
    };
  };

  void (async () => {
    while (!stopped) {
      try {
        const sealed = await poll();
        if (sealed !== undefined) {
          settle(sealed);
          return;
        }
      } catch (error) {
        deps.onError?.(error);
      }
      await sleep(interval);
    }
  })();

  return {
    async claim(timeoutMs = DEFAULT_CLAIM_TIMEOUT_MS): Promise<string | undefined> {
      try {
        const sealed = await Promise.race([adopted, sleep(timeoutMs).then(() => undefined)]);
        // Here and nowhere earlier: the caller only calls this once it holds the
        // control-plane generation, so this is the first moment the key may
        // exist in this process at all.
        return sealed === undefined ? undefined : await sealed.open();
      } catch (error) {
        // An envelope that passed verification and then failed to open means the
        // sender sealed it wrong. Nothing is retryable by now — the Server that
        // sealed it has been stopped — so this degrades like any other miss.
        deps.onError?.(error);
        return undefined;
      } finally {
        stopped = true;
        forget();
      }
    },
    stop() {
      stopped = true;
      forget();
      settle(undefined);
    },
  };
}

/** Just enough of the store's cipher to put a key in and take it back out. */
interface AdoptableSecretCipher {
  unlock(keyMaterial: string): void;
  seal(): void;
}

export interface HandedOffKeyAdoptionDeps {
  readonly cipher: AdoptableSecretCipher;
  /** Already checked against the store's verifier by the caller. */
  readonly material: string;
  /**
   * Everything an operator's unlock would trigger — the Agent Gateway identity
   * projection and the model catalog refresh. Run through the same door on
   * purpose: a handoff must not reach code an interactive boot would not.
   */
  readonly activate: () => Promise<void>;
  readonly warn?: (message: string, error?: unknown) => void;
}

/**
 * Put a handed-off key to use, or give it up (ADR 0008 D8).
 *
 * The handoff is an optimisation, so it may never turn a startup that would
 * otherwise have succeeded into a failed one. If activation throws, the key is
 * dropped and the store is left sealed — exactly where the deployment would have
 * been without a handoff, including the retry: the operator's unlock runs the
 * same activation again.
 *
 * Activation is not a transaction, and resealing does not undo the part of it
 * that already ran — the Agent Gateway identity may be projected while this
 * returns false. That is deliberate rather than overlooked. Each step is
 * idempotent and is exactly what an unlock performs, so what is left behind is
 * a prefix of the state the operator's retry produces in full, not state the
 * deployment would otherwise never hold: the interactive route leaves the same
 * prefix when its activation throws, and stays unlocked over it. Sealing here is
 * the stricter of the two, on purpose — nobody proved possession of the master
 * password on this path, so a startup that could not complete the work an unlock
 * does asks for one rather than serving as if it had.
 *
 * Returns whether the store came away unlocked.
 */
export async function adoptHandedOffSecretKey(deps: HandedOffKeyAdoptionDeps): Promise<boolean> {
  const warn = deps.warn ?? ((message, error) => console.warn(message, error));
  deps.cipher.unlock(deps.material);
  try {
    await deps.activate();
  } catch (error) {
    deps.cipher.seal();
    warn(
      'verity: the key handed over by the previous Server could not be put to use — ' +
        'staying sealed, unlock via POST /secret/unlock',
      error,
    );
    return false;
  }
  warn('verity: secret store UNLOCKED from the self-update key handoff');
  return true;
}
