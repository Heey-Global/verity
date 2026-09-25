import { createPublicKey, verify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

const asciiId = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/);
const keyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}(?![\s\S])/);
const seconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerSchema = z.strictObject({
  alg: z.literal('EdDSA'),
  typ: z.literal('verity-team-grant+jws'),
  kid: keyId,
});
const grantSchema = z.strictObject({
  issuer: z.literal('verity-uplink'),
  audience: z.literal('verity-core-team'),
  installationId: asciiId,
  teamVersion: z.literal(1),
  grantId: asciiId,
  generation: seconds,
  capabilities: z.tuple([z.literal('team-sharing')]),
  issuedAt: seconds,
  notBefore: seconds,
  expiresAt: seconds,
});

export type VerifiedTeamGrant = z.infer<typeof grantSchema>;

export interface TeamGrantVerificationContext {
  installationId: string;
  /** Public Ed25519 keys from trusted local configuration, indexed by kid. */
  keys: ReadonlyMap<string, Uint8Array>;
  nowSeconds: number;
  /** Persisted trusted wall-clock high-water mark; rollback fails closed. */
  trustedTimeFloorSeconds: number;
}

/** Verify a proposed team grant's cryptography, claims and time interval.
 * This does not apply durable revocation/generation floors or authorize a route. */
export function parseVerifiedTeamGrant(
  assertion: string,
  context: TeamGrantVerificationContext,
): VerifiedTeamGrant {
  if (assertion.length > 16_384) throw new Error('team grant is too large');
  if (
    !Number.isSafeInteger(context.nowSeconds) ||
    context.nowSeconds < 0 ||
    !Number.isSafeInteger(context.trustedTimeFloorSeconds) ||
    context.trustedTimeFloorSeconds < 0
  ) {
    throw new Error('team grant time is uncertain');
  }
  if (context.nowSeconds + 30 < context.trustedTimeFloorSeconds) {
    throw new Error('team grant clock rolled back');
  }
  const parts = assertion.split('.');
  if (parts.length !== 3) throw new Error('invalid team grant envelope');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const headerBytes = decodeSegment(headerPart, 4096);
  const payloadBytes = decodeSegment(payloadPart, 8192);
  const signature = decodeSegment(signaturePart, 64);
  if (signature.length !== 64) throw new Error('invalid team grant signature length');
  const header = headerSchema.parse(parseJsonWithoutDuplicateKeys(decodeUtf8(headerBytes)));
  const rawKey = context.keys.get(header.kid);
  if (!rawKey || rawKey.length !== 32) throw new Error('unknown team grant signing key');
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, Buffer.from(`${headerPart}.${payloadPart}`, 'ascii'), publicKey, signature)) {
    throw new Error('invalid team grant signature');
  }
  const grant = grantSchema.parse(parseJsonWithoutDuplicateKeys(decodeUtf8(payloadBytes)));
  if (grant.installationId !== context.installationId)
    throw new Error('wrong team grant installation');
  if (
    grant.issuedAt > grant.notBefore ||
    grant.notBefore >= grant.expiresAt ||
    grant.expiresAt > grant.issuedAt + 900
  ) {
    throw new Error('invalid team grant interval');
  }
  if (
    context.nowSeconds < grant.issuedAt - 30 ||
    context.nowSeconds < grant.notBefore - 30 ||
    context.nowSeconds >= grant.expiresAt
  ) {
    throw new Error('team grant is not currently valid');
  }
  return grant;
}

function decodeSegment(segment: string, maxBytes: number): Buffer {
  if (
    !/^[A-Za-z0-9_-]+(?![\s\S])/u.test(segment) ||
    segment.length > Math.ceil((maxBytes * 4) / 3) + 2
  ) {
    throw new Error('invalid team grant encoding');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== segment) {
    throw new Error('noncanonical team grant encoding');
  }
  return bytes;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Buffer): string {
  return utf8.decode(bytes);
}

/** Scan decoded JSON before JSON.parse, so escaped and literal duplicate keys
 * are detected at every nesting level rather than silently overwritten. */
function parseJsonWithoutDuplicateKeys(raw: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/\s/u.test(raw[offset] ?? '') && offset < raw.length) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '\\') {
        offset++;
      } else if (char === '"') {
        return JSON.parse(raw.slice(start, offset)) as string;
      }
    }
    throw new Error('unterminated team grant string');
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error('team grant JSON nesting limit');
    whitespace();
    const char = raw[offset];
    if (char === '{') {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (raw[offset] === '}') {
        offset++;
        return;
      }
      while (true) {
        if (raw[offset] !== '"') throw new Error('invalid team grant object');
        const key = string();
        if (keys.has(key)) throw new Error('duplicate team grant JSON key');
        keys.add(key);
        whitespace();
        if (raw[offset++] !== ':') throw new Error('invalid team grant object');
        value(depth + 1);
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new Error('invalid team grant object');
        whitespace();
      }
    }
    if (char === '[') {
      offset++;
      whitespace();
      if (raw[offset] === ']') {
        offset++;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new Error('invalid team grant array');
      }
    }
    if (char === '"') {
      string();
      return;
    }
    const start = offset;
    while (offset < raw.length && !/[\s,\]}]/u.test(raw[offset]!)) offset++;
    if (start === offset) throw new Error('invalid team grant value');
    JSON.parse(raw.slice(start, offset));
  };
  value(0);
  whitespace();
  if (offset !== raw.length) throw new Error('invalid team grant JSON tail');
  return JSON.parse(raw) as unknown;
}
