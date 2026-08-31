import { createHmac, timingSafeEqual } from 'node:crypto';

export const MANAGED_CLIENT_IDENTITY_HEADER = 'x-verity-managed-client';
const MAX_AGE_MS = 30_000;

function mac(
  secret: Buffer,
  timestamp: string,
  address: string,
  method: string,
  url: string,
): Buffer {
  return createHmac('sha256', secret)
    .update(`${timestamp}\0${address}\0${method}\0${url}`)
    .digest();
}

export function signManagedClientIdentity(
  secret: Buffer,
  input: { address: string; method: string; url: string; now?: number },
): string {
  const timestamp = String(input.now ?? Date.now());
  return `${timestamp}.${Buffer.from(input.address).toString('base64url')}.${mac(secret, timestamp, input.address, input.method, input.url).toString('base64url')}`;
}

export function verifyManagedClientIdentity(
  secret: Buffer,
  value: string | string[] | undefined,
  input: { method: string; url: string; now?: number },
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [timestamp, encodedAddress, encodedMac] = parts;
  const issuedAt = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > MAX_AGE_MS) return undefined;
  let address: string;
  let presented: Buffer;
  try {
    address = Buffer.from(encodedAddress!, 'base64url').toString();
    presented = Buffer.from(encodedMac!, 'base64url');
  } catch {
    return undefined;
  }
  if (address.length === 0 || address.length > 128 || presented.length !== 32) return undefined;
  const expected = mac(secret, timestamp!, address, input.method, input.url);
  return timingSafeEqual(presented, expected) ? address : undefined;
}
