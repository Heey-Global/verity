import { VerityApiError, VerityClient } from '@verity/mobile';
import { CryptoDigestAlgorithm, digest, getRandomBytes } from 'expo-crypto';
import { requireNativeModule } from 'expo-modules-core';

import { clearStoredAuthState, setAuthToken } from './authToken';
import { setVerityBaseUrl } from './client';
import { deviceLabel } from './deviceLabel';
import { createPinnedFetch, verifyPairedIdentity } from './pinnedTransport';
import {
  activateServerProfile,
  getOtherServerProfiles,
  getServerProfile,
  type VerityServerProfile,
} from './serverProfile';
import { serverIdFor, TeamJoinLinkError, type TeamJoinLink } from './teamInvitationLink';
import { requestTeamJoinAdmission, TeamJoinAdmissionError } from './teamJoinAdmission';

function randomId(): string {
  let binary = '';
  for (const byte of getRandomBytes(32)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** The native tunnel Remote Control uses; a join borrows it for one enrollment. */
export interface JoinTunnel {
  start(dataUrl: string, ticket: string, sessionId: string, coreUrl: string): Promise<number>;
  stop(): Promise<void>;
}

export interface JoinTeamDeps {
  admission?: typeof requestTeamJoinAdmission;
  tunnel?: () => JoinTunnel;
}

export class TeamJoinError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'known_server' | 'identity',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Join the project of an invitation (ADR 0023 §7). The app reserves the join at
 * Uplink, which opens a tunnel to the server once the server accepted it, so
 * the inviter's server is reachable from any network. The server is trusted
 * only through the link's pinned TLS key and signed identity, exactly as
 * pairing does; neither Uplink nor the link's own claims prove anything. The
 * redemption is the one Uplink minted for this tunnel; the app never makes one.
 */
export async function joinTeam(
  link: TeamJoinLink,
  displayName: string,
  deps: JoinTeamDeps = {},
): Promise<{ projectId: string }> {
  if (link.expiresAt <= Date.now()) throw new TeamJoinLinkError('expired');
  // A server this app already uses keeps its own credential; a second one for
  // the same server would sign this device in as someone else.
  const known = [getServerProfile(), ...getOtherServerProfiles()];
  if (known.some((profile) => profile?.serverId === link.serverId)) {
    throw new TeamJoinError('known_server', 'This app is already connected to this server.');
  }
  const derived = await serverIdFor(link.identityKey, (bytes) =>
    digest(CryptoDigestAlgorithm.SHA256, bytes),
  );
  if (derived !== link.serverId) throw new TeamJoinLinkError('invalid');

  let admission;
  try {
    admission = await (deps.admission ?? requestTeamJoinAdmission)({
      uplinkOrigin: link.uplinkOrigin,
      installationHandle: link.installationHandle,
      invitationId: link.invitationId,
    });
  } catch (error) {
    // Unknown, cancelled, expired and used invitations all read the same.
    if (error instanceof TeamJoinAdmissionError && error.code === 'unavailable')
      throw new TeamJoinError('unavailable', 'This invitation can no longer be used.');
    throw error;
  }
  const tunnel = (
    deps.tunnel ?? (() => requireNativeModule<JoinTunnel>('VerityRemoteControlTunnel'))
  )();
  const dataUrl = new URL(link.uplinkOrigin);
  dataUrl.protocol = 'wss:';
  dataUrl.pathname = '/data';
  let port: number;
  try {
    port = await tunnel.start(dataUrl.href, admission.ticket, admission.sessionId, link.coreOrigin);
  } finally {
    admission.finish();
  }

  let joined;
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error('The join tunnel did not open.');
    const pinnedFetch = createPinnedFetch(link.tlsPin, false, port);
    const client = new VerityClient({
      baseUrl: link.coreOrigin,
      fetch: pinnedFetch,
      uploadFetch: pinnedFetch,
    });
    const challenge = randomId();
    const identity = await client.fetchPairingIdentity(challenge);
    if (identity.identityKey !== link.identityKey)
      throw new TeamJoinError('identity', 'The server is not the one that sent this invitation.');
    await verifyPairedIdentity({
      identityKey: link.identityKey,
      expectedServerId: link.serverId,
      serverId: identity.serverId,
      challenge,
      signature: identity.signature,
    });
    const request = {
      invitationId: link.invitationId,
      secret: link.secret,
      redemptionId: admission.redemptionId,
      displayName: displayName.trim(),
      deviceLabel: deviceLabel(),
    };
    try {
      try {
        joined = await client.joinTeam(request);
      } catch (error) {
        // A lost answer: the same redemption again is a replay, not a second join.
        if (error instanceof VerityApiError) throw error;
        joined = await client.joinTeam(request);
      }
    } catch (error) {
      if (error instanceof VerityApiError && error.status === 410)
        throw new TeamJoinError('unavailable', 'This invitation can no longer be used.');
      throw error;
    }
  } finally {
    await tunnel.stop().catch(() => undefined);
  }

  // A previous installation may have left credentials for this address behind.
  await clearStoredAuthState(link.coreOrigin);
  if (!(await setAuthToken(link.coreOrigin, joined.token, joined.tokenId)))
    throw new Error('Could not save the device credential. Open the invitation again.');
  const profile: VerityServerProfile = {
    version: 1,
    serverId: link.serverId,
    identityKey: link.identityKey,
    activeUrl: link.coreOrigin,
    endpoints: [{ url: link.coreOrigin, transport: 'direct', tlsPin: link.tlsPin }],
    remoteControl: {
      version: 1,
      installationId: link.installationId,
      installationHandle: link.installationHandle,
      uplinkOrigin: link.uplinkOrigin,
    },
    ...(link.display === undefined ? {} : { sharedBy: link.display.inviterName }),
  };
  // The server used so far stays known, so the app can switch back to it.
  await activateServerProfile(profile);
  await setVerityBaseUrl(link.coreOrigin);
  return { projectId: joined.projectId };
}
