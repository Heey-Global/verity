import { describe, expect, it } from 'vitest';
import { createPassthroughCipher, createSecretCipher, isEncrypted } from './crypto.js';

// Test-only 32-byte key, built at runtime (hex + base64 forms of the SAME
// bytes). Constructed rather than written as a literal so no secret-shaped
// string lands in source — these are not real secrets.
const KEY_BYTES = Buffer.alloc(32, 0x11);
const HEX_KEY = KEY_BYTES.toString('hex');
const B64_KEY = KEY_BYTES.toString('base64');

describe('createSecretCipher', () => {
  it('round-trips a secret through the enc:v1 envelope', () => {
    const cipher = createSecretCipher(HEX_KEY);
    const plaintext = 'ssh-private-key-fixture-value\nline2\n';
    const stored = cipher.encrypt(plaintext);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(plaintext);
    expect(cipher.decrypt(stored)).toBe(plaintext);
  });

  it('produces a fresh ciphertext each time (random IV)', () => {
    const cipher = createSecretCipher(HEX_KEY);
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same');
    expect(cipher.decrypt(b)).toBe('same');
  });

  it('accepts a base64-encoded 32-byte key equivalently to hex', () => {
    const stored = createSecretCipher(HEX_KEY).encrypt('secret');
    // A cipher built from the same key material (base64 form) decrypts it.
    expect(createSecretCipher(B64_KEY).decrypt(stored)).toBe('secret');
  });

  it('passes non-enveloped (plaintext) values through unchanged on decrypt', () => {
    const cipher = createSecretCipher(HEX_KEY);
    expect(cipher.decrypt('plain-doppler-token-value')).toBe('plain-doppler-token-value');
  });

  it('fails closed on a tampered ciphertext (GCM auth tag)', () => {
    const cipher = createSecretCipher(HEX_KEY);
    const stored = cipher.encrypt('secret');
    // Flip the last ciphertext byte and re-envelope — GCM auth must reject it.
    const rawBuf = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
    const last = rawBuf.length - 1;
    rawBuf.writeUInt8(rawBuf.readUInt8(last) ^ 0xff, last);
    const flipped = 'enc:v1:' + rawBuf.toString('base64');
    expect(() => cipher.decrypt(flipped)).toThrow();
  });

  it('cannot decrypt a secret written under a different key', () => {
    const stored = createSecretCipher(HEX_KEY).encrypt('secret');
    const otherKey = Buffer.alloc(32, 0x22).toString('hex');
    expect(() => createSecretCipher(otherKey).decrypt(stored)).toThrow();
  });

  it('rejects key material that is not 32 bytes', () => {
    expect(() => createSecretCipher('too-short')).toThrow(/32 bytes/);
    expect(() => createSecretCipher('abcd')).toThrow(/32 bytes/);
  });
});

describe('createPassthroughCipher', () => {
  it('encrypts as a plaintext passthrough', () => {
    const cipher = createPassthroughCipher();
    expect(cipher.encrypt('secret')).toBe('secret');
    expect(isEncrypted(cipher.encrypt('secret'))).toBe(false);
  });

  it('returns plaintext values unchanged on decrypt', () => {
    expect(createPassthroughCipher().decrypt('plain')).toBe('plain');
  });

  it('throws on decrypt of an enveloped value (key was lost / misconfigured)', () => {
    const stored = createSecretCipher(HEX_KEY).encrypt('secret');
    expect(() => createPassthroughCipher().decrypt(stored)).toThrow(/no encryption key is loaded/);
  });
});
