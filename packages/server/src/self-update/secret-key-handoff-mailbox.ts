import {
  parseKeyHandoffEnvelope,
  parseKeyHandoffOffer,
  parseKeyHandoffPublicKey,
  sameKeyHandoffBinding,
  type KeyHandoffBinding,
  type KeyHandoffEnvelope,
  type KeyHandoffOffer,
} from './secret-key-handoff.js';

/**
 * The Updater's rendezvous for the secret-key handoff (ADR 0008 D8).
 *
 * The two Server processes an update involves can never address each other: the
 * outgoing Server is behind the Gateway, the promoted one has not opened a
 * listener yet, and the Updater — the only party that can see both — runs with
 * `network_mode: none`. What they do share is the Updater's control socket, so
 * the handoff travels as three small messages left in this mailbox.
 *
 * Everything here is deliberately dumb. The mailbox holds a public key, an
 * offer, and a sealed envelope; it can decrypt none of them, and the key it
 * relays is encrypted to an ephemeral public key that exists only in the
 * promoted Server's memory. It is also RAM-only: writing any of this down would
 * give the update a durable artifact describing a key whose whole point is that
 * it is never at rest.
 *
 * The mailbox is addressed by the full {@link KeyHandoffBinding}, not by the
 * operation id alone, and the Updater derives every field of that binding from
 * its own journal. Neither peer can therefore steer the relay towards a
 * different update, image or candidate container than the one actually running,
 * and neither has to re-check what the other claims. One binding is addressable
 * at a time, matching the Updater's single operation slot; anything published
 * against a different one supersedes the previous binding outright rather than
 * accumulating beside it.
 */
export interface SecretKeyHandoffMailboxView {
  /** Identity the promoted Server must require of the envelope's sender. */
  readonly senderIdentityPublicKey?: string;
  /** Ephemeral offer the outgoing Server seals its key to. */
  readonly offer?: KeyHandoffOffer;
}

export interface SecretKeyHandoffMailbox {
  /** Publish the outgoing Server's signing identity. False when unusable. */
  publishSenderIdentity(binding: KeyHandoffBinding, senderIdentityPublicKey: unknown): boolean;
  /** Publish the promoted Server's offer. False unless it carries `binding`. */
  publishOffer(binding: KeyHandoffBinding, offer: unknown): boolean;
  /** Publish the sealed key. False unless it answers the offer being held. */
  publishEnvelope(binding: KeyHandoffBinding, envelope: unknown): boolean;
  /** What both peers may read while the handoff is in flight. */
  read(binding: KeyHandoffBinding): SecretKeyHandoffMailboxView;
  /** Deliver the sealed key to whoever asks, for as long as it is current. */
  readEnvelope(binding: KeyHandoffBinding): KeyHandoffEnvelope | undefined;
  /** Forget everything, e.g. once the operation can no longer use it. */
  discard(): void;
}

export function createSecretKeyHandoffMailbox(): SecretKeyHandoffMailbox {
  let addressed: KeyHandoffBinding | undefined;
  let senderIdentityPublicKey: string | undefined;
  let offer: KeyHandoffOffer | undefined;
  let envelope: KeyHandoffEnvelope | undefined;

  const discard = (): void => {
    addressed = undefined;
    senderIdentityPublicKey = undefined;
    offer = undefined;
    envelope = undefined;
  };

  /** Point the mailbox at `binding`, clearing it when that is a new one. */
  const select = (binding: KeyHandoffBinding): void => {
    if (addressed === undefined || !sameKeyHandoffBinding(addressed, binding)) {
      discard();
      addressed = binding;
    }
  };

  /** Whether the mailbox currently answers for `binding`. */
  const holds = (binding: KeyHandoffBinding): boolean =>
    addressed !== undefined && sameKeyHandoffBinding(addressed, binding);

  return {
    publishSenderIdentity(binding, value) {
      const parsed = parseKeyHandoffPublicKey(value);
      if (parsed === null) return false;
      select(binding);
      senderIdentityPublicKey = parsed;
      return true;
    },

    /**
     * A fresh offer retires whatever was sealed to the previous one.
     *
     * The promoted Server generates its ephemeral key pair in memory, so a
     * restart leaves an envelope nobody can open. Keeping it would hand the
     * successor a handoff that fails at the last possible moment; dropping it
     * makes the restart what it actually is — the handoff has to be repeated.
     */
    publishOffer(binding, value) {
      const parsed = parseKeyHandoffOffer(value);
      if (parsed === null || !sameKeyHandoffBinding(parsed, binding)) return false;
      select(binding);
      offer = parsed;
      envelope = undefined;
      return true;
    },

    /**
     * Only an envelope that answers the offer currently held is accepted.
     *
     * The Updater cannot tell a good envelope from a bad one, but it can insist
     * that what it relays is at least an answer to what it relayed — same
     * binding, same nonce. That keeps a late envelope from a superseded offer
     * out of the successor's hands, where it would only ever fail to open.
     */
    publishEnvelope(binding, value) {
      if (!holds(binding) || offer === undefined) return false;
      const parsed = parseKeyHandoffEnvelope(value);
      if (parsed === null || !sameKeyHandoffBinding(parsed, offer) || parsed.nonce !== offer.nonce)
        return false;
      envelope = parsed;
      return true;
    },

    read(binding) {
      if (!holds(binding)) return {};
      return {
        ...(senderIdentityPublicKey === undefined ? {} : { senderIdentityPublicKey }),
        ...(offer === undefined ? {} : { offer }),
      };
    },

    /**
     * Repeatable on purpose. Consuming the envelope on the first read would be
     * the one place where a caller can destroy a handoff simply by asking: both
     * Servers authenticate to this socket with the same token, so a stale or
     * misbehaving peer could drain the envelope and leave the successor sealed.
     * Nothing is protected by spending it — the envelope is worthless to anyone
     * without the ephemeral private key, and single use is enforced where it
     * actually matters, in the receiver that consumes that key on `accept`.
     *
     * What retires an envelope is a new offer or a new binding, both of which
     * clear it above. Those are exactly the moments it stops being openable.
     */
    readEnvelope(binding) {
      if (!holds(binding)) return undefined;
      return envelope;
    },

    discard,
  };
}
