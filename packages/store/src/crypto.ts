import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Transparent at-rest encryption for secret columns (ADR 0002 D3: "DB is the
 * single source of truth, encrypted at rest"). Secret values are AES-256-GCM
 * encrypted with a deployment-held master key before they touch the database and
 * decrypted on read, so the DB never persists a plaintext secret.
 *
 * Envelope (versioned so the scheme can rotate): `enc:v1:<base64>` where the
 * base64 payload is `iv(12) || authTag(16) || ciphertext`. GCM's auth tag makes
 * a tampered ciphertext fail closed on decrypt.
 *
 * Any stored value WITHOUT the `enc:v1:` prefix is treated as plaintext and
 * returned unchanged on read. That keeps two things working: rows written before
 * encryption was enabled, and non-secret columns that share the code path. So
 * turning the key on is a zero-downtime change with no data migration — each
 * secret re-encrypts on its next write.
 */

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

export interface SecretCipher {
  /** Encrypt a plaintext secret into the `enc:v1:` envelope. */
  encrypt(plaintext: string): string;
  /** Decrypt an `enc:v1:` value; return non-enveloped (plaintext) values as-is. */
  decrypt(stored: string): string;
  /** Decrypt directly into owned, erasable bytes without creating a plaintext string. */
  decryptBytes(stored: string): Buffer;
}

/** True when a stored value is in the encrypted envelope. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Thrown when a secret is written or an encrypted value is read while the
 *  secret store is sealed (no key loaded — awaiting master-password unlock). */
export class SealedError extends Error {
  constructor(message = 'verity: secret store is sealed — unlock it with the master password') {
    super(message);
    this.name = 'SealedError';
  }
}

/**
 * A {@link SecretCipher} whose key can be loaded (unlock) and cleared (seal) at
 * runtime — the engine behind the master-password flow. Sealed by default.
 *
 * While sealed: `encrypt` throws {@link SealedError} (no secret is written
 * plaintext), and `decrypt` throws only for ENVELOPED values — non-enveloped
 * (plaintext) values still pass through, so a sealed server can still read
 * non-secret settings, only the actual secrets are unavailable until unlock.
 */
export interface SealableSecretCipher extends SecretCipher {
  isSealed(): boolean;
  /** Load a raw 32-byte key (hex or base64) — from a derived password or env. */
  unlock(keyMaterial: string): void;
  /** Drop the in-memory key; subsequent secret access seals again. */
  seal(): void;
  /**
   * The loaded key material, or undefined while sealed.
   *
   * Exists for exactly one caller: the self-update secret-key handoff (ADR 0008
   * D8), where the outgoing Server encrypts this to an ephemeral public key that
   * only its successor holds, so an update does not leave the new process
   * waiting for the master password. It grants no privilege that holding the
   * cipher does not already grant — anything with this object can already
   * decrypt every secret — but it does move the key somewhere it can be copied,
   * so nothing else should reach for it.
   */
  exportKeyMaterial(): string | undefined;
}

export function createSealableSecretCipher(): SealableSecretCipher {
  let inner: SecretCipher | undefined; // undefined === sealed
  let loaded: string | undefined;
  return {
    isSealed: (): boolean => inner === undefined,
    unlock(keyMaterial: string): void {
      inner = createSecretCipher(keyMaterial);
      // Only after createSecretCipher accepted it, so a rejected key never
      // becomes exportable.
      loaded = keyMaterial;
    },
    seal(): void {
      inner = undefined;
      loaded = undefined;
    },
    exportKeyMaterial: (): string | undefined => loaded,
    encrypt(plaintext: string): string {
      if (inner === undefined) throw new SealedError();
      return inner.encrypt(plaintext);
    },
    decrypt(stored: string): string {
      if (!isEncrypted(stored)) return stored; // plaintext passthrough, sealed or not
      if (inner === undefined) throw new SealedError();
      return inner.decrypt(stored);
    },
    decryptBytes(stored: string): Buffer {
      if (!isEncrypted(stored)) return Buffer.from(stored, 'utf8');
      if (inner === undefined) throw new SealedError();
      return inner.decryptBytes(stored);
    },
  };
}

/**
 * Build a cipher from raw key material. The key must decode to exactly 32 bytes
 * (AES-256): 64 hex chars, or base64 of 32 bytes. Anything else throws so a
 * mis-set key fails loudly at startup rather than silently weakening security.
 */
export function createSecretCipher(keyMaterial: string): SecretCipher {
  const key = decodeKey(keyMaterial);
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
    },
    decrypt(stored: string): string {
      if (!stored.startsWith(PREFIX)) return stored; // plaintext passthrough
      return Buffer.from(this.decryptBytes(stored)).toString('utf8');
    },
    decryptBytes(stored: string): Buffer {
      if (!stored.startsWith(PREFIX)) return Buffer.from(stored, 'utf8');
      const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
      if (raw.length < IV_LEN + TAG_LEN) {
        throw new Error('verity: malformed encrypted secret envelope (too short)');
      }
      const iv = raw.subarray(0, IV_LEN);
      const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
  };
}

/**
 * The cipher used when the store has no encryption key loaded (un-keyed / tests).
 * `encrypt` is a plaintext passthrough — identical to the pre-encryption
 * behaviour, so an un-keyed deployment is not a regression. `decrypt` refuses to
 * return a value that IS enveloped: that can only mean a key WAS configured,
 * secrets were encrypted with it, and it was then lost — failing loudly beats
 * leaking ciphertext into a git config / token file.
 */
export function createPassthroughCipher(): SecretCipher {
  return {
    encrypt: (plaintext: string): string => plaintext,
    decrypt: (stored: string): string => {
      if (stored.startsWith(PREFIX)) {
        throw new Error(
          'verity: found an encrypted secret but no encryption key is loaded — ' +
            'unlock the store with the master password that wrote it',
        );
      }
      return stored;
    },
    decryptBytes: (stored: string): Buffer => {
      if (stored.startsWith(PREFIX)) {
        throw new Error(
          'verity: found an encrypted secret but no encryption key is loaded — ' +
            'unlock the store with the master password that wrote it',
        );
      }
      return Buffer.from(stored, 'utf8');
    },
  };
}

function decodeKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  // Hex is checked first: a 64-char hex string is also valid base64 (decoding to
  // 48 bytes), so without this ordering it would be misread as base64.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32) return b64;
  throw new Error(
    'verity: the encryption key must be 32 bytes — 64 hex chars, or base64 of 32 bytes',
  );
}
