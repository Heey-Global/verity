// Review contract for personal Remote Control v1. Production transports do not import this.
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/);
const ticket = z.string().regex(/^[A-Za-z0-9_-]{1,512}(?![\s\S])/);
const timeMs = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const capability = z.literal('remote-control-v1');
const object = z.strictObject;

export const schemas = {
  negotiation: object({
    capabilities: z
      .array(z.string().regex(/^[\x21-\x7e]{1,64}(?![\s\S])/))
      .max(32)
      .optional(),
    channels: z
      .array(z.string().regex(/^[\x21-\x7e]{1,64}(?![\s\S])/))
      .min(1)
      .max(32)
      .optional(),
  }),
  connect: object({
    type: z.literal('connect'),
    requestId: id,
    installationHandle: id,
    capabilities: z
      .array(z.string().regex(/^[\x21-\x7e]{1,64}(?![\s\S])/))
      .min(1)
      .max(32),
  }),
  sessionRequest: object({
    type: z.literal('session.request'),
    requestId: id,
    sessionId: id,
    capability,
    decisionExpiresAt: timeMs,
  }),
  sessionAccept: object({ type: z.literal('session.accept'), sessionId: id }),
  sessionRefuse: object({
    type: z.literal('session.refuse'),
    sessionId: id,
    code: z.enum(['unavailable', 'limit_reached']),
  }),
  sessionTicket: object({
    type: z.literal('session.ticket'),
    sessionId: id,
    ticket,
    expiresAt: timeMs,
    capability,
  }),
  connectReady: object({
    type: z.literal('connect.ready'),
    requestId: id,
    sessionId: id,
    ticket,
    expiresAt: timeMs,
    capability,
  }),
  connectError: object({
    type: z.literal('connect.error'),
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
  connectCancel: object({ type: z.literal('connect.cancel'), requestId: id }),
  sessionCancelled: object({
    type: z.literal('session.cancelled'),
    sessionId: id,
    code: z.enum(['cancelled', 'timeout', 'unavailable']),
  }),
  attach: object({ type: z.literal('attach'), ticket }),
  attached: object({ type: z.literal('attached'), sessionId: id, capability }),
  streamOpen: object({
    type: z.literal('stream.open'),
    streamId: id,
    channel: z.literal('remote'),
    meta: object({}),
  }),
  streamData: object({
    type: z.literal('stream.data'),
    streamId: id,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    payload: z
      .string()
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/),
  }),
  streamEnd: object({ type: z.literal('stream.end'), streamId: id }),
  streamReset: object({
    type: z.literal('stream.reset'),
    streamId: id,
    code: z.enum(['protocol_error', 'concurrency_limit', 'upstream_error', 'timeout']),
  }),
};

export type SchemaName = keyof typeof schemas;

export function accepts(name: SchemaName, value: unknown): boolean {
  if (!schemas[name].safeParse(value).success) return false;
  if (name === 'negotiation') {
    const { capabilities, channels } = value as { capabilities?: string[]; channels?: string[] };
    return (
      (!capabilities || new Set(capabilities).size === capabilities.length) &&
      (!channels || new Set(channels).size === channels.length)
    );
  }
  if (name === 'connect') {
    const { capabilities } = value as { capabilities: string[] };
    return (
      capabilities.includes('remote-control-v1') &&
      new Set(capabilities).size === capabilities.length
    );
  }
  if (name === 'connectError') {
    const error = value as { code: string; retryAfterMs?: number };
    return error.retryAfterMs === undefined || error.code === 'rate_limited';
  }
  if (name === 'streamData') {
    const { payload } = value as { payload: string };
    return (
      Buffer.byteLength(payload, 'utf8') <= 87_384 &&
      Buffer.from(payload, 'base64').length <= 65_536 &&
      Buffer.from(payload, 'base64').toString('base64') === payload
    );
  }
  return true;
}

export function jsonSchemas() {
  const semanticChecks: Record<string, string[]> = {
    negotiation: ['uniqueNames'],
    connect: ['offeredRemoteCapability', 'uniqueCapabilityNames'],
    connectError: ['retryAfterMsOnlyForRateLimited'],
    streamData: ['canonicalBase64', 'decodedChunkAtMost65536Bytes'],
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const exported = z.toJSONSchema(schema, { target: 'draft-7' });
      if (semanticChecks[name])
        Object.assign(exported, { 'x-semanticChecks': semanticChecks[name] });
      return [name, exported];
    }),
  );
}
