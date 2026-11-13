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
