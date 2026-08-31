import * as SecureStore from 'expo-secure-store';

import type { VerityPairingPayload } from './pairing';

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
}

let currentProfile: VerityServerProfile | null = null;

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A paired server endpoint must use HTTPS.');
  }
  return url.origin;
}

export function validateServerProfile(value: unknown): VerityServerProfile {
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
  return {
    version: 1,
    serverId: candidate.serverId,
    identityKey: candidate.identityKey,
    activeUrl,
    endpoints,
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
