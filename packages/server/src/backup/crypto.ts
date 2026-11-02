import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';

const PREFIX = 'verity-recovery-v1.';
const MAX_KEY_LENGTH = 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const SIGNATURE_DOMAIN = Buffer.from('verity-backup-manifest-v1\0');

export interface RecoveryKey {
  readonly identity: string;
  readonly verificationKey: string;
}

/** Host state deliberately has no age identity and cannot decrypt old backups. */
export interface BackupHostKeys {
  readonly recipient: string;
  readonly signingKey: string;
  readonly verificationKey: string;
  readonly fingerprintKey: string;
}

function checksum(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(PREFIX).update(bytes).digest().subarray(0, 8);
}

function encodeRecoveryKey(key: RecoveryKey): string {
  const payload = Buffer.from(JSON.stringify([key.identity, key.verificationKey]));
  return PREFIX + Buffer.concat([payload, checksum(payload)]).toString('base64url');
}

export function decodeRecoveryKey(encoded: string): RecoveryKey {
  if (encoded.length > MAX_KEY_LENGTH || !encoded.startsWith(PREFIX)) {
    throw new Error('Invalid recovery key');
  }
  const text = encoded.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid recovery key');
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text || decoded.length < 9) {
    throw new Error('Invalid recovery key');
  }
  const payload = decoded.subarray(0, -8);
  if (!timingSafeEqual(checksum(payload), decoded.subarray(-8))) {
    throw new Error('Recovery key checksum mismatch');
  }
  const fields: unknown = JSON.parse(payload.toString('utf8'));
  if (
    !Array.isArray(fields) ||
    fields.length !== 2 ||
    typeof fields[0] !== 'string' ||
    typeof fields[1] !== 'string' ||
    !/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(fields[0])
  )
    throw new Error('Invalid recovery key');
  const publicKey = createPublicKey({
    key: Buffer.from(fields[1], 'base64url'),
    format: 'der',
    type: 'spki',
  });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid verification key');
  return { identity: fields[0], verificationKey: fields[1] };
}

export async function generateBackupKeys(): Promise<{ recoveryKey: string; host: BackupHostKeys }> {
  const identity = await generateIdentity();
  const pair = generateKeyPairSync('ed25519');
  const verificationKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  return {
    recoveryKey: encodeRecoveryKey({ identity, verificationKey }),
    host: {
      recipient: await identityToRecipient(identity),
      signingKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      verificationKey,
      fingerprintKey: randomBytes(32).toString('base64url'),
    },
  };
}

export async function confirmRecoveryKey(encoded: string, host: BackupHostKeys): Promise<void> {
  const key = decodeRecoveryKey(encoded);
  if (
    key.verificationKey !== host.verificationKey ||
    (await identityToRecipient(key.identity)) !== host.recipient
  ) {
    throw new Error('Recovery key does not match setup');
  }
}

export async function encryptStream(
  recipient: string,
  source: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(source);
}

/** Callers must use staging: authentication can fail at the end of a stream. */
export async function decryptStream(
  encoded: string,
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  signal?.throwIfAborted();
  if (signal)
    source = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
  const decrypter = new Decrypter();
  decrypter.addIdentity(decodeRecoveryKey(encoded).identity);
  return decrypter.decrypt(source);
}

async function collectBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('Backup metadata exceeds limit');
      parts.push(part.value);
    }
    return Buffer.concat(parts, size);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Signature authenticates ciphertext before decryption or parsing of any manifest fields. */
export async function sealMetadata(host: BackupHostKeys, plaintext: Uint8Array): Promise<Buffer> {
  if (plaintext.byteLength > MAX_METADATA_BYTES) throw new Error('Backup metadata exceeds limit');
  const ciphertext = await collectBounded(
    await encryptStream(host.recipient, byteStream(plaintext)),
    MAX_METADATA_BYTES + 65536,
  );
  const signature = sign(
    null,
    Buffer.concat([SIGNATURE_DOMAIN, ciphertext]),
    createPrivateKey({
      key: Buffer.from(host.signingKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    }),
  );
  return Buffer.concat([signature, ciphertext]);
}

export async function openMetadata(
  encoded: string,
  envelope: Uint8Array,
  signal?: AbortSignal,
): Promise<Buffer> {
  const key = decodeRecoveryKey(encoded);
  verifyMetadata(key.verificationKey, envelope);
  return collectBounded(
    await decryptStream(encoded, byteStream(envelope.subarray(64)), signal),
    MAX_METADATA_BYTES,
  );
}

/** Host-side integrity check requires no recovery identity and decrypts nothing. */
export function verifyMetadata(verificationKey: string, envelope: Uint8Array): void {
  if (envelope.byteLength < 65 || envelope.byteLength > MAX_METADATA_BYTES + 65600)
    throw new Error('Invalid backup metadata size');
  const signature = envelope.subarray(0, 64);
  const ciphertext = envelope.subarray(64);
  if (
    !verify(
      null,
      Buffer.concat([SIGNATURE_DOMAIN, ciphertext]),
      createPublicKey({
        key: Buffer.from(verificationKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      signature,
    )
  ) {
    throw new Error('Backup metadata signature mismatch');
  }
}

export async function sealHostKeyBundle(host: BackupHostKeys): Promise<Buffer> {
  return sealMetadata(host, Buffer.from(JSON.stringify(host)));
}

export async function recoverHostKeys(
  encoded: string,
  envelope: Uint8Array,
  signal?: AbortSignal,
): Promise<BackupHostKeys> {
  const value: unknown = JSON.parse(
    (await openMetadata(encoded, envelope, signal)).toString('utf8'),
  );
  if (!value || typeof value !== 'object') throw new Error('Invalid backup key bundle');
  const keys = value as Record<string, unknown>;
  if (
    typeof keys['recipient'] !== 'string' ||
    typeof keys['signingKey'] !== 'string' ||
    typeof keys['verificationKey'] !== 'string' ||
    typeof keys['fingerprintKey'] !== 'string'
  )
    throw new Error('Invalid backup key bundle');
  const host: BackupHostKeys = {
    recipient: keys['recipient'],
    signingKey: keys['signingKey'],
    verificationKey: keys['verificationKey'],
    fingerprintKey: keys['fingerprintKey'],
  };
  await confirmRecoveryKey(encoded, host);
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.from(host.signingKey, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    }),
  )
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  if (publicKey !== host.verificationKey || !/^[A-Za-z0-9_-]{43}$/.test(host.fingerprintKey))
    throw new Error('Backup key bundle mismatch');
  return host;
}
