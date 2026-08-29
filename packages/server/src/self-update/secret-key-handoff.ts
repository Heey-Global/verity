import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const DIGEST = /^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const MAX_KEY_BYTES = 4096;

export interface KeyHandoffBinding {
  readonly operationId: string;
  readonly targetDigest: string;
  readonly containerId: string;
}

export interface KeyHandoffOffer extends KeyHandoffBinding {
  readonly receiverPublicKey: string;
  readonly nonce: string;
}

export interface KeyHandoffEnvelope extends KeyHandoffBinding {
  readonly receiverPublicKeyHash: string;
  readonly senderPublicKey: string;
  readonly nonce: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly senderIdentityPublicKey: string;
  readonly senderSignature: string;
}

export interface KeyHandoffSenderIdentity {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

function validateBinding(binding: KeyHandoffBinding): void {
  if (!ID.test(binding.operationId)) throw new Error('key handoff operation id is invalid');
  if (!DIGEST.test(binding.targetDigest)) throw new Error('key handoff target digest is invalid');
  if (!CONTAINER_ID.test(binding.containerId))
    throw new Error('key handoff container id is invalid');
}

function canonical(binding: KeyHandoffBinding, nonce: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      operationId: binding.operationId,
      targetDigest: binding.targetDigest,
      containerId: binding.containerId,
      nonce,
    }),
  );
}

function decode(value: string, label: string, maxBytes: number): Buffer {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedLength) throw new Error(`${label} is invalid`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} is invalid`);
  const result = Buffer.from(value, 'base64');
  if (result.length === 0 || result.length > maxBytes || result.toString('base64') !== value)
    throw new Error(`${label} is invalid`);
  return result;
}

function validateNonce(value: string): void {
  if (decode(value, 'key handoff nonce', 32).length !== 32)
    throw new Error('key handoff nonce is invalid');
}

function decodeExact(value: string, label: string, bytes: number): Buffer {
  const result = decode(value, label, bytes);
  if (result.length !== bytes) throw new Error(`${label} is invalid`);
  return result;
}

function publicKey(value: string): KeyObject {
  return createPublicKey({
    key: decode(value, 'handoff public key', 256),
    format: 'der',
    type: 'spki',
  });
}

function publicDer(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' });
}

function envelopeProof(envelope: Omit<KeyHandoffEnvelope, 'senderSignature'>): Buffer {
  return Buffer.from(JSON.stringify(envelope));
}

/**
 * Widest a single wire field may be before anything looks at its contents.
 *
 * Every field is base64 of something this module already bounds, and the
 * largest of them is the ciphertext of a {@link MAX_KEY_BYTES} key. The point
 * of the bound is the order it imposes: a peer that posts megabytes is refused
 * by a length comparison rather than by a regular expression that has already
 * walked them.
 */
const MAX_FIELD_CHARS = 8192;

const BINDING_FIELDS = ['operationId', 'targetDigest', 'containerId'] as const;

const OFFER_FIELDS = [
  'operationId',
  'targetDigest',
  'containerId',
  'receiverPublicKey',
  'nonce',
] as const;

const ENVELOPE_FIELDS = [
  'operationId',
  'targetDigest',
  'containerId',
  'receiverPublicKeyHash',
  'senderPublicKey',
  'nonce',
  'salt',
  'iv',
  'ciphertext',
  'tag',
  'senderIdentityPublicKey',
  'senderSignature',
] as const;

/**
 * Read an exact set of bounded string fields off an untrusted value.
 *
 * The key count is compared as well as the names, so a record carrying an extra
 * field is rejected rather than silently narrowed. That matters because these
 * objects are relayed by a third party: a shape this side does not fully
 * understand must not be forwarded as if it did.
 */
function stringFields<const F extends readonly string[]>(
  value: unknown,
  fields: F,
): Record<F[number], string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length) return null;
  const result: Record<string, string> = {};
  for (const field of fields) {
    const item = record[field];
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_FIELD_CHARS) return null;
    result[field] = item;
  }
  return result;
}

/** A binding as it survives a relay or a durable record, or null when invalid. */
export function parseKeyHandoffBinding(value: unknown): KeyHandoffBinding | null {
  const fields = stringFields(value, BINDING_FIELDS);
  if (fields === null) return null;
  const binding: KeyHandoffBinding = {
    operationId: fields.operationId,
    targetDigest: fields.targetDigest,
    containerId: fields.containerId,
  };
  try {
    validateBinding(binding);
  } catch {
    return null;
  }
  return binding;
}

/** Whether two bindings name the same update, candidate and image. */
export function sameKeyHandoffBinding(a: KeyHandoffBinding, b: KeyHandoffBinding): boolean {
  return (
    a.operationId === b.operationId &&
    a.targetDigest === b.targetDigest &&
    a.containerId === b.containerId
  );
}

/** An offer as it survives the relay, or null when it is not one. */
export function parseKeyHandoffOffer(value: unknown): KeyHandoffOffer | null {
  const fields = stringFields(value, OFFER_FIELDS);
  if (fields === null) return null;
  const offer: KeyHandoffOffer = {
    operationId: fields.operationId,
    targetDigest: fields.targetDigest,
    containerId: fields.containerId,
    receiverPublicKey: fields.receiverPublicKey,
    nonce: fields.nonce,
  };
  try {
    validateBinding(offer);
    validateNonce(offer.nonce);
    publicKey(offer.receiverPublicKey);
  } catch {
    return null;
  }
  return offer;
}

/**
 * An envelope as it survives the relay, or null when it is not one.
 *
 * Only the shape is decided here. Whether the envelope is *authentic* is not
 * knowable without the receiver's own key material, so that verdict stays where
 * the private key is — {@link createKeyHandoffReceiver}'s `accept`.
 */
export function parseKeyHandoffEnvelope(value: unknown): KeyHandoffEnvelope | null {
  const fields = stringFields(value, ENVELOPE_FIELDS);
  if (fields === null) return null;
  const envelope: KeyHandoffEnvelope = {
    operationId: fields.operationId,
    targetDigest: fields.targetDigest,
    containerId: fields.containerId,
    receiverPublicKeyHash: fields.receiverPublicKeyHash,
    senderPublicKey: fields.senderPublicKey,
    nonce: fields.nonce,
    salt: fields.salt,
    iv: fields.iv,
    ciphertext: fields.ciphertext,
    tag: fields.tag,
    senderIdentityPublicKey: fields.senderIdentityPublicKey,
    senderSignature: fields.senderSignature,
  };
  try {
    validateBinding(envelope);
    validateNonce(envelope.nonce);
    publicKey(envelope.senderPublicKey);
    publicKey(envelope.senderIdentityPublicKey);
  } catch {
    return null;
  }
  return envelope;
}

/** A relayed sender identity, or null when it is not a usable public key. */
export function parseKeyHandoffPublicKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_CHARS)
    return null;
  try {
    publicKey(value);
  } catch {
    return null;
  }
  return value;
}

export function createKeyHandoffSenderIdentity(): KeyHandoffSenderIdentity {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: publicDer(pair.publicKey).toString('base64'),
    privateKey: pair.privateKey,
  };
}

function deriveWrappingKey(
  privateKey: KeyObject,
  peer: KeyObject,
  salt: Buffer,
  info: Buffer,
): Buffer {
  const sharedSecret = diffieHellman({ privateKey, publicKey: peer });
  try {
    return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 32));
  } finally {
    sharedSecret.fill(0);
  }
}

function sameBinding(a: KeyHandoffBinding, b: KeyHandoffBinding): boolean {
  const left = canonical(a, '');
  const right = canonical(b, '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sealUnlockedKey(
  key: Buffer,
  offer: KeyHandoffOffer,
  senderIdentity: KeyHandoffSenderIdentity,
): KeyHandoffEnvelope {
  validateBinding(offer);
  validateNonce(offer.nonce);
  if (key.length === 0 || key.length > MAX_KEY_BYTES)
    throw new Error('unlocked key length is invalid');
  const receiver = publicKey(offer.receiverPublicKey);
  const { privateKey, publicKey: sender } = generateKeyPairSync('x25519');
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const info = canonical(offer, offer.nonce);
  const wrappingKey = deriveWrappingKey(privateKey, receiver, salt, info);
  try {
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
    cipher.setAAD(info);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    const unsigned: Omit<KeyHandoffEnvelope, 'senderSignature'> = {
      operationId: offer.operationId,
      targetDigest: offer.targetDigest,
      containerId: offer.containerId,
      receiverPublicKeyHash: createHash('sha256').update(publicDer(receiver)).digest('base64'),
      senderPublicKey: publicDer(sender).toString('base64'),
      nonce: offer.nonce,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      senderIdentityPublicKey: senderIdentity.publicKey,
    };
    return {
      ...unsigned,
      senderSignature: sign(null, envelopeProof(unsigned), senderIdentity.privateKey).toString(
        'base64',
      ),
    };
  } finally {
    wrappingKey.fill(0);
  }
}

export function createKeyHandoffReceiver(
  binding: KeyHandoffBinding,
  trustedSenderPublicKey: string,
) {
  validateBinding(binding);
  const trustedSender = publicKey(trustedSenderPublicKey);
  const trustedSenderDer = publicDer(trustedSender);
  const keyPair = generateKeyPairSync('x25519');
  let receiverPrivateKey: KeyObject | null = keyPair.privateKey;
  const receiverPublicKey = keyPair.publicKey;
  const receiverDer = publicDer(receiverPublicKey);
  const nonce = randomBytes(32).toString('base64');
  let consumed = false;
  let unlockedKey: Buffer | null = null;

  const offer: KeyHandoffOffer = {
    ...binding,
    receiverPublicKey: receiverDer.toString('base64'),
    nonce,
  };

  /**
   * Everything that can be decided about an envelope without opening it.
   *
   * Which is everything that decides whether it *should* be opened: the sender's
   * signature covers every other field, so an envelope that is bound to this
   * offer, addressed to this public key and signed by the trusted identity will
   * decrypt — barring a sender that seals its own key wrong, which no amount of
   * checking here would catch. Separate from `accept` so a holder can establish
   * that much while it is still worth asking for a replacement, and derive the
   * key itself only once it is allowed to use it.
   */
  const verifyEnvelope = (envelope: KeyHandoffEnvelope): void => {
    if (consumed) throw new Error('key handoff offer has already been consumed');
    validateBinding(envelope);
    if (!sameBinding(binding, envelope) || envelope.nonce !== nonce)
      throw new Error('key handoff binding does not match');
    const claimedSender = publicKey(envelope.senderIdentityPublicKey);
    const claimedSenderDer = publicDer(claimedSender);
    if (
      claimedSenderDer.length !== trustedSenderDer.length ||
      !timingSafeEqual(claimedSenderDer, trustedSenderDer)
    )
      throw new Error('key handoff sender is not trusted');
    const { senderSignature, ...unsigned } = envelope;
    const signature = decode(senderSignature, 'key handoff sender signature', 128);
    if (!verify(null, envelopeProof(unsigned), trustedSender, signature))
      throw new Error('key handoff sender signature is invalid');
    const expectedHash = createHash('sha256').update(receiverDer).digest();
    const receivedHash = decode(envelope.receiverPublicKeyHash, 'receiver public key hash', 32);
    if (receivedHash.length !== expectedHash.length || !timingSafeEqual(receivedHash, expectedHash))
      throw new Error('key handoff receiver does not match');
  };

  const accept = (envelope: KeyHandoffEnvelope): void => {
    // Presenting an envelope spends the offer whether or not it turns out to be
    // one worth opening. `verify` deliberately does not — it exists to be asked
    // before spending anything, and answering it leaves no trace to protect.
    try {
      verifyEnvelope(envelope);
    } finally {
      consumed = true;
    }
    try {
      const salt = decodeExact(envelope.salt, 'key handoff salt', 32);
      const iv = decodeExact(envelope.iv, 'key handoff iv', 12);
      const ciphertext = decode(envelope.ciphertext, 'key handoff ciphertext', MAX_KEY_BYTES);
      const tag = decodeExact(envelope.tag, 'key handoff tag', 16);
      const info = canonical(binding, nonce);
      if (receiverPrivateKey === null) throw new Error('key handoff receiver has been destroyed');
      const wrappingKey = deriveWrappingKey(
        receiverPrivateKey,
        publicKey(envelope.senderPublicKey),
        salt,
        info,
      );
      try {
        const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv, {
          authTagLength: 16,
        });
        decipher.setAAD(info);
        decipher.setAuthTag(tag);
        unlockedKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } finally {
        wrappingKey.fill(0);
      }
    } finally {
      receiverPrivateKey = null;
    }
  };

  const use = async <T>(work: (key: Buffer) => Promise<T>): Promise<T> => {
    if (unlockedKey === null) throw new Error('key handoff is not available');
    const key = unlockedKey;
    unlockedKey = null;
    try {
      return await work(key);
    } finally {
      key.fill(0);
    }
  };

  const destroy = (): void => {
    unlockedKey?.fill(0);
    unlockedKey = null;
    receiverPrivateKey = null;
    consumed = true;
  };

  return { offer, verify: verifyEnvelope, accept, use, destroy };
}
