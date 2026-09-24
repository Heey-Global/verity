// Review-only wire schemas. No production route imports this module.
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
const deviceKey = z.string().regex(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const time = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const purpose = z.enum(['initial-admin', 'team-member']);
const action = z.enum(['initialize', 'commit', 'recover']);
const empty = z.literal('');
const installationId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const capabilities = z
  .array(z.string().regex(/^[\x20-\x7e]{1,64}$/))
  .max(32)
  .min(1);
const object = z.strictObject;

const proof = {
  challengeId: bytes32,
  operationId: bytes32,
  invitationId: bytes32,
  purpose,
  deviceKey,
  action,
  secret: bytes32,
  signature,
};
const context = { version: z.literal(2), sessionId: id, installationId };
const preface = z.union([
  object({
    ...context,
    purpose: z.literal('initial-admin'),
    redemptionId: empty,
    recoveryReservationId: empty,
  }),
  object({
    ...context,
    purpose: z.literal('team-member'),
    redemptionId: id,
    recoveryReservationId: empty,
  }),
  object({
    ...context,
    purpose: z.literal('team-member'),
    redemptionId: id,
    recoveryReservationId: bytes32,
  }),
]);
const challengeBase = { operationId: bytes32, invitationId: bytes32, deviceKey };
const challenge = z.union([
  object({ ...challengeBase, purpose: z.literal('initial-admin'), action }),
  object({
    ...challengeBase,
    purpose: z.literal('team-member'),
    action: z.enum(['commit', 'recover']),
  }),
]);

export const schemas = {
  preface,
  challenge,
  complete: object({ ...proof, action: z.enum(['commit', 'recover']) }),
  initialize: object({
    ...proof,
    purpose: z.literal('initial-admin'),
    action: z.literal('initialize'),
    // maxLength is a portable upper bound; UTF-8 byte length is checked separately.
    masterPassword: z.string().min(1).max(1024),
  }),
  initialized: object({ operationId: bytes32, state: z.literal('ready') }),
  ack: object({ operationId: bytes32, receiptId: id }),
  recoveryReserve: object({
    type: z.literal('team.recovery.reserve'),
    requestId: id,
    installationHandle: id,
    redemptionId: id,
    operationId: bytes32,
    capabilities,
  }),
  recoveryRequest: object({
    type: z.literal('team.recovery.request'),
    requestId: id,
    recoveryReservationId: bytes32,
    installationId,
    redemptionId: id,
    operationId: bytes32,
    expiresAt: time,
  }),
  recoveryAccept: object({
    type: z.literal('team.recovery.accept'),
    recoveryReservationId: bytes32,
    expiresAt: time,
  }),
  recoveryRefuse: object({
    type: z.literal('team.recovery.refuse'),
    recoveryReservationId: bytes32,
    code: z.literal('unavailable'),
  }),
  recoveryReady: object({
    type: z.literal('team.recovery.ready'),
    requestId: id,
    recoveryReservationId: bytes32,
    expiresAt: time,
  }),
  recoveryCancel: object({
    type: z.literal('team.recovery.cancel'),
    recoveryReservationId: bytes32,
  }),
  recoveryConnect: object({
    type: z.literal('connect'),
    requestId: id,
    installationHandle: id,
    capabilities,
    enrollmentPurpose: z.literal('team-member'),
    recoveryReservationId: bytes32,
  }),
  initializeError: z.union([
    object({ error: z.literal('invalid_request') }),
    object({ error: z.literal('enrollment_rejected') }),
    object({ error: z.literal('password_rejected') }),
    object({
      error: z.literal('rate_limited'),
      retryAfterMs: z.number().int().min(1000).max(60000),
    }),
    object({ error: z.literal('temporarily_unavailable') }),
  ]),
  locked: object({ error: z.literal('recovery_locked') }),
};
export type SchemaName = keyof typeof schemas;

// Extra wire constraints cannot all be represented by JSON Schema.
export function accepts(name: SchemaName, value: unknown): boolean {
  if (!schemas[name].safeParse(value).success) return false;
  const row = value as Record<string, unknown>;
  if (name === 'initialize' && Buffer.byteLength(row.masterPassword as string, 'utf8') > 1024)
    return false;
  if ('capabilities' in row) {
    const names = row.capabilities as string[];
    if (
      new Set(names).size !== names.length ||
      !names.includes('remote-control-v1') ||
      names.some((name) => name.length > 64)
    )
      return false;
  }
  return true;
}

export function jsonSchemas() {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: 'draft-7' }),
    ]),
  );
}
