// Review-only team bootstrap wire schemas. Production routes do not import these yet.
import { z } from 'zod';

const object = z.strictObject;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/);
const handle = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw](?![\s\S])/);
const ticket = z.string().regex(/^[A-Za-z0-9_-]{1,512}(?![\s\S])/);
const timeMs = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const capability = z.literal('team-bootstrap-v1');
const permissions = z.union([
  z.tuple([z.literal('read')]),
  z.tuple([z.literal('read'), z.literal('execute')]),
  z.tuple([z.literal('read'), z.literal('manage')]),
  z.tuple([z.literal('read'), z.literal('execute'), z.literal('manage')]),
]);
const coreDecision = { sessionId: id };

export const schemas = {
  joinReserve: object({
    type: z.literal('team.join.reserve'),
    requestId: id,
    installationHandle: handle,
    invitationId: id,
    capabilities: z.tuple([capability]),
  }),
  joinPending: object({
    type: z.literal('team.join.pending'),
    requestId: id,
    sessionId: id,
    invitationId: id,
    redemptionId: id,
    projectId: id,
    permissions,
    bootstrapSessionId: id,
    decisionExpiresAt: timeMs,
    capability,
  }),
  sessionAccept: object({ type: z.literal('session.accept'), ...coreDecision }),
  sessionRefuse: object({
    type: z.literal('session.refuse'),
    ...coreDecision,
    code: z.enum(['unavailable', 'limit_reached']),
  }),
  sessionTicket: object({
    type: z.literal('session.ticket'),
    sessionId: id,
    redemptionId: id,
    ticket,
    expiresAt: timeMs,
    capability,
  }),
  joinReady: object({
    type: z.literal('team.join.ready'),
    requestId: id,
    sessionId: id,
    redemptionId: id,
    ticket,
    expiresAt: timeMs,
    capability,
  }),
  joinError: object({
    type: z.literal('team.join.error'),
    requestId: id,
    code: z.enum([
      'unavailable',
      'rate_limited',
      'limit_reached',
      'protocol_unsupported',
      'timeout',
      'cancelled',
      'internal',
    ]),
    retryAfterMs: z.number().int().min(1000).max(60000).optional(),
  }),
  sessionCancelled: object({
    type: z.literal('session.cancelled'),
    sessionId: id,
    code: z.enum(['cancelled', 'timeout', 'unavailable']),
  }),
};

export type SchemaName = keyof typeof schemas;

export function accepts(name: SchemaName, value: unknown): boolean {
  if (!schemas[name].safeParse(value).success) return false;
  if (name === 'joinPending') {
    const pending = value as { sessionId: string; bootstrapSessionId: string };
    return pending.sessionId === pending.bootstrapSessionId;
  }
  if (name === 'joinError') {
    const error = value as { code: string; retryAfterMs?: number };
    return error.retryAfterMs === undefined || error.code === 'rate_limited';
  }
  return true;
}

export function jsonSchemas() {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const exported = z.toJSONSchema(schema, { target: 'draft-7' });
      // Draft-7 cannot compare two fields without a nonstandard extension.
      // Consumers must run these named semantic checks after structural validation.
      if (name === 'joinPending') {
        Object.assign(exported, { 'x-semanticChecks': ['bootstrapSessionIdEqualsSessionId'] });
      }
      if (name === 'joinError') {
        Object.assign(exported, { 'x-semanticChecks': ['retryAfterMsOnlyForRateLimited'] });
      }
      return [name, exported];
    }),
  );
}
