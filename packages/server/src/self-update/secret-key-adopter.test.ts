import { describe, expect, it } from 'vitest';

import { adoptHandedOffSecretKey, startSecretKeyAdoption } from './secret-key-adopter.js';
import {
  createKeyHandoffReceiver,
  createKeyHandoffSenderIdentity,
  sealUnlockedKey,
  type KeyHandoffBinding,
  type KeyHandoffEnvelope,
  type KeyHandoffSenderIdentity,
} from './secret-key-handoff.js';
import type { SecretKeyHandoffClient } from './server-update-controller.js';
import type { UpdaterHandoffMessage, UpdaterHandoffState } from './updater-status.js';

const KEY = 'a1b2c3d4'.repeat(8);
const OPERATION = 'generation-2';

const binding: KeyHandoffBinding = {
  operationId: OPERATION,
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  containerId: 'b'.repeat(64),
};

/** A mailbox with the Updater's relay rules, without the Updater. */
function relay(initial: KeyHandoffBinding | null = binding) {
  let state: UpdaterHandoffState | null = initial === null ? null : { binding: initial };
  let envelope: KeyHandoffEnvelope | null = null;
  let identity: KeyHandoffSenderIdentity | undefined;
  let refusing = false;
  let taken = 0;

  const client: SecretKeyHandoffClient = {
    read: () => Promise.resolve(state),
    publish: (message: UpdaterHandoffMessage) => {
      if (state === null) return Promise.resolve(false);
      if ('senderIdentityPublicKey' in message) {
        state = { ...state, senderIdentityPublicKey: message.senderIdentityPublicKey };
      } else if ('offer' in message) {
        if (refusing) return Promise.resolve(false);
        state = { ...state, offer: message.offer };
        envelope = null;
      } else {
        envelope = message.envelope;
      }
      return Promise.resolve(true);
    },
    claimEnvelope: () => {
      const claimed = envelope;
      envelope = null;
      if (claimed !== null) taken += 1;
      return Promise.resolve(claimed);
    },
  };

  return {
    client,
    get state() {
      return state;
    },
    /** How many envelopes the peer has taken off the relay. */
    get taken() {
      return taken;
    },
    /** What the outgoing Server does first: name the identity it will sign with. */
    announce() {
      identity = createKeyHandoffSenderIdentity();
      state = { ...state!, senderIdentityPublicKey: identity.publicKey };
      return identity;
    },
    /** …and then, once an offer is there, seal the live key to it. */
    seal(signer = identity) {
      const offer = state?.offer;
      if (offer === undefined || signer === undefined) throw new Error('nothing to seal to');
      envelope = sealUnlockedKey(Buffer.from(KEY, 'utf8'), offer, signer);
      return envelope;
    },
    /** A well-formed answer to this offer that was sealed to somebody else. */
    sealToAnother() {
      const offer = state?.offer;
      if (offer === undefined || identity === undefined) throw new Error('nothing to seal to');
      const other = createKeyHandoffReceiver(binding, identity.publicKey);
      envelope = sealUnlockedKey(
        Buffer.from(KEY, 'utf8'),
        { ...other.offer, nonce: offer.nonce },
        identity,
      );
      other.destroy();
      return envelope;
    },
    refuseOffers(refuse: boolean) {
      refusing = refuse;
    },
    /** Same update, empty mailbox — what an Updater restart looks like. */
    reset(next: KeyHandoffBinding | null = binding) {
      state = next === null ? null : { binding: next };
      envelope = null;
      identity = undefined;
    },
  };
}

const adoptionFor = (client: SecretKeyHandoffClient, operationId = OPERATION) =>
  startSecretKeyAdoption({ client, operationId, pollIntervalMs: 1 });

/** A one-shot signal, for holding a round trip open across an assertion. */
function gate(): { readonly reached: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return {
    reached,
    open: () => open(),
  };
}

/** Wait for the relay to reach a state, rather than for a number of polls. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('self-update secret-key adopter', () => {
  it('offers a key only this process can open and adopts what comes back', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the offer');
      updater.seal();
      expect(await adoption.claim(2_000)).toBe(KEY);
    } finally {
      adoption.stop();
    }
  });

  /**
   * ADR 0008 D8: the decrypted key lives behind the activation gate. The offer
   * has to go out long before that gate opens, so what the poll loop may hold on
   * to is a sealed envelope — never what is inside it.
   */
  it('holds the envelope sealed until the generation is claimed', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the offer');
      updater.seal();
      await until(() => updater.taken > 0, 'the envelope to be taken');

      // Giving up now leaves nothing to give back: had the key been derived when
      // the envelope arrived, it would still be here to hand over.
      adoption.stop();
      expect(await adoption.claim(30)).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  it('offers nothing while the outgoing Server has not named its identity', async () => {
    const updater = relay();
    const adoption = adoptionFor(updater.client);
    try {
      expect(await adoption.claim(30)).toBeUndefined();
      expect(updater.state?.offer).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  it('ignores a mailbox addressed to a different update', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client, 'generation-9');
    try {
      expect(await adoption.claim(30)).toBeUndefined();
      expect(updater.state?.offer).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  it('comes up sealed rather than waiting when no update is in flight', async () => {
    const updater = relay(null);
    const adoption = adoptionFor(updater.client);
    try {
      expect(await adoption.claim(30)).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  /**
   * The Server on the other side restarting means a new signing identity. An
   * envelope from the identity that vanished proves nothing about who sent it.
   */
  it('re-offers to a replaced sender instead of trusting the old one', async () => {
    const updater = relay();
    const stale = updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the first offer');
      const first = updater.state!.offer!;

      updater.announce();
      await until(() => updater.state?.offer?.nonce !== first.nonce, 'the second offer');
      // The identity that was replaced answers anyway — nothing may come of it.
      updater.seal(stale);
      expect(await adoption.claim(60)).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  it('recovers from an envelope it cannot open by offering again', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the first offer');
      const first = updater.state!.offer!;
      updater.sealToAnother();

      await until(
        () => updater.state?.offer !== undefined && updater.state.offer.nonce !== first.nonce,
        'a replacement offer',
      );
      updater.seal();
      expect(await adoption.claim(2_000)).toBe(KEY);
    } finally {
      adoption.stop();
    }
  });

  it('republishes its offer when the relay loses it', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the offer');
      const offered = updater.state!.offer!;

      updater.reset();
      updater.announce();
      await until(() => updater.state?.offer !== undefined, 'the republished offer');
      expect(updater.state?.offer?.nonce).not.toBe(offered.nonce);

      updater.seal();
      expect(await adoption.claim(2_000)).toBe(KEY);
    } finally {
      adoption.stop();
    }
  });

  it('keeps trying while the relay refuses the offer', async () => {
    const updater = relay();
    updater.announce();
    updater.refuseOffers(true);
    const adoption = adoptionFor(updater.client);
    try {
      expect(await adoption.claim(30)).toBeUndefined();
    } finally {
      adoption.stop();
    }
    expect(updater.state?.offer).toBeUndefined();
  });

  it('survives an unreachable Updater without failing the startup it gates', async () => {
    const errors: unknown[] = [];
    const updater = relay();
    updater.announce();
    const unreachable: SecretKeyHandoffClient = {
      ...updater.client,
      read: () => Promise.reject(new Error('updater is unavailable')),
    };
    const adoption = startSecretKeyAdoption({
      client: unreachable,
      operationId: OPERATION,
      pollIntervalMs: 1,
      onError: (error) => errors.push(error),
    });
    try {
      expect(await adoption.claim(30)).toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      adoption.stop();
    }
  });

  it('stops looking once it has been claimed', async () => {
    const updater = relay();
    updater.announce();
    const adoption = adoptionFor(updater.client);
    try {
      await until(() => updater.state?.offer !== undefined, 'the offer');
      updater.seal();
      expect(await adoption.claim(2_000)).toBe(KEY);

      // The next update is somebody else's job — this process is done offering.
      updater.reset();
      updater.announce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updater.state?.offer).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  /**
   * Every step of a poll is a round trip, and the wait can end inside any of
   * them. What resumes afterwards must stay out of the mailbox: a fresh offer
   * retires whatever the outgoing Server sealed to the previous one.
   */
  it('offers nothing once the wait ended while a poll was in flight', async () => {
    const updater = relay();
    updater.announce();
    const held = gate();
    const reading = gate();
    let first = true;
    const adoption = adoptionFor({
      ...updater.client,
      read: async () => {
        if (first) {
          first = false;
          reading.open();
          await held.reached;
        }
        return updater.client.read();
      },
    });
    try {
      await reading.reached;
      expect(await adoption.claim(5)).toBeUndefined();

      held.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updater.state?.offer).toBeUndefined();
    } finally {
      adoption.stop();
    }
  });

  /**
   * The offer is the one message that cannot be recalled: it is already on its
   * way to the mailbox when the wait ends. What must not happen is a loop that
   * carries on from there — offering again, and again retiring whatever the
   * outgoing Server sealed in the meantime.
   */
  it('publishes no further offer after the wait ended inside one', async () => {
    const updater = relay();
    updater.announce();
    const held = gate();
    const offering = gate();
    const adoption = adoptionFor({
      ...updater.client,
      publish: async (message) => {
        const published = await updater.client.publish(message);
        offering.open();
        await held.reached;
        return published;
      },
    });
    try {
      await offering.reached;
      expect(await adoption.claim(5)).toBeUndefined();
      const first = updater.state?.offer;

      held.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updater.state?.offer).toBe(first);
    } finally {
      adoption.stop();
    }
  });

  /** Nor may it open one: the startup it would have unlocked has gone on sealed. */
  it('leaves a sealed key unopened when the wait ended while claiming it', async () => {
    const errors: unknown[] = [];
    const updater = relay();
    updater.announce();
    const held = gate();
    const claiming = gate();
    const adoption = startSecretKeyAdoption({
      client: {
        ...updater.client,
        claimEnvelope: async () => {
          const claimed = await updater.client.claimEnvelope();
          if (claimed === null) return null;
          claiming.open();
          await held.reached;
          return claimed;
        },
      },
      operationId: OPERATION,
      pollIntervalMs: 1,
      onError: (error) => errors.push(error),
    });
    try {
      await until(() => updater.state?.offer !== undefined, 'the offer');
      updater.seal();
      await claiming.reached;
      expect(await adoption.claim(5)).toBeUndefined();

      held.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Nothing was accepted, so the receiver was never asked to open anything
      // with the private key the timeout had already destroyed.
      expect(errors).toEqual([]);
    } finally {
      adoption.stop();
    }
  });
});

/** The store's cipher reduced to the two transitions adoption drives. */
function cipher() {
  let held: string | undefined;
  return {
    unlock(keyMaterial: string) {
      held = keyMaterial;
    },
    seal() {
      held = undefined;
    },
    get key() {
      return held;
    },
  };
}

describe('self-update handed-off key adoption', () => {
  it('unlocks the store and reports it once', async () => {
    const store = cipher();
    const warnings: string[] = [];
    const adopted = await adoptHandedOffSecretKey({
      cipher: store,
      material: KEY,
      activate: () => Promise.resolve(),
      warn: (message) => warnings.push(message),
    });

    expect(adopted).toBe(true);
    expect(store.key).toBe(KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('UNLOCKED');
  });

  /**
   * The handoff is an optimisation. Whatever an unlock sets in motion, failing
   * at it must leave the deployment where it would have been without a handoff —
   * sealed at the master-password prompt, where unlocking runs the same work
   * again — rather than crash a Server that would otherwise have come up.
   */
  it('gives the key up when the store cannot be put to use', async () => {
    const store = cipher();
    const warnings: string[] = [];
    const adopted = await adoptHandedOffSecretKey({
      cipher: store,
      material: KEY,
      activate: () => Promise.reject(new Error('gateway identity projection failed')),
      warn: (message) => warnings.push(message),
    });

    expect(adopted).toBe(false);
    expect(store.key).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('staying sealed');
  });

  /** Activation sees the key: it is the work an unlocked store makes possible. */
  it('activates with the store already unlocked', async () => {
    const store = cipher();
    let keyDuringActivation: string | undefined;
    await adoptHandedOffSecretKey({
      cipher: store,
      material: KEY,
      activate: () => {
        keyDuringActivation = store.key;
        return Promise.resolve();
      },
      warn: () => undefined,
    });

    expect(keyDuringActivation).toBe(KEY);
  });
});
