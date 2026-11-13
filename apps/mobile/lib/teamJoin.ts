import { VerityApiError, VerityClient } from '@verity/mobile';
import { CryptoDigestAlgorithm, digest, getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { clearStoredAuthState, setAuthToken } from './authToken';
import { setVerityBaseUrl } from './client';
import { deviceLabel } from './deviceLabel';
import { createPinnedFetch, verifyPairedIdentity } from './pinnedTransport';
import { getServerProfile, saveServerProfile, type VerityServerProfile } from './serverProfile';
import { serverIdFor, TeamJoinLinkError, type TeamJoinLink } from './teamInvitationLink';

const ATTEMPT_KEY = 'verity.teamJoinAttempt.v1';

function randomId(): string {
  let binary = '';
  for (const byte of getRandomBytes(32)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The redemption id of this invitation, kept across app restarts: once the
 * server redeemed it, only a retry with the same id pairs this device again.
 */
async function redemptionIdFor(invitationId: string): Promise<string> {
  try {
    const stored = await SecureStore.getItemAsync(ATTEMPT_KEY);
    if (stored !== null) {
      const attempt = JSON.parse(stored) as { invitationId?: unknown; redemptionId?: unknown };
      if (attempt.invitationId === invitationId && typeof attempt.redemptionId === 'string')
        return attempt.redemptionId;
    }
  } catch {
    // A corrupt record is replaced below.
  }
  const redemptionId = randomId();
  await SecureStore.setItemAsync(ATTEMPT_KEY, JSON.stringify({ invitationId, redemptionId }), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return redemptionId;
}

export class TeamJoinError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'other_server' | 'identity',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Join the project of an invitation (ADR 0023 §7). The server is reached only
 * at the link's address and trusted only through its pinned TLS key and signed
 * identity, exactly as pairing does; the link's own claims prove nothing. The
 * device token is stored before anything else changes, so a lost answer after
 * the redemption is retried as a replay.
 */
export async function joinTeam(
  link: TeamJoinLink,
  displayName: string,
): Promise<{ projectId: string }> {
  if (link.expiresAt <= Date.now()) throw new TeamJoinLinkError('expired');
  const current = getServerProfile();
  // One server per app until server profiles can be kept side by side.
  if (current !== null && current.serverId !== link.serverId) {
    throw new TeamJoinError(
      'other_server',
      'This app is already connected to another Verity server.',
    );
  }
  if (current !== null) {
    throw new TeamJoinError('other_server', 'This app is already connected to this server.');
  }
  const derived = await serverIdFor(link.identityKey, (bytes) =>
    digest(CryptoDigestAlgorithm.SHA256, bytes),
  );
  if (derived !== link.serverId) throw new TeamJoinLinkError('invalid');

  const pinnedFetch = createPinnedFetch(link.tlsPin);
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

  let joined;
  try {
    joined = await client.joinTeam({
      invitationId: link.invitationId,
      secret: link.secret,
      redemptionId: await redemptionIdFor(link.invitationId),
      displayName: displayName.trim(),
      deviceLabel: deviceLabel(),
    });
  } catch (error) {
    if (error instanceof VerityApiError && error.status === 410)
      throw new TeamJoinError('unavailable', 'This invitation can no longer be used.');
    throw error;
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
  };
  await saveServerProfile(profile);
  await setVerityBaseUrl(link.coreOrigin);
  await SecureStore.deleteItemAsync(ATTEMPT_KEY).catch(() => undefined);
  return { projectId: joined.projectId };
}
