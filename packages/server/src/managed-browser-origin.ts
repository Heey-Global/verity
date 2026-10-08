import { createHmac, timingSafeEqual } from 'node:crypto';
import { signManagedClientIdentity } from './managed-client-identity.js';

export const MANAGED_BROWSER_ORIGIN_HEADER = 'x-verity-managed-browser-origin';

function signingKey(secret: Buffer): Buffer {
  // Separate this metadata from client identity so neither signed header can
  // be transplanted into the other trust boundary.
  return createHmac('sha256', secret).update('verity.managed-browser-origin.v1').digest();
}

function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
  } catch {
    return false;
  }
}

export function signManagedBrowserOrigin(
  secret: Buffer,
  input: { origin: string; method: string; url: string; now?: number },
): string | undefined {
  if (!validOrigin(input.origin)) return undefined;
  return signManagedClientIdentity(signingKey(secret), { ...input, address: input.origin });
}

export function verifyManagedBrowserOrigin(
  secret: Buffer,
  value: string | string[] | undefined,
  input: { method: string; url: string; now?: number },
): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const issuedAt = Number(parts[0]);
  if (!Number.isSafeInteger(issuedAt) || Math.abs((input.now ?? Date.now()) - issuedAt) > 30_000)
    return undefined;
  const origin = Buffer.from(parts[1]!, 'base64url').toString();
  if (!validOrigin(origin)) return undefined;
  const expected = signManagedBrowserOrigin(secret, { ...input, origin, now: issuedAt });
  if (expected === undefined) return undefined;
  const presented = Buffer.from(value);
  const signature = Buffer.from(expected);
  return presented.length === signature.length && timingSafeEqual(presented, signature)
    ? origin
    : undefined;
}
