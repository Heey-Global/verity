import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createDevicePairingManager, DevicePairingRejectedError } from './device-pairing.js';

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519');
  let instant = new Date('2026-08-29T12:00:00.000Z');
  let consumedHash: string | undefined;
  const manager = createDevicePairingManager({
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
    expiresAt: '2026-08-29T12:15:00.000Z',
    now: () => instant,
    random: () => Buffer.alloc(32, 7),
    loadConsumedCodeHash: () => consumedHash,
    storeConsumedCodeHash: (hash) => {
      consumedHash = hash;
      return true;
    },
  });
  return { manager, advance: (value: string) => (instant = new Date(value)) };
}

describe('device pairing', () => {
  it('redeems the installer code once and consumes the bootstrap token once', () => {
    const { manager } = fixture();
    const issued = manager.redeem('abcdefghijklmnopqrstuvwxyz_0123456789');
    expect(issued.bootstrapToken).toHaveLength(43);
    expect(manager.consumeBootstrap(issued.bootstrapToken)).toBe(true);
    expect(manager.consumeBootstrap(issued.bootstrapToken)).toBe(false);
    expect(() => manager.redeem('abcdefghijklmnopqrstuvwxyz_0123456789')).toThrow(
      DevicePairingRejectedError,
    );
  });

  it('does not let a wrong presentation burn the valid bootstrap token', () => {
    const { manager } = fixture();
    const issued = manager.redeem('abcdefghijklmnopqrstuvwxyz_0123456789');
    expect(manager.consumeBootstrap('wrong')).toBe(false);
    expect(manager.consumeBootstrap(issued.bootstrapToken)).toBe(true);
    expect(manager.consumeBootstrap(issued.bootstrapToken)).toBe(false);
  });

  it('accepts a newly installed code without restarting while keeping replay protection', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    let pairingCode = 'abcdefghijklmnopqrstuvwxyz_0123456789';
    let consumedHash: string | undefined;
    const manager = createDevicePairingManager({
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      loadPairingMaterial: () => ({
        pairingCode,
        expiresAt: '2026-08-29T12:15:00.000Z',
      }),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      loadConsumedCodeHash: () => consumedHash,
      storeConsumedCodeHash: (hash) => {
        consumedHash = hash;
        return true;
      },
    });
    manager.redeem(pairingCode);
    expect(() => manager.redeem(pairingCode)).toThrow(DevicePairingRejectedError);
    pairingCode = 'new_abcdefghijklmnopqrstuvwxyz_012345';
    expect(manager.redeem(pairingCode).bootstrapToken).toHaveLength(43);
  });

  it('refuses configuration without durable consumed-code persistence', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      createDevicePairingManager({
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
        expiresAt: '2026-08-29T12:15:00.000Z',
      }),
    ).toThrow(/durable consumed-code persistence/);
  });

  it('rejects an already redeemed installer code after a process restart', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const options = {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
      expiresAt: '2026-08-29T12:15:00.000Z',
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    };
    let persistedHash: string | undefined;
    const persistentOptions = {
      loadConsumedCodeHash: () => persistedHash,
      storeConsumedCodeHash: (hash: string) => {
        persistedHash = hash;
        return true;
      },
    };
    createDevicePairingManager({ ...options, ...persistentOptions }).redeem(options.pairingCode);
    const restarted = createDevicePairingManager({ ...options, ...persistentOptions });
    expect(() => restarted.redeem(options.pairingCode)).toThrow(DevicePairingRejectedError);
  });

  it('retains the full consumed-code history across rotations and restart', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    let pairingCode = 'abcdefghijklmnopqrstuvwxyz_0123456789';
    const history: string[] = [];
    const options = {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      loadPairingMaterial: () => ({
        pairingCode,
        expiresAt: '2026-08-29T12:15:00.000Z',
      }),
      loadConsumedCodeHash: () => history,
      storeConsumedCodeHash: (hash: string) => {
        history.push(hash);
        return true;
      },
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    };
    const manager = createDevicePairingManager(options);
    manager.redeem(pairingCode);
    pairingCode = 'new_abcdefghijklmnopqrstuvwxyz_012345';
    manager.redeem(pairingCode);
    pairingCode = 'abcdefghijklmnopqrstuvwxyz_0123456789';
    expect(() => createDevicePairingManager(options).redeem(pairingCode)).toThrow(
      DevicePairingRejectedError,
    );
  });

  it('allows only one process to win an atomic persistence race', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const consumed = new Set<string>();
    const options = {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      pairingCode: 'abcdefghijklmnopqrstuvwxyz_0123456789',
      expiresAt: '2026-08-29T12:15:00.000Z',
      now: () => new Date('2026-08-29T12:00:00.000Z'),
      loadConsumedCodeHash: () => [],
      storeConsumedCodeHash: (hash: string) => {
        if (consumed.has(hash)) return false;
        consumed.add(hash);
        return true;
      },
    };
    const first = createDevicePairingManager(options);
    const second = createDevicePairingManager(options);

    expect(first.redeem(options.pairingCode).bootstrapToken).toHaveLength(43);
    expect(() => second.redeem(options.pairingCode)).toThrow(DevicePairingRejectedError);
  });

  it('rejects expired installer and bootstrap capabilities', () => {
    const first = fixture();
    first.advance('2026-08-29T12:15:00.000Z');
    expect(() => first.manager.redeem('abcdefghijklmnopqrstuvwxyz_0123456789')).toThrow(
      DevicePairingRejectedError,
    );
    const second = fixture();
    const issued = second.manager.redeem('abcdefghijklmnopqrstuvwxyz_0123456789');
    second.advance('2026-08-29T12:05:00.000Z');
    expect(second.manager.consumeBootstrap(issued.bootstrapToken)).toBe(false);
  });

  it('signs a challenge under the stable advertised identity', () => {
    const { manager } = fixture();
    const challenge = 'abcdefghijklmnopqrstuvwxyz_012345';
    const identity = manager.identity();
    const signed = manager.signChallenge(challenge);
    expect(signed.serverId).toBe(identity.serverId);
    const publicKey = {
      key: Buffer.from(identity.identityKey, 'base64url'),
      format: 'der' as const,
      type: 'spki' as const,
    };
    expect(
      verify(
        null,
        Buffer.from(`verity.device-pairing.v1\0${identity.serverId}\0${challenge}`),
        publicKey,
        Buffer.from(signed.signature, 'base64url'),
      ),
    ).toBe(true);
  });
});
