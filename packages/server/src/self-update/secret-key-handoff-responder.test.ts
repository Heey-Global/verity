import { describe, expect, it, vi } from 'vitest';

import {
  createSecretKeyHandoffResponder,
  startSecretKeyHandoffResponder,
  type SecretKeyHandoffResponderDeps,
} from './secret-key-handoff-responder.js';
import {
  createKeyHandoffReceiver,
  type KeyHandoffBinding,
  type KeyHandoffEnvelope,
} from './secret-key-handoff.js';
import type { SecretKeyHandoffClient } from './server-update-controller.js';
import type { UpdaterHandoffMessage, UpdaterHandoffState } from './updater-status.js';

const KEY = 'a1b2c3d4'.repeat(8);

const binding: KeyHandoffBinding = {
  operationId: 'generation-2',
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  containerId: 'b'.repeat(64),
};
const successor: KeyHandoffBinding = { ...binding, operationId: 'generation-3' };

/** A mailbox with the Updater's relay rules, without the Updater. */
function relay(initial: KeyHandoffBinding | null = binding) {
  let addressed = initial;
  let state: UpdaterHandoffState | null = initial === null ? null : { binding: initial };
  let envelope: KeyHandoffEnvelope | null = null;
  const published: UpdaterHandoffMessage[] = [];

  const client: SecretKeyHandoffClient = {
    read: () => Promise.resolve(state),
    publish: (message) => {
      published.push(message);
      if (state === null) return Promise.resolve(false);
      if ('senderIdentityPublicKey' in message) {
        state = { ...state, senderIdentityPublicKey: message.senderIdentityPublicKey };
      } else if ('offer' in message) {
        state = { ...state, offer: message.offer };
      } else {
        envelope = message.envelope;
      }
      return Promise.resolve(true);
    },
    claimEnvelope: () => Promise.resolve(envelope),
  };

  return {
    client,
    published,
    get state() {
      return state;
    },
    get envelope() {
      return envelope;
    },
    /** What the promoted Server does: offer an ephemeral key to the sender. */
    offer() {
      const sender = state?.senderIdentityPublicKey;
      if (sender === undefined || addressed === null) throw new Error('no identity announced yet');
      const receiver = createKeyHandoffReceiver(addressed, sender);
      state = { ...state!, offer: receiver.offer };
      envelope = null;
      return receiver;
    },
    retarget(next: KeyHandoffBinding | null) {
      addressed = next;
      state = next === null ? null : { binding: next };
      envelope = null;
    },
  };
}

const responderFor = (
  client: SecretKeyHandoffClient,
  overrides: Partial<SecretKeyHandoffResponderDeps> = {},
) =>
  createSecretKeyHandoffResponder({
    client,
    readKeyMaterial: () => KEY,
    ...overrides,
  });

describe('self-update secret-key handoff responder', () => {
  it('announces an identity, seals the key to the offer, and stops', async () => {
    const updater = relay();
    const responder = responderFor(updater.client);

    expect(await responder.step()).toBe('announced');
    expect(await responder.step()).toBe('awaiting-offer');

    const receiver = updater.offer();
    expect(await responder.step()).toBe('handed-off');
    // Answering an offer once is the whole job; nothing keeps re-encrypting.
    expect(await responder.step()).toBe('exhausted');

    receiver.accept(updater.envelope!);
    await receiver.use(async (key) => {
      expect(key.toString()).toBe(KEY);
    });
  });

  it('does nothing at all while no update has a candidate', async () => {
    const updater = relay(null);
    const responder = responderFor(updater.client);
    expect(await responder.step()).toBe('idle');
    expect(updater.published).toEqual([]);
  });

  it('hands over nothing while this Server is sealed', async () => {
    const updater = relay();
    const responder = responderFor(updater.client, { readKeyMaterial: () => undefined });

    expect(await responder.step()).toBe('announced');
    updater.offer();
    expect(await responder.step()).toBe('locked');
    expect(updater.envelope).toBeNull();
  });

  /**
   * A Server that no longer holds the control plane is on its way out, and the
   * key it still has in memory is not its to pass on.
   */
  it('hands over nothing once this Server is no longer the active one', async () => {
    const updater = relay();
    let active = true;
    const responder = responderFor(updater.client, { isActive: () => active });

    expect(await responder.step()).toBe('announced');
    active = false;
    updater.offer();
    expect(await responder.step()).toBe('inactive');
    expect(updater.envelope).toBeNull();
  });

  it('answers a restarted standby with a key sealed to its new offer', async () => {
    const updater = relay();
    const responder = responderFor(updater.client);
    await responder.step();
    const abandoned = updater.offer();
    await responder.step();
    const first = updater.envelope!;

    // The standby restarted: its ephemeral private key is gone, so it offers
    // again and the previous envelope is worthless.
    const restarted = updater.offer();
    expect(await responder.step()).toBe('handed-off');
    expect(updater.envelope).not.toEqual(first);

    restarted.accept(updater.envelope!);
    await restarted.use(async (key) => {
      expect(key.toString()).toBe(KEY);
    });
    // The abandoned receiver still cannot open what was sealed for it later.
    expect(() => abandoned.accept(updater.envelope!)).toThrow();
  });

  it('stops encrypting the live key after enough offers from one update', async () => {
    const updater = relay();
    const responder = responderFor(updater.client, { maxSealsPerOperation: 2 });
    await responder.step();

    updater.offer();
    expect(await responder.step()).toBe('handed-off');
    updater.offer();
    expect(await responder.step()).toBe('handed-off');
    updater.offer();
    expect(await responder.step()).toBe('exhausted');
  });

  /**
   * The mailbox refuses an envelope whose offer it no longer holds. Reporting
   * that as a handoff would tell the operator the next generation comes up
   * unlocked when it does not, and would burn the offer for good.
   */
  it('reports a refused envelope as refused, and answers the offer again', async () => {
    const updater = relay();
    let refuse = true;
    const responder = responderFor({
      ...updater.client,
      publish: (message) =>
        refuse && 'envelope' in message ? Promise.resolve(false) : updater.client.publish(message),
    });
    await responder.step();
    const receiver = updater.offer();

    expect(await responder.step()).toBe('refused');
    expect(updater.envelope).toBeNull();

    refuse = false;
    expect(await responder.step()).toBe('handed-off');
    receiver.accept(updater.envelope!);
    await receiver.use(async (key) => {
      expect(key.toString()).toBe(KEY);
    });
  });

  /** A refusal still costs a seal, so a mailbox that never takes one gives up. */
  it('stops re-sealing for an offer the mailbox keeps refusing', async () => {
    const updater = relay();
    const responder = responderFor(
      {
        ...updater.client,
        publish: (m) => ('envelope' in m ? Promise.resolve(false) : updater.client.publish(m)),
      },
      { maxSealsPerOperation: 2 },
    );
    await responder.step();
    updater.offer();

    expect(await responder.step()).toBe('refused');
    expect(await responder.step()).toBe('refused');
    expect(await responder.step()).toBe('exhausted');
  });

  it('signs with a fresh identity for each update', async () => {
    const updater = relay();
    const responder = responderFor(updater.client);
    await responder.step();
    const first = updater.state?.senderIdentityPublicKey;

    updater.retarget(successor);
    expect(await responder.step()).toBe('announced');
    const second = updater.state?.senderIdentityPublicKey;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('re-announces when the Updater no longer holds its identity', async () => {
    const updater = relay();
    const responder = responderFor(updater.client);
    await responder.step();
    const announced = updater.state?.senderIdentityPublicKey;

    // Same binding, but the relay was cleared — the identity has to go back.
    updater.retarget(binding);
    expect(await responder.step()).toBe('announced');
    expect(updater.state?.senderIdentityPublicKey).toBe(announced);
  });

  it('propagates a transport failure instead of pretending it handed over', async () => {
    const updater = relay();
    const failing: SecretKeyHandoffClient = {
      ...updater.client,
      read: () => Promise.reject(new Error('updater is unavailable')),
    };
    const responder = responderFor(failing);
    await expect(responder.step()).rejects.toThrow('updater is unavailable');
  });

  it('forgets its identity and its progress when stopped', async () => {
    const updater = relay();
    const responder = responderFor(updater.client);
    await responder.step();
    const first = updater.state?.senderIdentityPublicKey;

    responder.stop();
    expect(await responder.step()).toBe('announced');
    expect(updater.state?.senderIdentityPublicKey).not.toBe(first);
  });

  /**
   * Reading the mailbox is a round trip, and the fence can go against this
   * process inside it. A step that started while active must not come back and
   * seal anyway — that is precisely the moment the fence exists to catch.
   */
  it('hands over nothing when it loses the control plane mid-step', async () => {
    const updater = relay();
    let active = true;
    const held: { promise?: Promise<void> } = {};
    const responder = responderFor(
      {
        ...updater.client,
        read: async () => {
          const state = await updater.client.read();
          await held.promise;
          return state;
        },
      },
      { isActive: () => active },
    );

    expect(await responder.step()).toBe('announced');
    updater.offer();

    let release = (): void => undefined;
    held.promise = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const stepping = responder.step();
    active = false;
    release();

    expect(await stepping).toBe('inactive');
    expect(updater.envelope).toBeNull();
  });

  it('hands over nothing when it is stopped mid-step', async () => {
    const updater = relay();
    const held: { promise?: Promise<void> } = {};
    const responder = responderFor({
      ...updater.client,
      read: async () => {
        const state = await updater.client.read();
        await held.promise;
        return state;
      },
    });

    expect(await responder.step()).toBe('announced');
    updater.offer();

    let release = (): void => undefined;
    held.promise = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const stepping = responder.step();
    responder.stop();
    release();

    expect(await stepping).toBe('inactive');
    expect(updater.envelope).toBeNull();
  });

  /**
   * The publication is the one step a stop cannot undo. What matters then is
   * that the outcome stays truthful: the successor holds a key it can use, and
   * calling that anything but a handoff would leave the operator expecting a
   * master-password prompt that never comes.
   */
  it('reports a handoff whose publication outlived the stop', async () => {
    const updater = relay();
    const held: { promise?: Promise<void> } = {};
    let publishing = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      publishing = () => resolve();
    });
    const responder = responderFor({
      ...updater.client,
      publish: async (message) => {
        const published = await updater.client.publish(message);
        if ('envelope' in message) {
          publishing();
          await held.promise;
        }
        return published;
      },
    });

    expect(await responder.step()).toBe('announced');
    const receiver = updater.offer();

    let release = (): void => undefined;
    held.promise = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const stepping = responder.step();
    // Only once the envelope has left, which is the point of no return.
    await reached;
    responder.stop();
    release();

    expect(await stepping).toBe('handed-off');
    receiver.accept(updater.envelope!);
    await receiver.use(async (key) => {
      expect(key.toString()).toBe(KEY);
    });
  });

  it('does not leave the key material in a buffer it allocated', async () => {
    const updater = relay();
    const buffers: Buffer[] = [];
    const from = Buffer.from.bind(Buffer);
    const spy = vi.spyOn(Buffer, 'from').mockImplementation(((...args: [string]) => {
      const result = from(...args);
      if (args[0] === KEY) buffers.push(result);
      return result;
    }) as typeof from);
    try {
      const responder = responderFor(updater.client);
      await responder.step();
      updater.offer();
      expect(await responder.step()).toBe('handed-off');
    } finally {
      spy.mockRestore();
    }
    expect(buffers).toHaveLength(1);
    expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
  });
});

/** Wait for a state rather than for a number of polls. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('self-update secret-key handoff responder loop', () => {
  /**
   * The one step worth telling the operator about: it is the difference between
   * the next generation coming up unlocked and coming up at a password prompt,
   * and it is what the live smoke waits for before it cuts over.
   */
  it('reports a completed seal, and only a completed seal', async () => {
    const updater = relay();
    let sealed = 0;
    const loop = startSecretKeyHandoffResponder({
      client: updater.client,
      readKeyMaterial: () => KEY,
      idleIntervalMs: 1,
      activeIntervalMs: 1,
      onHandedOff: () => {
        sealed += 1;
      },
    });
    try {
      await until(() => updater.state?.senderIdentityPublicKey !== undefined, 'the identity');
      // Announcing and then waiting for an offer are not a handoff.
      expect(sealed).toBe(0);

      const receiver = updater.offer();
      await until(() => updater.envelope !== null, 'the envelope');
      receiver.accept(updater.envelope!);
      await receiver.use(async (key) => {
        expect(key.toString()).toBe(KEY);
      });

      // Every later poll finds the offer already answered, so the count stands.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sealed).toBe(1);
    } finally {
      loop.stop();
    }
  });

  it('keeps polling through a failing step instead of reporting one', async () => {
    const updater = relay();
    const errors: unknown[] = [];
    let reads = 0;
    const loop = startSecretKeyHandoffResponder({
      client: {
        ...updater.client,
        read: () => {
          reads += 1;
          return reads <= 2
            ? Promise.reject(new Error('updater is unavailable'))
            : updater.client.read();
        },
      },
      readKeyMaterial: () => KEY,
      idleIntervalMs: 1,
      activeIntervalMs: 1,
      onHandedOff: () => {
        throw new Error('nothing was sealed');
      },
      onError: (error) => errors.push(error),
    });
    try {
      await until(() => updater.state?.senderIdentityPublicKey !== undefined, 'the identity');
      expect(errors).toHaveLength(2);
    } finally {
      loop.stop();
    }
  });
});
