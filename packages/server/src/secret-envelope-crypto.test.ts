import { describe, expect, it } from 'vitest';

import type { RunGrantClaims, RunGrantRedemption } from '@verity/secret-contracts';

import { createInMemorySecretGrantStore, createSecretGrantBroker } from './secret-grant-broker.js';
import {
  SecretEnvelopeOpenError,
  createSecretEnvelopeSealer,
  decodeSecretPayload,
  encodeSecretPayload,
  generateRecipientKeyPair,
  openSecretEnvelope,
  publicKeyFromKeyObjectRaw,
  type RawX25519KeyPair,
} from './secret-envelope-crypto.js';

const RECIPIENT_KEY_ID = 'key-1';

function claims(): RunGrantClaims {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: 'a'.repeat(64),
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile: { id: 'kubernetes-read', version: 1, policyHash: 'b'.repeat(64) },
    aliases: [{ id: 'alias-1', version: 1 }],
    providerBindings: [{ id: 'binding-1', version: 1, provider: 'doppler' }],
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-19T00:00:00Z',
    expiresAt: '2026-07-19T00:05:00Z',
    nonce: 'n'.repeat(32),
  };
}

function redemption(): RunGrantRedemption {
  return {
    protocolVersion: 1,
    grantId: 'grant-1',
    jobId: 'job-1',
    requestHash: 'a'.repeat(64),
    workload: {
      executorInstanceId: 'exec-1',
      jobId: 'job-1',
      publicKeyId: RECIPIENT_KEY_ID,
      attestationHash: 'c'.repeat(64),
    },
  };
}

function secrets(): Map<string, Uint8Array> {
  return new Map([
    ['TOKEN', new Uint8Array(Buffer.from('fake-secret-value'))],
    ['API_KEY', new Uint8Array([0, 1, 2, 255])],
  ]);
}

const now = () => new Date('2026-07-19T00:01:00Z');

function sealerFor(recipientPub: Uint8Array, seams = {}) {
  return createSecretEnvelopeSealer({
    resolveRecipientPublicKey: (id) =>
      Promise.resolve(id === RECIPIENT_KEY_ID ? recipientPub : undefined),
    seams,
  });
}

describe('secret envelope crypto', () => {
  it('round-trips the resolved secret map for exactly the addressed recipient', async () => {
    const recipient = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());

    expect(envelope.algorithm).toBe('x25519-hkdf-sha256-aes-256-gcm');
    expect(envelope.recipientKeyId).toBe(RECIPIENT_KEY_ID);
    // No plaintext secret ever appears on the wire envelope.
    expect(JSON.stringify(envelope)).not.toContain('fake-secret-value');

    const opened = openSecretEnvelope(envelope, {
      claims: claims(),
      redemption: redemption(),
      recipientPrivateKey: recipient.privateKey,
      now,
    });
    expect(Buffer.from(opened.get('TOKEN')!).toString()).toBe('fake-secret-value');
    expect([...opened.get('API_KEY')!]).toEqual([0, 1, 2, 255]);
  });

  it('encodes payloads canonically regardless of insertion order', () => {
    const a = new Map<string, Uint8Array>([
      ['B', new Uint8Array([2])],
      ['A', new Uint8Array([1])],
    ]);
    const b = new Map<string, Uint8Array>([
      ['A', new Uint8Array([1])],
      ['B', new Uint8Array([2])],
    ]);
    expect(encodeSecretPayload(a).toString('base64')).toBe(
      encodeSecretPayload(b).toString('base64'),
    );
    expect([...decodeSecretPayload(encodeSecretPayload(a)).keys()].sort()).toEqual(['A', 'B']);
  });

  it('refuses to seal to an unknown recipient key (fail-closed)', async () => {
    const seal = createSecretEnvelopeSealer({
      resolveRecipientPublicKey: () => Promise.resolve(undefined),
      seams: {},
    });
    await expect(seal(claims(), redemption(), secrets())).rejects.toThrow(
      'unknown envelope recipient key',
    );
  });

  it('fails closed when a different recipient key tries to open the envelope', async () => {
    const recipient = generateRecipientKeyPair();
    const attacker = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());

    expect(() =>
      openSecretEnvelope(envelope, {
        claims: claims(),
        redemption: redemption(),
        recipientPrivateKey: attacker.privateKey,
        now,
      }),
    ).toThrow(SecretEnvelopeOpenError);
  });

  it('fails closed on a tampered ciphertext, nonce, or ephemeral key', async () => {
    const recipient = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());
    const open = (patch: Partial<typeof envelope>) =>
      openSecretEnvelope(
        { ...envelope, ...patch },
        {
          claims: claims(),
          redemption: redemption(),
          recipientPrivateKey: recipient.privateKey,
          now,
        },
      );

    const flipped = Buffer.from(envelope.ciphertext, 'base64');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0x01, 0);
    expect(() => open({ ciphertext: flipped.toString('base64') })).toThrow('authentication failed');

    const otherNonce = Buffer.alloc(12, 0xab).toString('base64');
    expect(() => open({ nonce: otherNonce })).toThrow('authentication failed');

    const otherEphemeral = Buffer.from(generateRecipientKeyPair().publicKey).toString('base64');
    expect(() => open({ ephemeralPublicKey: otherEphemeral })).toThrow(SecretEnvelopeOpenError);
  });

  it('fails closed when the AAD context differs by a single field', async () => {
    const recipient = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());

    const tampered: RunGrantClaims = { ...claims(), projectId: 'project-2' };
    expect(() =>
      openSecretEnvelope(envelope, {
        claims: tampered,
        redemption: redemption(),
        recipientPrivateKey: recipient.privateKey,
        now,
      }),
    ).toThrow('aad mismatch');
  });

  it('rejects an expired envelope before decrypting', async () => {
    const recipient = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());
    expect(() =>
      openSecretEnvelope(envelope, {
        claims: claims(),
        redemption: redemption(),
        recipientPrivateKey: recipient.privateKey,
        now: () => new Date('2026-07-19T01:00:00Z'),
      }),
    ).toThrow('envelope expired');
  });

  it('cannot be life-extended by editing the wire expiresAt (freshness is claims-bound)', async () => {
    const recipient = generateRecipientKeyPair();
    const seal = sealerFor(recipient.publicKey);
    const envelope = await seal(claims(), redemption(), secrets());
    // Attacker pushes the envelope's own expiry far into the future. It must be rejected: the
    // wire field no longer matches the authoritative claims expiry, and freshness gates on the
    // latter regardless.
    const forged = { ...envelope, expiresAt: '2026-07-19T02:00:00Z' };
    expect(() =>
      openSecretEnvelope(forged, {
        claims: claims(),
        redemption: redemption(),
        recipientPrivateKey: recipient.privateKey,
        now: () => new Date('2026-07-19T01:00:00Z'),
      }),
    ).toThrow('expiry mismatch');
  });

  // Golden vectors pin the exact wire framing (KEM enc, nonce, AAD hash, ciphertext+tag) for a
  // fixed (recipient, ephemeral, nonce, payload) tuple. Any accidental change to the suite
  // composition, HKDF context, payload encoding, or AAD pre-image breaks these on purpose.
  it('matches frozen golden vectors', async () => {
    const skR = new Uint8Array(Buffer.alloc(32, 7));
    const skE = new Uint8Array(Buffer.alloc(32, 9));
    const pkR = publicKeyFromKeyObjectRaw(skR);
    const pkE = publicKeyFromKeyObjectRaw(skE);
    const nonce = new Uint8Array(Buffer.alloc(12, 3));
    const ephemeral: RawX25519KeyPair = { privateKey: skE, publicKey: pkE };

    const seal = sealerFor(pkR, {
      generateEphemeral: () => ephemeral,
      generateNonce: () => nonce,
      generateEnvelopeId: () => 'envelope-golden-1',
    });
    const envelope = await seal(claims(), redemption(), secrets());

    expect(envelope.ephemeralPublicKey).toBe('V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CE=');
    expect(envelope.nonce).toBe('AwMDAwMDAwMDAwMD');
    expect(envelope.aadHash).toBe(
      'ea64c5dd18006e0520973fbaf546a94787ac1f646535d648684ed5474bb202d7',
    );
    expect(envelope.ciphertext).toBe(
      '0GOkS2B0shbuV1MjrU1B5SDoSanH9kfxCJ6Z3LLo+aN6jscjMD7YrYxhxyYmUohcsgChjUYbg1oVeWsVa0vkvqb1pknamEczG7LTbi5T4V9sSoSIAQNjO45qIVinwmbqMY4wMMelZNC32Mf3plD01Ieaoec/rUHEATVa4KvzLoEcz4rw9KR7tCRz8Vdxu10=',
    );

    const opened = openSecretEnvelope(envelope, {
      claims: claims(),
      redemption: redemption(),
      recipientPrivateKey: skR,
      now,
    });
    expect(Buffer.from(opened.get('TOKEN')!).toString()).toBe('fake-secret-value');
  });

  it('passes the grant broker envelope context checks with the real sealer', async () => {
    const recipient = generateRecipientKeyPair();
    const broker = createSecretGrantBroker({
      store: createInMemorySecretGrantStore(),
      resolveSecrets: () => Promise.resolve(secrets()),
      sealEnvelope: sealerFor(recipient.publicKey),
      authorizeWorkload: () => Promise.resolve(true),
      authorizeCurrentClaims: () => Promise.resolve(true),
      now,
    });

    const issued = await broker.issue(claims());
    const envelope = await broker.redeem(issued.capability, redemption());

    const opened = openSecretEnvelope(envelope, {
      claims: claims(),
      redemption: redemption(),
      recipientPrivateKey: recipient.privateKey,
      now,
    });
    expect(Buffer.from(opened.get('TOKEN')!).toString()).toBe('fake-secret-value');
  });
});
