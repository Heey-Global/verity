import { randomBytes, scryptSync } from 'node:crypto';
import { createSecretCipher } from './crypto.js';

/**
 * Master-password key derivation for the secret store (ADR 0002 D3, the
 * master-password unlock flow layered on top of the {@link SecretCipher}).
 *
 * The operator's password is stretched with scrypt (Node built-in — no native
 * dependency) into the raw 32-byte AES key that unlocks the cipher. The key is
 * never persisted; only the non-secret salt + a verifier are. On unlock the
 * password is re-derived and checked against the verifier before the key is
 * trusted, so a wrong password is rejected without touching real secrets.
 */

// scrypt cost. N=2^16 with r=8 → ~64 MB, ~100 ms per derivation — appropriate
// for an infrequent unlock, comfortably above interactive-login minimums.
const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // must exceed 128*N*r bytes (~64 MB)
const KEY_LEN = 32;
const SALT_LEN = 16;

/** A fixed marker encrypted under the derived key; decrypting it back to this
 *  value on unlock proves the password is correct. */
const VERIFIER_PLAINTEXT = 'verity-secret-key-verifier-v1';

/** A fresh random salt (base64) — non-secret, persisted alongside the verifier. */
export function generateSalt(): string {
  return randomBytes(SALT_LEN).toString('base64');
}

/** Derive the raw 32-byte key (hex) from a password + stored salt. */
export function deriveKeyFromPassword(password: string, saltB64: string): string {
  const salt = Buffer.from(saltB64, 'base64');
  const key = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return key.toString('hex');
}

/** Build the verifier token to persist when a password is first set. */
export function createKeyVerifier(keyMaterial: string): string {
  return createSecretCipher(keyMaterial).encrypt(VERIFIER_PLAINTEXT);
}

/** True when `keyMaterial` decrypts the stored verifier back to the marker —
 *  i.e. the password (→ key) matches the one the verifier was created with. */
export function keyMatchesVerifier(keyMaterial: string, verifier: string): boolean {
  try {
    return createSecretCipher(keyMaterial).decrypt(verifier) === VERIFIER_PLAINTEXT;
  } catch {
    // Wrong key → GCM auth failure (or malformed) → not a match.
    return false;
  }
}
