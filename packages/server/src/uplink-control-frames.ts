import type WebSocket from 'ws';

export interface RemoteConnectorReservation {
  readonly diagnosticId?: string;
  /** Resolves only after the data attachment succeeds; owns the fixed TLS destination. */
  attach(ticket: string, expiresAt: number, signal: AbortSignal): Promise<void>;
  release(reason: string): void;
  /** Optional terminal signal for connectors whose data socket can close independently. */
  closed?: Promise<void>;
}

export interface RemoteConnectorRequest {
  requestId: string;
  sessionId: string;
  decisionExpiresAt: number;
  /** Remote Control when absent; a team join's tunnel otherwise. */
  capability?: typeof TEAM_BOOTSTRAP_CAPABILITY;
}

/** What Uplink asks Core when an app wants to join a project (team bootstrap v1). */
export interface TeamJoinPending {
  requestId: string;
  sessionId: string;
  invitationId: string;
  redemptionId: string;
  projectId: string;
  permissions: string[];
  decisionExpiresAt: number;
}

// Frames of the Uplink control connection: their exact shapes, checked before
// the client acts on them, and the reasons it sends back.

export const REMOTE_CAPABILITY = 'remote-control-v1';
export const TEAM_BOOTSTRAP_CAPABILITY = 'team-bootstrap-v1';
export const MAX_REFUSAL_REASON_CHARS = 200;
/** Hard WebSocket limit on a close reason; `ws` throws above it. */
export const MAX_CLOSE_REASON_BYTES = 123;

export function validInstallationHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{22}$/u.test(value) &&
    Buffer.from(value, 'base64url').length === 16 &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

export function stringField(frame: Record<string, unknown>, key: string): string {
  const value = frame[key];
  if (typeof value !== 'string' || !value) throw new Error(`invalid Uplink ${key}`);
  return value;
}

export function remoteNegotiation(frame: Record<string, unknown>): {
  capabilities: Set<string>;
  channels: Set<string>;
} {
  const names = (value: unknown, fallback: string[], allowEmpty: boolean): Set<string> => {
    if (value === undefined) return new Set(fallback);
    if (!Array.isArray(value) || value.length > 32 || (!allowEmpty && value.length === 0)) {
      throw new Error('invalid Uplink negotiation');
    }
    const result = new Set<string>();
    for (const name of value as unknown[]) {
      if (
        typeof name !== 'string' ||
        !/^[\x21-\x7e]{1,64}(?![\s\S])/.test(name) ||
        result.has(name)
      ) {
        throw new Error('invalid Uplink negotiation');
      }
      result.add(name);
    }
    return result;
  };
  return {
    capabilities: names(frame.capabilities, [], true),
    channels: names(frame.channels, ['http', 'ws'], false),
  };
}

export function validRemoteSessionRequest(frame: Record<string, unknown>): boolean {
  const keys = Object.keys(frame);
  if (
    keys.length !== 5 ||
    !['type', 'requestId', 'sessionId', 'capability', 'decisionExpiresAt'].every((key) =>
      Object.hasOwn(frame, key),
    )
  )
    return false;
  const validId = (value: unknown): boolean =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value);
  return (
    frame.type === 'session.request' &&
    validId(frame.requestId) &&
    validId(frame.sessionId) &&
    frame.capability === REMOTE_CAPABILITY &&
    typeof frame.decisionExpiresAt === 'number' &&
    Number.isSafeInteger(frame.decisionExpiresAt) &&
    frame.decisionExpiresAt > 0
  );
}

/** `team.join.pending` exactly as team bootstrap interface v1 defines it. */
export function validTeamJoinPending(frame: Record<string, unknown>): boolean {
  const keys = [
    'type',
    'requestId',
    'sessionId',
    'invitationId',
    'redemptionId',
    'projectId',
    'permissions',
    'bootstrapSessionId',
    'decisionExpiresAt',
    'capability',
  ];
  const permissions = frame.permissions;
  return (
    Object.keys(frame).length === keys.length &&
    keys.every((key) => Object.hasOwn(frame, key)) &&
    frame.type === 'team.join.pending' &&
    validRemoteId(frame.requestId) &&
    validRemoteId(frame.sessionId) &&
    typeof frame.invitationId === 'string' &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(frame.invitationId) &&
    validRemoteId(frame.redemptionId) &&
    validRemoteId(frame.projectId) &&
    Array.isArray(permissions) &&
    (JSON.stringify(permissions) === '["read"]' ||
      JSON.stringify(permissions) === '["read","execute"]') &&
    frame.bootstrapSessionId === frame.sessionId &&
    typeof frame.decisionExpiresAt === 'number' &&
    Number.isSafeInteger(frame.decisionExpiresAt) &&
    frame.decisionExpiresAt > 0 &&
    frame.capability === TEAM_BOOTSTRAP_CAPABILITY
  );
}

export function validTeamSessionTicket(frame: Record<string, unknown>): boolean {
  return (
    Object.keys(frame).length === 6 &&
    frame.type === 'session.ticket' &&
    validRemoteId(frame.sessionId) &&
    validRemoteId(frame.redemptionId) &&
    typeof frame.ticket === 'string' &&
    /^[A-Za-z0-9_-]{1,512}$/.test(frame.ticket) &&
    typeof frame.expiresAt === 'number' &&
    Number.isSafeInteger(frame.expiresAt) &&
    frame.capability === TEAM_BOOTSTRAP_CAPABILITY
  );
}

export function validRemoteSessionCancelled(frame: Record<string, unknown>): boolean {
  return (
    Object.keys(frame).length === 3 &&
    frame.type === 'session.cancelled' &&
    validRemoteId(frame.sessionId) &&
    ['cancelled', 'timeout', 'unavailable'].includes(frame.code as string)
  );
}

export function validRemoteSessionTicket(frame: Record<string, unknown>): boolean {
  return (
    Object.keys(frame).length === 5 &&
    frame.type === 'session.ticket' &&
    validRemoteId(frame.sessionId) &&
    typeof frame.ticket === 'string' &&
    /^[A-Za-z0-9_-]{1,512}$/.test(frame.ticket) &&
    typeof frame.expiresAt === 'number' &&
    Number.isSafeInteger(frame.expiresAt) &&
    frame.capability === REMOTE_CAPABILITY
  );
}

export function validRemoteId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validatedBindingUrl(
  frame: Record<string, unknown>,
  key: string,
  protocol: 'https:' | 'wss:',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(stringField(frame, key));
  } catch {
    throw new Error(`invalid Uplink ${key}`);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`invalid Uplink ${key}`);
  }
  return parsed;
}

export function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** A refusal reason is a protocol token, but it arrives as free text bounded
 * only by the frame limit, and an identity-class one is then pinned into the
 * message the app shows until the credentials change. Cap it at the point it
 * enters that state rather than trusting the far end to be terse. */
export function refusalReason(value: unknown, fallback: string): string {
  // Newlines and control characters go too, and for the same reason the length
  // does: this string is pinned into an app-facing message and into a
  // structured log line, and a reason carrying its own line breaks forges a
  // record that reads as several.
  const reason = optionalString(value, fallback).replace(/\p{C}/gu, ' ');
  if (reason.length <= MAX_REFUSAL_REASON_CHARS) return reason;
  // By code point, not by unit: slicing a string this side never chose the
  // shape of can otherwise end on half a surrogate pair, and the replacement
  // character that produces is exactly the kind of detail that gets read as
  // corruption somewhere downstream.
  return `${[...reason].slice(0, MAX_REFUSAL_REASON_CHARS).join('')}…`;
}

/** `ws` throws a RangeError on a close reason over 123 bytes. Thrown from here
 * it would land in the frame handler's catch, which reports a refusal we
 * understood perfectly as an unparseable frame and closes with 1002 instead of
 * 4003 — turning the one log line that names the cause into a misleading one.
 * The far end already knows why it refused us, so echoing anything at all is a
 * courtesy; drop back to the fallback token rather than truncating into a
 * split UTF-8 sequence. */
export function closeReason(reason: string, fallback: string): string {
  return Buffer.byteLength(reason) <= MAX_CLOSE_REASON_BYTES ? reason : fallback;
}

export function validUplinkShareId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function rawDataText(value: WebSocket.RawData): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return Buffer.concat(value).toString('utf8');
  return Buffer.from(value).toString('utf8');
}
