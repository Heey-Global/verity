import type { InvitationLinkFields } from '@verity/mobile';

import type { VerityServerProfile } from './serverProfile';

/** Unpadded base64url of a string's UTF-8 bytes. */
function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The `https://verity.build/join#…` link of an invitation (Uplink team contract
 * D5). The server supplies what it holds; this app adds the TLS pin and server
 * address it verified when it paired, which neither the server nor Uplink may
 * supply. Undefined when this profile has no pinned direct endpoint, or when
 * the server's identity does not match the one this app paired with.
 */
export function invitationLink(
  fields: InvitationLinkFields,
  profile: VerityServerProfile | null,
): string | undefined {
  if (profile === null) return undefined;
  if (fields.serverId !== profile.serverId || fields.identityKey !== profile.identityKey)
    return undefined;
  const pinned = profile.endpoints.find(
    (endpoint) => endpoint.transport === 'direct' && endpoint.tlsPin !== undefined,
  );
  if (pinned?.tlsPin === undefined) return undefined;
  const envelope = {
    version: 1,
    purpose: 'team-member',
    invitationId: fields.invitationId,
    secret: fields.secret,
    expiresAt: fields.expiresAt,
    serverId: fields.serverId,
    identityKey: fields.identityKey,
    tlsPin: pinned.tlsPin,
    coreOrigin: new URL(pinned.url).origin,
    uplinkOrigin: fields.uplinkOrigin,
    installationId: fields.installationId,
    installationHandle: fields.installationHandle,
    ...(fields.display === undefined ? {} : { display: fields.display }),
  };
  return `https://verity.build/join#${base64Url(JSON.stringify(envelope))}`;
}

/** A decoded join link: what the invited person's app needs to reach and trust the server. */
export interface TeamJoinLink {
  invitationId: string;
  secret: string;
  expiresAt: number;
  serverId: string;
  identityKey: string;
  tlsPin: string;
  coreOrigin: string;
  uplinkOrigin: string;
  installationId: string;
  installationHandle: string;
  display?: { inviterName: string; projectName: string };
}

export class TeamJoinLinkError extends Error {
  constructor(readonly reason: 'invalid' | 'expired') {
    super(
      reason === 'expired' ? 'This invitation has expired.' : 'This is not a Verity invitation.',
    );
  }
}

// The field shapes of the team contract's `invitationLink` schema.
const BYTES16 = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const BYTES32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const PIN = /^sha256-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const IDENTITY_KEY = /^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SERVER_ID = /^srv_[A-Za-z0-9_-]{21}[AQgw]$/u;
const ORIGIN = /^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/u;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const FIELDS = new Set([
  'version',
  'purpose',
  'invitationId',
  'secret',
  'expiresAt',
  'serverId',
  'identityKey',
  'tlsPin',
  'coreOrigin',
  'uplinkOrigin',
  'installationId',
  'installationHandle',
  'display',
]);

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TeamJoinLinkError('invalid');
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

const displayText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 80 && /^[^\p{Cc}\u2028\u2029]+$/u.test(value);

/**
 * Decode `https://verity.build/join#…` (Uplink team contract D5). Only the
 * fragment carries the invitation, so neither the web page nor any server log
 * ever sees the secret. The server id's derivation from the identity key is
 * checked when connecting, with the signed identity proof.
 */
export function parseTeamJoinLink(raw: string, now: Date = new Date()): TeamJoinLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TeamJoinLinkError('invalid');
  }
  if (url.protocol !== 'https:' || url.host !== 'verity.build' || url.pathname !== '/join')
    throw new TeamJoinLinkError('invalid');
  let value: unknown;
  try {
    value = JSON.parse(fromBase64Url(url.hash.slice(1)));
  } catch {
    throw new TeamJoinLinkError('invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TeamJoinLinkError('invalid');
  const link = value as Record<string, unknown>;
  const display = link.display as Record<string, unknown> | undefined;
  const valid =
    Object.keys(link).every((key) => FIELDS.has(key)) &&
    link.version === 1 &&
    link.purpose === 'team-member' &&
    typeof link.invitationId === 'string' &&
    BYTES32.test(link.invitationId) &&
    typeof link.secret === 'string' &&
    BYTES32.test(link.secret) &&
    Number.isSafeInteger(link.expiresAt) &&
    (link.expiresAt as number) >= 1 &&
    typeof link.serverId === 'string' &&
    SERVER_ID.test(link.serverId) &&
    typeof link.identityKey === 'string' &&
    IDENTITY_KEY.test(link.identityKey) &&
    typeof link.tlsPin === 'string' &&
    PIN.test(link.tlsPin) &&
    typeof link.coreOrigin === 'string' &&
    ORIGIN.test(link.coreOrigin) &&
    typeof link.uplinkOrigin === 'string' &&
    ORIGIN.test(link.uplinkOrigin) &&
    typeof link.installationId === 'string' &&
    UUID.test(link.installationId) &&
    typeof link.installationHandle === 'string' &&
    BYTES16.test(link.installationHandle) &&
    (display === undefined ||
      (typeof display === 'object' &&
        display !== null &&
        !Array.isArray(display) &&
        Object.keys(display).every((key) => key === 'inviterName' || key === 'projectName') &&
        displayText(display.inviterName) &&
        displayText(display.projectName)));
  if (!valid) throw new TeamJoinLinkError('invalid');
  if ((link.expiresAt as number) <= now.getTime()) throw new TeamJoinLinkError('expired');
  return {
    invitationId: link.invitationId as string,
    secret: link.secret as string,
    expiresAt: link.expiresAt as number,
    serverId: link.serverId as string,
    identityKey: link.identityKey as string,
    tlsPin: link.tlsPin as string,
    coreOrigin: link.coreOrigin as string,
    uplinkOrigin: link.uplinkOrigin as string,
    installationId: link.installationId as string,
    installationHandle: link.installationHandle as string,
    ...(display === undefined
      ? {}
      : {
          display: {
            inviterName: display.inviterName as string,
            projectName: display.projectName as string,
          },
        }),
  };
}

/** `srv_` + base64url of the first 16 bytes of SHA-256("verity.device-pairing.v1.server-id" NUL identityKey). */
export async function serverIdFor(
  identityKey: string,
  sha256: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>,
): Promise<string> {
  const digest = new Uint8Array(
    await sha256(new TextEncoder().encode(`verity.device-pairing.v1.server-id\0${identityKey}`)),
  );
  let binary = '';
  for (const byte of digest.subarray(0, 16)) binary += String.fromCharCode(byte);
  return `srv_${btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}
