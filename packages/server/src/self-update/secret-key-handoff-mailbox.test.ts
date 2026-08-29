import { describe, expect, it } from 'vitest';

import { createSecretKeyHandoffMailbox } from './secret-key-handoff-mailbox.js';
import {
  createKeyHandoffReceiver,
  createKeyHandoffSenderIdentity,
  sealUnlockedKey,
  type KeyHandoffBinding,
} from './secret-key-handoff.js';

const binding: KeyHandoffBinding = {
  operationId: 'generation-2',
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  containerId: 'b'.repeat(64),
};
const successor: KeyHandoffBinding = { ...binding, operationId: 'generation-3' };
const sender = createKeyHandoffSenderIdentity();

const handoff = (against: KeyHandoffBinding = binding) => {
  const receiver = createKeyHandoffReceiver(against, sender.publicKey);
  return {
    receiver,
    envelope: sealUnlockedKey(Buffer.from('unlocked-data-key'), receiver.offer, sender),
  };
};

describe('self-update secret-key handoff mailbox', () => {
  it('relays an identity, an offer and a sealed key between the two Servers', async () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { receiver, envelope } = handoff();

    expect(mailbox.publishSenderIdentity(binding, sender.publicKey)).toBe(true);
    expect(mailbox.publishOffer(binding, receiver.offer)).toBe(true);
    expect(mailbox.read(binding)).toEqual({
      senderIdentityPublicKey: sender.publicKey,
      offer: receiver.offer,
    });

    expect(mailbox.publishEnvelope(binding, envelope)).toBe(true);
    const delivered = mailbox.readEnvelope(binding);
    expect(delivered).toEqual(envelope);

    // The relay has to survive the round trip intact, not merely look intact.
    receiver.accept(delivered!);
    await receiver.use(async (key) => {
      expect(key.toString()).toBe('unlocked-data-key');
    });
  });

  /**
   * Reading must not consume: both Servers hold the same token for this socket,
   * so a mailbox that spends the envelope on the first fetch lets any stale or
   * misbehaving peer leave the successor sealed just by asking. Single use is
   * enforced in the receiver, which consumes its private key on `accept`.
   */
  it('keeps delivering the sealed key for as long as it can be opened', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { envelope, receiver } = handoff();
    mailbox.publishOffer(binding, receiver.offer);
    mailbox.publishEnvelope(binding, envelope);

    expect(mailbox.readEnvelope(binding)).toEqual(envelope);
    expect(mailbox.readEnvelope(binding)).toEqual(envelope);
  });

  it('retires a sealed key when the promoted Server makes a new offer', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const first = handoff();
    mailbox.publishOffer(binding, first.receiver.offer);
    mailbox.publishEnvelope(binding, first.envelope);

    // A restarted standby lost the ephemeral private key the first envelope was
    // sealed to, so what it left behind must not be handed to its successor.
    const second = handoff();
    expect(mailbox.publishOffer(binding, second.receiver.offer)).toBe(true);
    expect(mailbox.readEnvelope(binding)).toBeUndefined();

    expect(mailbox.publishEnvelope(binding, second.envelope)).toBe(true);
    expect(mailbox.readEnvelope(binding)).toEqual(second.envelope);
  });

  it('refuses an envelope that does not answer the offer it holds', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const held = handoff();
    const other = handoff();
    mailbox.publishOffer(binding, held.receiver.offer);

    expect(mailbox.publishEnvelope(binding, other.envelope)).toBe(false);
    expect(mailbox.readEnvelope(binding)).toBeUndefined();
  });

  it('refuses an envelope while no offer is outstanding', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { envelope } = handoff();
    expect(mailbox.publishEnvelope(binding, envelope)).toBe(false);
  });

  /**
   * The Updater derives the binding from its own journal, so a peer that
   * describes a different update, image or candidate is describing something
   * that is not happening and gets nothing relayed on its behalf.
   */
  it('refuses a message published against a binding the Updater did not derive', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { receiver, envelope } = handoff();

    expect(mailbox.publishOffer(successor, receiver.offer)).toBe(false);
    expect(mailbox.publishOffer({ ...binding, containerId: 'c'.repeat(64) }, receiver.offer)).toBe(
      false,
    );

    mailbox.publishOffer(binding, receiver.offer);
    expect(mailbox.publishEnvelope(successor, envelope)).toBe(false);
    expect(mailbox.readEnvelope(successor)).toBeUndefined();
    expect(mailbox.read(successor)).toEqual({});
    expect(mailbox.read(binding)).toEqual({ offer: receiver.offer });
  });

  it('rejects malformed publications instead of relaying them', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { receiver, envelope } = handoff();

    expect(mailbox.publishSenderIdentity(binding, 'not-a-key')).toBe(false);
    expect(mailbox.publishSenderIdentity(binding, 42)).toBe(false);
    expect(mailbox.publishOffer(binding, { ...receiver.offer, extra: 'field' })).toBe(false);
    expect(mailbox.publishOffer(binding, { ...receiver.offer, nonce: 'AA==' })).toBe(false);
    expect(mailbox.read(binding)).toEqual({});

    mailbox.publishOffer(binding, receiver.offer);
    expect(mailbox.publishEnvelope(binding, { ...envelope, extra: 'field' })).toBe(false);
    expect(mailbox.publishEnvelope(binding, { ...envelope, senderPublicKey: 'AA==' })).toBe(false);
    expect(mailbox.readEnvelope(binding)).toBeUndefined();
  });

  it('supersedes a previous binding rather than accumulating beside it', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { receiver, envelope } = handoff();
    mailbox.publishSenderIdentity(binding, sender.publicKey);
    mailbox.publishOffer(binding, receiver.offer);
    mailbox.publishEnvelope(binding, envelope);

    expect(mailbox.publishSenderIdentity(successor, sender.publicKey)).toBe(true);
    expect(mailbox.read(binding)).toEqual({});
    expect(mailbox.readEnvelope(binding)).toBeUndefined();
    expect(mailbox.read(successor)).toEqual({ senderIdentityPublicKey: sender.publicKey });
  });

  it('answers nothing once discarded', () => {
    const mailbox = createSecretKeyHandoffMailbox();
    const { receiver, envelope } = handoff();
    mailbox.publishOffer(binding, receiver.offer);
    mailbox.publishEnvelope(binding, envelope);

    mailbox.discard();
    expect(mailbox.read(binding)).toEqual({});
    expect(mailbox.readEnvelope(binding)).toBeUndefined();
  });
});
