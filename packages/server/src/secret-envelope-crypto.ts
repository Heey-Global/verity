import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import {
  canonicalJson,
  secretEnvelopeSchema,
  type RunGrantClaims,
  type RunGrantRedemption,
  type SecretEnvelope,
} from '@verity/secret-contracts';

import { secretEnvelopeAad, secretEnvelopeAadHash } from './secret-grant-broker.js';

/**
 * Real Brokered Secrets envelope cryptography (concept §"Ende-zu-Ende an die Job-Instanz",
 * ADR 0009). The broker seals each resolved secret set into a one-shot envelope addressed to a
 * single job's ephemeral X25519 recipient key; only that job can open it. The cipher suite is
 * the one frozen in the contract, `x25519-hkdf-sha256-aes-256-gcm`:
 *
 *   1. KEM   — a fresh ephemeral X25519 keypair per envelope; the shared secret is
 *              X25519(skE, pkR). `enc = pkE` travels in the envelope as `ephemeralPublicKey`.
 *   2. KDF   — HKDF-SHA256 over the shared secret, with a domain-separated `info` that pins the
 *              suite label, `enc`, the recipient public key, and the AAD hash, yielding a 32-byte
 *              AES-256 key. Binding `enc`/`pkR` into the KDF context defeats key-reuse and
 *              identity-misbinding across envelopes.
 *   3. AEAD  — AES-256-GCM with a 12-byte nonce. The associated data is the FULL AAD pre-image
 *              ({@link secretEnvelopeAad}), so the 16-byte GCM tag authenticates the entire
 *              grant/job/workload context, not just its hash. Any tamper — ciphertext, nonce,
 *              ephemeral key, or a single differing context field — fails the tag and the open
 *              throws. Nothing is returned on a bad tag: the scheme is fail-closed.
 *
 * The payload is a canonical, sorted serialization of the resolved secret map. Wire bytes are
 * pinned by golden vectors in the test suite; changing any framing here must change those
 * vectors deliberately, which is the guard against an accidental format drift.
 *
 * Only `node:crypto` primitives are used — no new dependency and no bespoke field arithmetic.
 */

const SUITE = 'x25519-hkdf-sha256-aes-256-gcm';
const AES_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const X25519_KEY_BYTES = 32;

// DER wrappers for raw X25519 keys. X25519 SubjectPublicKeyInfo and PKCS#8
// PrivateKeyInfo have fixed-length prefixes, so raw <-> KeyObject is a slice/concat.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** An X25519 keypair as raw 32-byte values (never DER/PEM at rest in the broker). */
export interface RawX25519KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function assertLen(name: string, value: Uint8Array, bytes: number): void {
  if (value.length !== bytes) {
    throw new Error(`verity: ${name} must be exactly ${bytes} bytes, got ${value.length}`);
  }
}

export function generateRecipientKeyPair(): RawX25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: rawPrivateKey(privateKey),
    publicKey: rawPublicKey(publicKey),
  };
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'spki' });
  return Uint8Array.prototype.slice.call(der, SPKI_PREFIX.length);
}

function rawPrivateKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return Uint8Array.prototype.slice.call(
    der,
    PKCS8_PREFIX.length,
    PKCS8_PREFIX.length + X25519_KEY_BYTES,
  );
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  assertLen('X25519 public key', raw, X25519_KEY_BYTES);
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  assertLen('X25519 private key', raw, X25519_KEY_BYTES);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Derive the AES-256 content key from the KEM shared secret. `info` binds the suite label plus
 * both public keys and the AAD hash so a key derived for one (enc, recipient, context) triple can
 * never be reused for another. Salt is empty by design (the shared secret is already high-entropy
 * and single-use); the binding lives in `info`.
 */
function deriveContentKey(
  sharedSecret: Uint8Array,
  enc: Uint8Array,
  recipientPub: Uint8Array,
  aadHash: string,
): Buffer {
  const info = Buffer.concat([
    Buffer.from(`verity.secret-envelope-hkdf.v1\0${SUITE}\0`),
    Buffer.from(enc),
    Buffer.from(recipientPub),
    Buffer.from(aadHash, 'hex'),
  ]);
  const derived = hkdfSync('sha256', sharedSecret, new Uint8Array(0), info, AES_KEY_BYTES);
  return Buffer.from(derived);
}

/** Canonical, sorted plaintext for the resolved secret map. Values are base64 so binary is exact. */
export function encodeSecretPayload(secrets: ReadonlyMap<string, Uint8Array>): Buffer {
  const entries = [...secrets.entries()]
    .map(([target, value]) => ({ target, value: Buffer.from(value).toString('base64') }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  if (new Set(entries.map((entry) => entry.target)).size !== entries.length) {
    throw new Error('verity: duplicate secret target in payload');
  }
  return Buffer.from(canonicalJson({ protocolVersion: 1, entries }), 'utf8');
}

export function decodeSecretPayload(plaintext: Buffer): Map<string, Uint8Array> {
  const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error('verity: malformed secret payload');
  }
  const out = new Map<string, Uint8Array>();
  for (const entry of (parsed as { entries: unknown[] }).entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { target?: unknown }).target !== 'string' ||
      typeof (entry as { value?: unknown }).value !== 'string'
    ) {
      throw new Error('verity: malformed secret payload entry');
    }
    const { target, value } = entry as { target: string; value: string };
    if (out.has(target)) throw new Error('verity: duplicate secret target in payload');
    out.set(target, new Uint8Array(Buffer.from(value, 'base64')));
  }
  return out;
}

/** Deterministic test seams: production injects none and gets fresh randomness each time. */
export interface SealSeams {
  generateEphemeral?: () => RawX25519KeyPair;
  generateNonce?: () => Uint8Array;
  generateEnvelopeId?: () => string;
}

/**
 * Seal a resolved secret set into a one-shot envelope for exactly the job named by `redemption`.
 * `resolveRecipientPublicKey` maps the workload's `publicKeyId` to its raw X25519 public key; a
 * missing or mismatched key aborts (fail-closed) rather than sealing to an unknown recipient. The
 * returned envelope is re-validated against the wire schema before it leaves the sealer.
 */
export function createSecretEnvelopeSealer(options: {
  resolveRecipientPublicKey: (
    recipientKeyId: string,
    jobId: string,
  ) => Promise<Uint8Array | undefined>;
  seams?: SealSeams;
}) {
  const seams = options.seams ?? {};
  return async function sealEnvelope(
    claims: RunGrantClaims,
    redemption: RunGrantRedemption,
    secrets: ReadonlyMap<string, Uint8Array>,
  ): Promise<SecretEnvelope> {
    const recipientKeyId = redemption.workload.publicKeyId;
    const recipientPub = await options.resolveRecipientPublicKey(recipientKeyId, redemption.jobId);
    if (recipientPub === undefined) {
      throw new Error('verity: unknown envelope recipient key');
    }
    assertLen('X25519 recipient public key', recipientPub, X25519_KEY_BYTES);

    const ephemeral = seams.generateEphemeral?.() ?? generateRecipientKeyPair();
    const nonce = seams.generateNonce?.() ?? new Uint8Array(randomBytes(NONCE_BYTES));
    assertLen('envelope nonce', nonce, NONCE_BYTES);

    const aad = secretEnvelopeAad(claims, redemption);
    const aadHash = secretEnvelopeAadHash(claims, redemption);
    const sharedSecret = diffieHellman({
      privateKey: privateKeyFromRaw(ephemeral.privateKey),
      publicKey: publicKeyFromRaw(recipientPub),
    });
    const contentKey = deriveContentKey(sharedSecret, ephemeral.publicKey, recipientPub, aadHash);

    const cipher = createCipheriv('aes-256-gcm', contentKey, Buffer.from(nonce));
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(encodeSecretPayload(secrets)), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: SecretEnvelope = {
      protocolVersion: 1,
      envelopeId: seams.generateEnvelopeId?.() ?? `env-${randomBytes(16).toString('hex')}`,
      grantId: claims.grantId,
      jobId: redemption.jobId,
      recipientKeyId,
      algorithm: SUITE,
      ephemeralPublicKey: Buffer.from(ephemeral.publicKey).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      aadHash,
      ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
      expiresAt: claims.expiresAt,
    };
    return secretEnvelopeSchema.parse(envelope);
  };
}

export class SecretEnvelopeOpenError extends Error {}

/**
 * Recipient-side open: the job authenticates and decrypts an envelope with its own X25519 private
 * key and the claims/redemption it already holds. It re-derives the AAD locally (never trusting the
 * envelope's own hash as authority), rejects any grant/job/recipient/suite mismatch, enforces the
 * expiry, and lets the GCM tag be the final authority — a bad tag throws {@link SecretEnvelopeOpenError}
 * and no plaintext is returned. This is the exact inverse of {@link createSecretEnvelopeSealer}.
 */
export function openSecretEnvelope(
  envelope: SecretEnvelope,
  context: {
    claims: RunGrantClaims;
    redemption: RunGrantRedemption;
    recipientPrivateKey: Uint8Array;
    now?: () => Date;
  },
): Map<string, Uint8Array> {
  const parsed = secretEnvelopeSchema.parse(envelope);
  const { claims, redemption } = context;
  const now = context.now?.() ?? new Date();

  if (parsed.algorithm !== SUITE) throw new SecretEnvelopeOpenError('unsupported envelope suite');
  if (parsed.grantId !== claims.grantId) throw new SecretEnvelopeOpenError('grant mismatch');
  if (parsed.jobId !== redemption.jobId) throw new SecretEnvelopeOpenError('job mismatch');
  if (parsed.recipientKeyId !== redemption.workload.publicKeyId) {
    throw new SecretEnvelopeOpenError('recipient key mismatch');
  }
  // Freshness is gated on the grant's authoritative expiry (which the recipient trusts and which
  // the AAD authenticates), never on the envelope's own mutable copy. Require the wire field to
  // match it exactly so a tampered expiresAt is rejected outright rather than silently ignored.
  if (parsed.expiresAt !== claims.expiresAt) throw new SecretEnvelopeOpenError('expiry mismatch');
  if (Date.parse(claims.expiresAt) <= now.getTime()) {
    throw new SecretEnvelopeOpenError('envelope expired');
  }

  const aad = secretEnvelopeAad(claims, redemption);
  const expectedAadHash = secretEnvelopeAadHash(claims, redemption);
  const envAadHash = Buffer.from(parsed.aadHash, 'hex');
  const localAadHash = Buffer.from(expectedAadHash, 'hex');
  if (envAadHash.length !== localAadHash.length || !timingSafeEqual(envAadHash, localAadHash)) {
    throw new SecretEnvelopeOpenError('aad mismatch');
  }

  // Everything below derives from attacker-controlled envelope bytes (ephemeral key, nonce,
  // ciphertext). Keep it all inside one try so a malformed or low-order key, a bad base64 field,
  // or a failed tag surfaces uniformly as SecretEnvelopeOpenError — never a generic throw and
  // never partial plaintext.
  try {
    const enc = new Uint8Array(Buffer.from(parsed.ephemeralPublicKey, 'base64'));
    const recipientPub = publicKeyFromKeyObjectRaw(context.recipientPrivateKey);
    const sharedSecret = diffieHellman({
      privateKey: privateKeyFromRaw(context.recipientPrivateKey),
      publicKey: publicKeyFromRaw(enc),
    });
    const contentKey = deriveContentKey(sharedSecret, enc, recipientPub, expectedAadHash);

    const raw = Buffer.from(parsed.ciphertext, 'base64');
    if (raw.length < GCM_TAG_BYTES + 1) throw new SecretEnvelopeOpenError('ciphertext too short');
    const tag = raw.subarray(raw.length - GCM_TAG_BYTES);
    const body = raw.subarray(0, raw.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      contentKey,
      Buffer.from(parsed.nonce, 'base64'),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return decodeSecretPayload(plaintext);
  } catch (error) {
    if (error instanceof SecretEnvelopeOpenError) throw error;
    throw new SecretEnvelopeOpenError('authentication failed');
  }
}

/** Recover a recipient's raw X25519 public key from its raw private key. */
export function publicKeyFromKeyObjectRaw(rawPrivate: Uint8Array): Uint8Array {
  return rawPublicKey(createPublicKey(privateKeyFromRaw(rawPrivate)));
}
