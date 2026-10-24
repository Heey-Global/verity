import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type WebSocket from 'ws';
import { z } from 'zod';

const processBootId = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/u);
const endpoint = z.object({
  address: z.string().refine((value) => isIP(value) !== 0),
  port: z.number().int().min(1).max(65535),
});
export const coreDataAssociationSchema = z.object({
  schemaVersion: z.literal(1),
  bindingSource: z.literal('authenticated_control_session_request'),
  processBootId: z.string().uuid(),
  socketLifetimeId: z.string().uuid().nullable(),
  session: fingerprint,
  request: fingerprint,
  coverageStart: z.enum(['before_socket_creation', 'after_socket_creation']),
  activatedAt: z.string().datetime(),
  socketEndpoints: z.object({ local: endpoint.nullable(), remote: endpoint.nullable() }),
  uplinkConnectionId: z.null(),
  natAssociation: z.literal('unknown'),
  envoyAssociation: z.literal('unknown'),
});

/** Only direct Core socket observations; no proxy identity inferred from a tuple. */
export function coreDataAssociation(
  sessionId: string,
  requestId: string,
  socketLifetimeId: string | null,
  coverageStart: 'before_socket_creation' | 'after_socket_creation',
  activatedAt: string,
  ws?: WebSocket,
) {
  let socket: unknown;
  try {
    socket = (ws as (WebSocket & { _socket?: unknown }) | undefined)?._socket;
  } catch {
    // Optional runtime internals must not interrupt metadata export.
  }
  const source =
    typeof socket === 'object' && socket !== null ? (socket as Record<string, unknown>) : {};
  const readEndpoint = (side: 'local' | 'remote') => {
    try {
      const parsed = endpoint.safeParse({
        address: source[`${side}Address`],
        port: source[`${side}Port`],
      });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  return {
    schemaVersion: 1 as const,
    bindingSource: 'authenticated_control_session_request' as const,
    processBootId,
    socketLifetimeId,
    session: hash(sessionId),
    request: hash(requestId),
    coverageStart,
    activatedAt,
    socketEndpoints: { local: readEndpoint('local'), remote: readEndpoint('remote') },
    uplinkConnectionId: null,
    natAssociation: 'unknown' as const,
    envoyAssociation: 'unknown' as const,
  };
}
