import * as SecureStore from 'expo-secure-store';

import type { VerityPairingPayload } from './pairing';
import type { RemoteControlDescriptor } from '@verity/mobile';

const PROFILE_KEY = 'verity.serverProfile.v1';
const TOKEN = /^[A-Za-z0-9_-]+$/;
const PIN = /^sha256-[A-Za-z0-9_-]{43}$/;

export interface VerityServerEndpoint {
  url: string;
  transport: 'direct' | 'uplink';
  /** Direct self-hosted endpoints require their installer-pinned TLS public key. */
  tlsPin?: string;
}

export interface VerityServerProfile {
  version: 1;
  serverId: string;
  identityKey: string;
  activeUrl: string;
  endpoints: VerityServerEndpoint[];
  remoteControl?: {
    version: 1;
    installationId: string;
    installationHandle: string;
    uplinkOrigin: string;
  };
}

let currentProfile: VerityServerProfile | null = null;

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A paired server endpoint must use HTTPS.');
  }
  return url.origin;
}

function remoteControlOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Uplink origin.');
  }
  return url.origin;
}

function validateServerProfile(value: unknown): VerityServerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid server profile.');
  const candidate = value as Partial<VerityServerProfile>;
  if (
    candidate.version !== 1 ||
    typeof candidate.serverId !== 'string' ||
    !TOKEN.test(candidate.serverId) ||
    candidate.serverId.length < 16 ||
    candidate.serverId.length > 128 ||
    typeof candidate.identityKey !== 'string' ||
    !TOKEN.test(candidate.identityKey) ||
    candidate.identityKey.length < 40 ||
    candidate.identityKey.length > 128 ||
    !Array.isArray(candidate.endpoints) ||
    candidate.endpoints.length === 0 ||
    candidate.endpoints.length > 8
  ) {
    throw new Error('Invalid server profile.');
  }
  const endpoints = candidate.endpoints.map((entry) => {
    if (!entry || (entry.transport !== 'direct' && entry.transport !== 'uplink')) {
      throw new Error('Invalid server endpoint.');
    }
    const url = origin(entry.url);
    if (
      entry.transport === 'direct' &&
      (typeof entry.tlsPin !== 'string' || !PIN.test(entry.tlsPin))
    ) {
      throw new Error('A direct endpoint requires a valid TLS pin.');
    }
    if (entry.tlsPin !== undefined && !PIN.test(entry.tlsPin)) throw new Error('Invalid TLS pin.');
    return { url, transport: entry.transport, ...(entry.tlsPin ? { tlsPin: entry.tlsPin } : {}) };
  });
  if (new Set(endpoints.map(({ url }) => url)).size !== endpoints.length) {
    throw new Error('Duplicate server endpoint.');
  }
  const activeUrl = origin(candidate.activeUrl ?? '');
  if (!endpoints.some(({ url }) => url === activeUrl)) throw new Error('Unknown active endpoint.');
  const remote = candidate.remoteControl;
  if (
    remote !== undefined &&
    (remote.version !== 1 ||
      typeof remote.installationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        remote.installationId,
      ) ||
      typeof remote.installationHandle !== 'string' ||
      !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(remote.installationHandle) ||
      typeof remote.uplinkOrigin !== 'string')
  ) {
    throw new Error('Invalid remote control descriptor.');
  }
  return {
    version: 1,
    serverId: candidate.serverId,
    identityKey: candidate.identityKey,
    activeUrl,
    endpoints,
    ...(remote === undefined
      ? {}
      : {
          remoteControl: {
            version: 1,
            installationId: remote.installationId,
            installationHandle: remote.installationHandle,
            uplinkOrigin: remoteControlOrigin(remote.uplinkOrigin),
          },
        }),
  };
}

export function profileFromPairing(
  payload: VerityPairingPayload,
  selectedUrl: string,
): VerityServerProfile {
  return validateServerProfile({
    version: 1,
    serverId: payload.serverId,
    identityKey: payload.identityKey,
    activeUrl: selectedUrl,
    endpoints: [{ url: selectedUrl, transport: 'direct', tlsPin: payload.tlsPin }],
  });
}

export async function hydrateServerProfile(): Promise<VerityServerProfile | null> {
  currentProfile = null;
  try {
    const encoded = await SecureStore.getItemAsync(PROFILE_KEY);
    if (encoded !== null) currentProfile = validateServerProfile(JSON.parse(encoded));
  } catch (error) {
    currentProfile = null;
    throw new Error('Could not read the paired server profile.', { cause: error });
  }
  return currentProfile;
}

export function getServerProfile(): VerityServerProfile | null {
  return currentProfile;
}

/** Remove the paired identity when the app container proves this is a fresh
 * installation. SecureStore survives an iOS uninstall, unlike AsyncStorage. */
export async function clearServerProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(PROFILE_KEY);
  currentProfile = null;
}

export async function saveServerProfile(profile: VerityServerProfile): Promise<void> {
  const validated = validateServerProfile(profile);
  await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(validated), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  currentProfile = validated;
}

/** Add DNS/Uplink reachability without changing the paired security identity. */
export async function addServerEndpoint(
  endpoint: VerityServerEndpoint,
): Promise<VerityServerProfile> {
  if (currentProfile === null) throw new Error('No paired server profile.');
  const url = origin(endpoint.url);
  const endpoints = [
    ...currentProfile.endpoints.filter((entry) => entry.url !== url),
    { ...endpoint, url },
  ];
  const updated = validateServerProfile({ ...currentProfile, endpoints });
  await saveServerProfile(updated);
  return updated;
}

export async function selectServerEndpoint(url: string): Promise<VerityServerProfile> {
  if (currentProfile === null) throw new Error('No paired server profile.');
  const updated = validateServerProfile({ ...currentProfile, activeUrl: origin(url) });
  await saveServerProfile(updated);
  return updated;
}

/** Store only routing metadata learned from the authenticated, pinned Core API. */
export async function saveRemoteControlDescriptor(
  descriptor: RemoteControlDescriptor,
): Promise<VerityServerProfile> {
  if (currentProfile === null) throw new Error('No paired server profile.');
  const { remoteControl: _previous, ...profile } = currentProfile;
  const updated = validateServerProfile({
    ...profile,
    ...(descriptor.enabled
      ? {
          remoteControl: {
            version: 1,
            installationId: descriptor.installationId,
            installationHandle: descriptor.installationHandle,
            uplinkOrigin: descriptor.uplinkOrigin,
          },
        }
      : {}),
  });
  await saveServerProfile(updated);
  return updated;
}
