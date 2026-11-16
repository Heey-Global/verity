import * as SecureStore from 'expo-secure-store';

import type { VerityPairingPayload } from './pairing';
import type { RemoteControlDescriptor } from '@verity/mobile';

const PROFILE_KEY = 'verity.serverProfile.v1';
// The servers this app knows besides the active one (ADR 0023 §7). The active
// profile keeps its own key, so everything reading it is unchanged.
const OTHERS_KEY = 'verity.serverProfiles.others.v1';
const MAX_PROFILES = 16;
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
  /** Whose server this is, for a server this app joined through an invitation. */
  sharedBy?: string;
}

let currentProfile: VerityServerProfile | null = null;
let otherProfiles: VerityServerProfile[] = [];
let revision = 0;
const revisionListeners = new Set<() => void>();

/** Bumped when the app switches to another server; the app shell remounts on it. */
export function getServerRevision(): number {
  return revision;
}

export function subscribeServerRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => {
    revisionListeners.delete(listener);
  };
}

export function bumpServerRevision(): void {
  revision += 1;
  for (const listener of revisionListeners) listener();
}

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
  const sharedBy = candidate.sharedBy;
  if (
    sharedBy !== undefined &&
    (typeof sharedBy !== 'string' ||
      sharedBy.length === 0 ||
      sharedBy.length > 80 ||
      /[\p{Cc}\u2028\u2029]/u.test(sharedBy))
  ) {
    throw new Error('Invalid server profile.');
  }
  return {
    version: 1,
    serverId: candidate.serverId,
    identityKey: candidate.identityKey,
    activeUrl,
    endpoints,
    ...(sharedBy === undefined ? {} : { sharedBy }),
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

async function readOthers(): Promise<VerityServerProfile[]> {
  try {
    const encoded = await SecureStore.getItemAsync(OTHERS_KEY);
    if (encoded === null) return [];
    const parsed = JSON.parse(encoded) as unknown;
    if (!Array.isArray(parsed)) return [];
    const profiles: VerityServerProfile[] = [];
    for (const entry of parsed.slice(0, MAX_PROFILES)) {
      try {
        profiles.push(validateServerProfile(entry));
      } catch {
        // One unreadable profile must not take the others with it.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

async function writeOthers(profiles: VerityServerProfile[]): Promise<void> {
  await SecureStore.setItemAsync(OTHERS_KEY, JSON.stringify(profiles), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  otherProfiles = profiles;
}

export async function hydrateServerProfile(): Promise<VerityServerProfile | null> {
  currentProfile = null;
  otherProfiles = [];
  try {
    const encoded = await SecureStore.getItemAsync(PROFILE_KEY);
    if (encoded !== null) currentProfile = validateServerProfile(JSON.parse(encoded));
  } catch (error) {
    currentProfile = null;
    throw new Error('Could not read the paired server profile.', { cause: error });
  }
  otherProfiles = await readOthers();
  return currentProfile;
}

export function getServerProfile(): VerityServerProfile | null {
  return currentProfile;
}

/** Remove the paired identity when the app container proves this is a fresh
 * installation. SecureStore survives an iOS uninstall, unlike AsyncStorage. */
export async function clearServerProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(PROFILE_KEY);
  await SecureStore.deleteItemAsync(OTHERS_KEY);
  currentProfile = null;
  otherProfiles = [];
}

/** The servers this app knows besides the active one. */
export function getOtherServerProfiles(): readonly VerityServerProfile[] {
  return otherProfiles;
}

/**
 * Make a known or new server the active one. The previously active server is
 * kept among the others, so the app can switch back to it.
 */
export async function activateServerProfile(profile: VerityServerProfile): Promise<void> {
  const next = validateServerProfile(profile);
  const previous = currentProfile;
  const others = otherProfiles.filter((entry) => entry.serverId !== next.serverId);
  if (previous !== null && previous.serverId !== next.serverId) others.unshift(previous);
  if (others.length >= MAX_PROFILES) throw new Error('This app knows too many servers.');
  // Three writes, each leaving both servers stored somewhere: first the others
  // with the new one still among them, then the new active one, then the
  // others without it. An interruption leaves a duplicate, never a lost server.
  await writeOthers([...others, next]);
  await saveServerProfile(next);
  await writeOthers(others);
}

/** Forget a server that is not the active one. */
export async function removeOtherServerProfile(serverId: string): Promise<void> {
  await writeOthers(otherProfiles.filter((entry) => entry.serverId !== serverId));
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
  if (!descriptor.enabled && descriptor.reason === 'unavailable') return currentProfile;
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
