import { describe, expect, it, vi } from 'vitest';

import {
  createKeyHandoffReceiver,
  createKeyHandoffSenderIdentity,
  sealUnlockedKey,
} from './secret-key-handoff.js';

const binding = {
  operationId: 'update-1',
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  containerId: 'b'.repeat(64),
};
const sender = createKeyHandoffSenderIdentity();

const receiver = () => createKeyHandoffReceiver(binding, sender.publicKey);
const seal = (key: Buffer, offer: ReturnType<typeof receiver>['offer']) =>
  sealUnlockedKey(key, offer, sender);

describe('self-update secret-key handoff', () => {
  it('delivers the unlocked key only to the operation-bound receiver', async () => {
    const target = receiver();
    target.accept(seal(Buffer.from('unlocked-data-key'), target.offer));
    await expect(target.use(async (key) => key.toString())).resolves.toBe('unlocked-data-key');
  });

  /**
   * A holder that may not derive the key yet still has to know whether asking
   * for a replacement is worth it, so the verdict is available without opening
   * anything — and asking for it spends nothing.
   */
  it('settles an envelope without opening it or spending the offer', async () => {
    const target = receiver();
    const envelope = seal(Buffer.from('unlocked-data-key'), target.offer);
    target.verify(envelope);
    await expect(target.use(async (key) => key.toString())).rejects.toThrow('is not available');

    target.accept(envelope);
    await expect(target.use(async (key) => key.toString())).resolves.toBe('unlocked-data-key');
  });

  it('refuses an envelope addressed to another receiver before opening it', () => {
    const target = receiver();
    const other = receiver();
    expect(() => target.verify(seal(Buffer.from('key'), other.offer))).toThrow(
      'key handoff binding does not match',
    );
    expect(() =>
      target.verify({ ...seal(Buffer.from('key'), other.offer), nonce: target.offer.nonce }),
    ).toThrow('key handoff sender signature is invalid');
  });

  it('invalidates the single-use offer after tampering', () => {
    const target = receiver();
    const envelope = seal(Buffer.from('key'), target.offer);
    expect(() => target.accept({ ...envelope, operationId: 'update-2' })).toThrow(
      'key handoff binding does not match',
    );
    expect(() => target.accept(envelope)).toThrow('already been consumed');
  });

  it('bounds envelope bindings before canonical comparison', () => {
    const target = receiver();
    const envelope = seal(Buffer.from('key'), target.offer);
    expect(() => target.accept({ ...envelope, operationId: 'x'.repeat(100_000) })).toThrow(
      'key handoff operation id is invalid',
    );
  });

  it('rejects non-canonical or incorrectly sized receiver nonces before sealing', () => {
    const target = receiver();
    expect(() =>
      sealUnlockedKey(Buffer.from('key'), { ...target.offer, nonce: 'AA==' }, sender),
    ).toThrow('key handoff nonce is invalid');
    expect(() =>
      sealUnlockedKey(Buffer.from('key'), { ...target.offer, nonce: 'A'.repeat(100_000) }, sender),
    ).toThrow('key handoff nonce is invalid');
  });

  it('rejects ciphertext and receiver substitution', () => {
    const first = receiver();
    const second = receiver();
    const envelope = seal(Buffer.from('key'), first.offer);
    expect(() => second.accept({ ...envelope, nonce: second.offer.nonce })).toThrow(
      'key handoff sender signature is invalid',
    );

    const third = receiver();
    const tampered = seal(Buffer.from('key'), third.offer);
    expect(() =>
      third.accept({ ...tampered, ciphertext: Buffer.from('other').toString('base64') }),
    ).toThrow();
  });

  it('rejects truncated authentication tags', () => {
    const target = receiver();
    const envelope = seal(Buffer.from('key'), target.offer);
    expect(() =>
      target.accept({
        ...envelope,
        tag: Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64'),
      }),
    ).toThrow('key handoff sender signature is invalid');
  });

  it('zeroizes and permanently closes the activation slot', async () => {
    const target = receiver();
    target.accept(seal(Buffer.from('key'), target.offer));
    let observed: Buffer | undefined;
    await target.use(async (key) => {
      observed = key;
    });
    expect(observed).toEqual(Buffer.alloc(3));
    await expect(target.use(vi.fn())).rejects.toThrow('not available');
    target.destroy();
  });

  it('rejects envelopes from an untrusted sender identity', () => {
    const target = receiver();
    const attacker = createKeyHandoffSenderIdentity();
    const envelope = sealUnlockedKey(Buffer.from('key'), target.offer, attacker);
    expect(() => target.accept(envelope)).toThrow('key handoff sender is not trusted');
  });

  it('rejects tampering covered by the sender signature', () => {
    const target = receiver();
    const envelope = seal(Buffer.from('key'), target.offer);
    expect(() =>
      target.accept({ ...envelope, ciphertext: Buffer.from('other').toString('base64') }),
    ).toThrow('key handoff sender signature is invalid');
  });
});
