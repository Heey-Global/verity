import { createHmac, timingSafeEqual } from 'node:crypto';

/** Detect damaged cache mappings before an unchanged source can reuse the wrong valid object. */
export function encodeLocalIndex(index: Record<string, unknown>, fingerprintKey: string): Buffer {
  const payload = JSON.stringify(index);
  const tag = createHmac('sha256', Buffer.from(fingerprintKey, 'base64url'))
    .update('verity-backup-index-v1\0')
    .update(payload)
    .digest('hex');
  return Buffer.from(JSON.stringify({ payload, tag }));
}

export function decodeLocalIndex(bytes: Uint8Array, fingerprintKey: string): unknown {
  const envelope: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    throw new Error('Invalid backup index');
  const { payload, tag } = envelope as Record<string, unknown>;
  if (typeof payload !== 'string' || typeof tag !== 'string' || !/^[0-9a-f]{64}$/.test(tag))
    throw new Error('Invalid backup index');
  const expected = createHmac('sha256', Buffer.from(fingerprintKey, 'base64url'))
    .update('verity-backup-index-v1\0')
    .update(payload)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(tag, 'hex')))
    throw new Error('Backup index integrity mismatch: start a new repository');
  return JSON.parse(payload) as unknown;
}
