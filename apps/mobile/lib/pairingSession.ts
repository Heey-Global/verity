import { VerityClient, type OnboardingStatus } from '@verity/mobile';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { setVerityBaseUrl } from './client';
import { deviceLabel } from './deviceLabel';
import { copyAuthTokenToEndpoint } from './authToken';
import { setAuthToken } from './authToken';
import type { VerityPairingPayload } from './pairing';
import { createPinnedFetch, verifyPairedIdentity } from './pinnedTransport';
import {
  getServerProfile,
  profileFromPairing,
  saveServerProfile,
  selectServerEndpoint,
  addServerEndpoint,
} from './serverProfile';

let bootstrap: { serverId: string; token: string; expiresAt: number } | null = null;
let enrollment: { serverId: string; pairingCode: string; token: string; tokenId: string } | null =
  null;
let enrollmentAttempt: { serverId: string; pairingCode: string; enrollmentId: string } | null =
  null;
const ENROLLMENT_ATTEMPT_KEY = 'verity.pairingEnrollmentAttempt.v1';

function challenge(): string {
  const bytes = getRandomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getEnrollmentAttempt(
  serverId: string,
  pairingCode: string,
): Promise<NonNullable<typeof enrollmentAttempt>> {
  if (enrollmentAttempt?.serverId === serverId && enrollmentAttempt.pairingCode === pairingCode) {
    return enrollmentAttempt;
  }
  try {
    const encoded = await SecureStore.getItemAsync(ENROLLMENT_ATTEMPT_KEY);
    if (encoded !== null) {
      const stored = JSON.parse(encoded) as Partial<NonNullable<typeof enrollmentAttempt>>;
      if (
        stored.serverId === serverId &&
        stored.pairingCode === pairingCode &&
        typeof stored.enrollmentId === 'string'
      ) {
        enrollmentAttempt = stored as NonNullable<typeof enrollmentAttempt>;
        return enrollmentAttempt;
      }
    }
  } catch {
    // A corrupt or inaccessible retry record is replaced below.
  }
  enrollmentAttempt = { serverId, pairingCode, enrollmentId: challenge() };
  await SecureStore.setItemAsync(ENROLLMENT_ATTEMPT_KEY, JSON.stringify(enrollmentAttempt), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return enrollmentAttempt;
}

/** Complete TLS pinning + signed identity verification before persisting anything. */
export async function establishPairing(
  payload: VerityPairingPayload,
  selectedUrl: string,
): Promise<OnboardingStatus> {
  const profile = profileFromPairing(payload, selectedUrl);
  const pinnedFetch = createPinnedFetch(payload.tlsPin);
  const client = new VerityClient({
    baseUrl: profile.activeUrl,
    fetch: pinnedFetch,
    uploadFetch: pinnedFetch,
  });
  const nonce = challenge();
  const identity = await client.fetchPairingIdentity(nonce);
  if (identity.identityKey !== payload.identityKey) {
    throw new Error('The server identity key does not match the pairing code.');
  }
  await verifyPairedIdentity({
    identityKey: payload.identityKey,
    expectedServerId: payload.serverId,
    serverId: identity.serverId,
    challenge: nonce,
    signature: identity.signature,
  });
  const retained =
    payload.kind === 'installer' &&
    bootstrap?.serverId === payload.serverId &&
    bootstrap.expiresAt > Date.now()
      ? bootstrap
      : null;
  if (retained === null) {
    if (payload.kind === 'device') {
      const retained =
        enrollment?.serverId === payload.serverId && enrollment.pairingCode === payload.pairingCode
          ? enrollment
          : null;
      const attempt = await getEnrollmentAttempt(payload.serverId, payload.pairingCode);
      const enrolled =
        retained ??
        (await client.enrollPairingInvitation(
          payload.pairingCode,
          attempt.enrollmentId,
          deviceLabel(),
        ));
      enrollment = { serverId: payload.serverId, pairingCode: payload.pairingCode, ...enrolled };
      // Enrollment consumes the invitation. Persist its token and the already
      // verified identity before the best-effort status read, but never mutate
      // local routing for a rejected/expired invitation.
      const tokenPersisted = await setAuthToken(
        profile.activeUrl,
        enrolled.token,
        enrolled.tokenId,
      );
      if (!tokenPersisted) {
        throw new Error('Could not save the device credential. Try pairing again.');
      }
      await saveServerProfile(profile);
      await setVerityBaseUrl(profile.activeUrl);
      const authenticatedClient = new VerityClient({
        baseUrl: profile.activeUrl,
        fetch: pinnedFetch,
        uploadFetch: pinnedFetch,
        getToken: () => enrolled.token,
      });
      const status = await authenticatedClient.fetchOnboardingStatus();
      enrollment = null;
      enrollmentAttempt = null;
      await SecureStore.deleteItemAsync(ENROLLMENT_ATTEMPT_KEY);
      return status;
    }
    const redeemed = await client.redeemPairingCode(payload.pairingCode);
    const expiry = Date.parse(redeemed.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now())
      throw new Error('The pairing session expired.');
    // Redemption is one-time. Retain its short-lived result in memory before the
    // final status read so a transient failure can retry without replaying the
    // already-consumed pairing code.
    bootstrap = { serverId: payload.serverId, token: redeemed.bootstrapToken, expiresAt: expiry };
  }
  // Finish the last server-side validation before mutating local routing state.
  // A failed status request must not leave a half-selected endpoint or a usable
  // bootstrap capability behind.
  const status = await client.fetchOnboardingStatus();
  await saveServerProfile(profile);
  await setVerityBaseUrl(profile.activeUrl);
  return status;
}

/** Adopt another IP/DNS route only after it proves the already paired identity. */
export async function verifyAndSaveDirectEndpoint(selectedUrl: string): Promise<OnboardingStatus> {
  const profile = getServerProfile();
  const pinnedEndpoint = profile?.endpoints.find(
    (endpoint) => endpoint.transport === 'direct' && endpoint.tlsPin,
  );
  if (profile === null || pinnedEndpoint?.tlsPin === undefined) {
    throw new Error('Scan a pairing code before adding a direct server address.');
  }
  const endpointUrl = new URL(selectedUrl).origin;
  const pinnedFetch = createPinnedFetch(pinnedEndpoint.tlsPin);
  const client = new VerityClient({
    baseUrl: endpointUrl,
    fetch: pinnedFetch,
    uploadFetch: pinnedFetch,
  });
  const nonce = challenge();
  const identity = await client.fetchPairingIdentity(nonce);
  if (identity.identityKey !== profile.identityKey)
    throw new Error('The address belongs to another Verity server.');
  await verifyPairedIdentity({
    identityKey: profile.identityKey,
    expectedServerId: profile.serverId,
    serverId: identity.serverId,
    challenge: nonce,
    signature: identity.signature,
  });
  const status = await client.fetchOnboardingStatus();
  await copyAuthTokenToEndpoint(profile.activeUrl, endpointUrl);
  await addServerEndpoint({ url: endpointUrl, transport: 'direct', tlsPin: pinnedEndpoint.tlsPin });
  await selectServerEndpoint(endpointUrl);
  await setVerityBaseUrl(endpointUrl);
  return status;
}

/** Return the pending capability without discarding it before the request has a
 * chance to reach the server. The caller clears it after a successful response. */
export function getPairingBootstrap(serverId: string): string | null {
  const current = bootstrap;
  if (current === null || current.serverId !== serverId || current.expiresAt <= Date.now()) {
    if (current?.serverId === serverId) bootstrap = null;
    return null;
  }
  return current.token;
}

export function clearPairingBootstrap(serverId?: string, token?: string): void {
  if (serverId !== undefined && bootstrap?.serverId !== serverId) return;
  if (token !== undefined && bootstrap?.token !== token) return;
  bootstrap = null;
}
