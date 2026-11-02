import { createHash, createPrivateKey, sign, verify, X509Certificate } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { encryptStream } from './crypto.js';
const requestSchema = z
  .object({
    recipient: z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),
    installationId: z.string().uuid(),
    keyGeneration: z.number().int().min(1).max(999999999),
  })
  .strict();
export const identityHelperRequestSchema = requestSchema;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const receiptSchema = z
  .object({
    kind: z.literal('backup-ca-receipt'),
    format: z.literal(1),
    installationId: z.string().uuid(),
    keyGeneration: z.number().int().min(1).max(999999999),
    recipient: requestSchema.shape.recipient,
    certificateDigest: z.string().regex(/^[0-9a-f]{64}$/),
    ciphertextDigest: z.string().regex(/^[0-9a-f]{64}$/),
    ciphertext: z
      .string()
      .max(256 * 1024)
      .regex(/^[A-Za-z0-9_-]+$/),
    signature: z
      .string()
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
function message(
  value: Pick<
    z.infer<typeof receiptSchema>,
    'installationId' | 'keyGeneration' | 'recipient' | 'certificateDigest' | 'ciphertextDigest'
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: 'backup-ca-receipt',
      format: 1,
      installationId: value.installationId,
      keyGeneration: value.keyGeneration,
      recipient: value.recipient,
      certificateDigest: value.certificateDigest,
      ciphertextDigest: value.ciphertextDigest,
    }),
  );
}

/** Runs only inside the root helper. The fixed receipt domain cannot sign arbitrary request content. */
export async function sealCaIdentityReceipt(
  request: z.infer<typeof requestSchema>,
  caPrivateKey: Buffer,
  certificateBytes: Buffer,
): Promise<Buffer> {
  request = requestSchema.parse(request);
  const certificate = new X509Certificate(certificateBytes);
  const key = createPrivateKey(caPrivateKey);
  if (
    !certificate.ca ||
    !certificate.checkPrivateKey(key) ||
    !certificate.verify(certificate.publicKey)
  )
    throw new Error('Identity helper CA certificate/key mismatch');
  const stream = await encryptStream(
    request.recipient,
    Readable.toWeb(Readable.from([caPrivateKey])) as ReadableStream<Uint8Array>,
  );
  const ciphertext = Buffer.from(await new Response(stream).arrayBuffer());
  const body = {
    recipient: request.recipient,
    installationId: request.installationId,
    keyGeneration: request.keyGeneration,
    certificateDigest: digest(certificate.raw),
    ciphertextDigest: digest(ciphertext),
  };
  const algorithm =
    key.asymmetricKeyType === 'ed25519' || key.asymmetricKeyType === 'ed448' ? null : 'sha256';
  return Buffer.from(
    JSON.stringify({
      kind: 'backup-ca-receipt',
      format: 1,
      ...body,
      ciphertext: ciphertext.toString('base64url'),
      signature: sign(algorithm, message(body), key).toString('base64url'),
    }),
  );
}

/** A destination writer cannot substitute an unrelated ciphertext or a receipt from an old CA/key. */
export function openCaIdentityReceipt(
  bytes: Buffer,
  certificateBytes: Buffer,
  installationId: string,
  keyGeneration: number,
  recipient: string,
): Buffer {
  if (bytes.length > 384 * 1024) throw new Error('Identity helper receipt exceeds limit');
  const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
  const certificate = new X509Certificate(certificateBytes);
  const ciphertext = Buffer.from(receipt.ciphertext, 'base64url');
  const algorithm =
    certificate.publicKey.asymmetricKeyType === 'ed25519' ||
    certificate.publicKey.asymmetricKeyType === 'ed448'
      ? null
      : 'sha256';
  if (
    receipt.recipient !== recipient ||
    receipt.installationId !== installationId ||
    receipt.keyGeneration !== keyGeneration ||
    receipt.certificateDigest !== digest(certificate.raw) ||
    receipt.ciphertextDigest !== digest(ciphertext) ||
    ciphertext.toString('base64url') !== receipt.ciphertext ||
    !verify(
      algorithm,
      message(receipt),
      certificate.publicKey,
      Buffer.from(receipt.signature, 'base64url'),
    )
  )
    throw new Error('Identity helper receipt does not match this capture');
  return ciphertext;
}
