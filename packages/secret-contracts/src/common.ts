import { z } from 'zod';

/** First wire version of the Brokered Secrets contracts (ADR 0009 / Phase 0 W3+W4). */
export const BROKERED_SECRETS_PROTOCOL_VERSION = 1 as const;
export const brokeredSecretsProtocolVersionSchema = z.literal(BROKERED_SECRETS_PROTOCOL_VERSION);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Opaque, bounded identifiers safe for logs and URL/path-independent storage keys. */
export const secretContractIdSchema = z.string().min(1).max(128).regex(SAFE_ID);
export const sha256HexSchema = z.string().regex(SHA256_HEX);
export const envNameSchema = z.string().max(128).regex(ENV_NAME);
export const isoUtcTimestampSchema = z
  .string()
  .regex(ISO_UTC)
  .refine((value) => Number.isFinite(Date.parse(value)), 'invalid UTC timestamp');
export const base64Schema = z.string().regex(BASE64);
export const positiveVersionSchema = z.number().int().positive();

export const secretTrustModeSchema = z.enum(['trusted', 'restricted', 'action']);
export type SecretTrustMode = z.infer<typeof secretTrustModeSchema>;

export const secretInjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), target: envNameSchema }).strict(),
  z.object({ kind: z.literal('file'), target: envNameSchema }).strict(),
  z.object({ kind: z.literal('stdin') }).strict(),
]);
export type SecretInjection = z.infer<typeof secretInjectionSchema>;

export const jsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof jsonScalarSchema>;

/** Canonical JSON for hashes/signatures: recursively sorted object keys, no unsupported values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}
