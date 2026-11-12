// Review contract for the Uplink team control extension (team v1). Production
// routes do not import this module yet; Core and Uplink handlers must pass the
// same fixtures before invitations are enabled. See
// docs/protocols/uplink-team-contract-v1.md for the reconciled decisions.
import { createHash } from 'node:crypto';
import { z } from 'zod';

const object = z.strictObject;
const uuid = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\s\S])/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/);
const bytes16 = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw](?![\s\S])/);
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048](?![\s\S])/);
const tlsPin = z.string().regex(/^sha256-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048](?![\s\S])/);
const identityKey = z
  .string()
  .regex(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048](?![\s\S])/);
const serverId = z.string().regex(/^srv_[A-Za-z0-9_-]{21}[AQgw](?![\s\S])/);
const origin = z.string().regex(/^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?(?![\s\S])/);
// Control timestamps are integer UTC epoch seconds; admission and the
// invitation envelope use milliseconds like Remote Control.
const timeSeconds = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timeMs = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Compact JWS (EdDSA) as profiled in uplink-team-grant-signing-v1.md: at most 16 KiB.
const assertion = z
  .string()
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/);
const teamVersion = z.literal(1);
const permissions = z.union([
  z.tuple([z.literal('read')]),
  z.tuple([z.literal('read'), z.literal('execute')]),
  z.tuple([z.literal('read'), z.literal('manage')]),
  z.tuple([z.literal('read'), z.literal('execute'), z.literal('manage')]),
]);
const request = { requestId: uuid, teamVersion };
const mutation = { ...request, operationId: uuid };
const event = { eventId: uuid, teamVersion };
// Display hints are untrusted: the app shows only values Core returns after the
// pinned identity proof. Single line, no control characters.
const displayText = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}\u2028\u2029]+(?![\s\S])/u);

export const errorCodes = [
  'unsupported_version',
  'not_entitled',
  'authorization_expired',
  'revoked',
  'forbidden',
  'invitation_unavailable',
  'idempotency_conflict',
  'member_limit_reached',
  'invalid_request',
  'temporarily_unavailable',
  'internal',
] as const;

export const schemas = {
  // Fragments added to the existing hello/welcome envelopes, not replacements.
  helloTeam: object({ teamVersions: z.tuple([teamVersion]) }),
  welcomeTeam: object({ teamVersion }),

  grantGet: object({ type: z.literal('team.grant.get'), ...request }),
  grant: object({ type: z.literal('team.grant'), ...request, assertion }),

  inviteCreate: object({
    type: z.literal('team.invite.create'),
    ...mutation,
    localInviteId: uuid,
    projectId: id,
    permissions,
    expiresAt: timeSeconds,
    bootstrapCommitment: bytes32,
    installationKeyFingerprint: tlsPin,
  }),
  // No redeemUrl: Core assembles the https://verity.build/join link itself.
  inviteCreated: object({
    type: z.literal('team.invite.created'),
    ...request,
    invitationId: bytes32,
    expiresAt: timeSeconds,
  }),
  inviteCancel: object({
    type: z.literal('team.invite.cancel'),
    ...mutation,
    invitationId: bytes32,
  }),
  inviteCancelled: object({
    type: z.literal('team.invite.cancelled'),
    ...request,
    invitationId: bytes32,
    alreadyCommitted: z.boolean(),
  }),

  joinCommit: object({
    type: z.literal('team.join.commit'),
    ...mutation,
    invitationId: bytes32,
    redemptionId: id,
    membershipRef: bytes32,
  }),
  joinCommitted: object({ type: z.literal('team.join.committed'), ...request, redemptionId: id }),

  membershipRemove: object({
    type: z.literal('team.membership.remove'),
    ...mutation,
    membershipRef: bytes32,
    reason: z.literal('membership_removed'),
  }),
  membershipRemoved: object({
    type: z.literal('team.membership.removed'),
    ...request,
    membershipRef: bytes32,
  }),

  stateGet: object({ type: z.literal('team.state.get'), ...request, knownGeneration: generation }),
  state: z.union([
    object({ type: z.literal('team.state'), ...request, generation, assertion }),
    object({
      type: z.literal('team.state'),
      ...request,
      generation,
      suspendedReason: z.enum(['not_entitled', 'revoked', 'authorization_expired']),
    }),
  ]),

  grantChanged: object({ type: z.literal('team.grant.changed'), ...event, generation, assertion }),
  grantRevoked: object({
    type: z.literal('team.grant.revoked'),
    ...event,
    generation,
    reason: z.enum(['not_entitled', 'revoked']),
  }),
  eventAck: object({ type: z.literal('team.event.ack'), ...event }),

  teamError: object({
    type: z.literal('team.error'),
    ...request,
    code: z.enum(errorCodes),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
  }),

  // Decoded fragment of https://verity.build/join#<canonical base64url JSON>.
  // Same trust fields as the enrollment envelope; the https form replaces
  // verity://enroll/v1 for team members so the link opens the app.
  invitationLink: object({
    version: z.literal(1),
    purpose: z.literal('team-member'),
    invitationId: bytes32,
    secret: bytes32,
    expiresAt: timeMs,
    serverId,
    identityKey,
    tlsPin,
    coreOrigin: origin,
    uplinkOrigin: origin,
    installationId: uuid,
    installationHandle: bytes16,
    display: object({ inviterName: displayText, projectName: displayText }).optional(),
  }),
};

export type SchemaName = keyof typeof schemas;

const semanticChecks: Partial<Record<SchemaName, readonly string[]>> = {
  teamError: ['retryAfterSecondsOnlyWhenRetryable'],
  invitationLink: ['serverIdDerivedFromIdentityKey'],
};

export function accepts(name: SchemaName, value: unknown): boolean {
  if (!schemas[name].safeParse(value).success) return false;
  for (const check of semanticChecks[name] ?? []) {
    if (check === 'retryAfterSecondsOnlyWhenRetryable') {
      const error = value as { retryable: boolean; retryAfterSeconds?: number };
      if (error.retryAfterSeconds !== undefined && !error.retryable) return false;
    } else if (check === 'serverIdDerivedFromIdentityKey') {
      const link = value as { serverId: string; identityKey: string };
      if (link.serverId !== deriveServerId(link.identityKey)) return false;
    }
  }
  return true;
}

/** `srv_` + base64url(SHA-256("verity.device-pairing.v1.server-id" NUL identityKey)[0..16]). */
export function deriveServerId(identityKey: string): string {
  const digest = createHash('sha256')
    .update(`verity.device-pairing.v1.server-id\0${identityKey}`, 'utf8')
    .digest();
  return `srv_${digest.subarray(0, 16).toString('base64url')}`;
}

export function jsonSchemas() {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const exported = z.toJSONSchema(schema, { target: 'draft-7' });
      // Draft-7 cannot express these; consumers run the named checks after
      // structural validation.
      const checks = semanticChecks[name as SchemaName];
      if (checks) Object.assign(exported, { 'x-semanticChecks': [...checks] });
      return [name, exported];
    }),
  );
}
