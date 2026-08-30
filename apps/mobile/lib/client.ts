import AsyncStorage from '@react-native-async-storage/async-storage';
import { VerityClient, normalizeServerUrl } from '@verity/mobile';
import { fetch as expoFetch } from 'expo/fetch';
import { clearAuthToken, getAuthToken } from './authToken';
import { createPinnedFetch } from './pinnedTransport';
import { getServerProfile, hydrateServerProfile } from './serverProfile';

// The control-plane base URL (e.g. a Tailscale address of the server). It is
// RUNTIME-configurable + persisted on the device: the operator enters it in the
// server connection preflight, so every build ships without a hardcoded server.
const STORAGE_KEY = 'verity.serverUrl';

// Module-level current value. Starts unset; `hydrateVerityBaseUrl` loads only a
// device-persisted value, and `setVerityBaseUrl` updates it when the operator
// (re)configures the server.
let currentBaseUrl: string | null = null;
let configuredBaseUrl = false;

/**
 * Load the persisted base URL from AsyncStorage into module state. Call ONCE at
 * app startup before the first render (so `getVerityBaseUrl()`/`createVerityClient()`
 * see the persisted value). Robust by design: a read failure or an absent value
 * leaves the URL unset so the connection preflight runs.
 *
 * Older dev builds may have persisted a path-bearing value such as
 * `http://dev-server:8082/api`; rewrite it at the source so all clients receive
 * the control-plane origin only.
 */
export async function hydrateVerityBaseUrl(): Promise<void> {
  currentBaseUrl = null;
  configuredBaseUrl = false;
  try {
    const profile = await hydrateServerProfile();
    if (profile !== null) {
      currentBaseUrl = profile.activeUrl;
      configuredBaseUrl = true;
      return;
    }
    const persisted = await AsyncStorage.getItem(STORAGE_KEY);
    if (persisted !== null && persisted !== '') {
      const normalized = normalizeServerUrl(persisted);
      if (normalized !== null) {
        currentBaseUrl = normalized;
        configuredBaseUrl = true;
        if (normalized !== persisted) await AsyncStorage.setItem(STORAGE_KEY, normalized);
      }
    }
  } catch {
    // Keep unset; a broken local cache must not block startup.
  }
}

/** The current control-plane base URL, or `null` when unset. Consumers call this
 *  at render (never a captured const) so they observe
 *  the runtime value hydrated/updated by `hydrateVerityBaseUrl`/`setVerityBaseUrl`. */
export function getVerityBaseUrl(): string | null {
  return currentBaseUrl;
}

/** Whether the device has explicitly selected a Verity server URL. */
export function hasConfiguredVerityBaseUrl(): boolean {
  return configuredBaseUrl;
}

/**
 * Normalize (via {@link normalizeServerUrl}: trim, default `http://`, keep origin
 * only), persist to AsyncStorage, and update module state. Throws if the
 * input normalizes to nothing (empty/whitespace) so a caller can't persist junk.
 */
export async function setVerityBaseUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (normalized === null) {
    throw new Error('Server URL must not be empty.');
  }
  currentBaseUrl = normalized;
  configuredBaseUrl = true;
  await AsyncStorage.setItem(STORAGE_KEY, normalized);
}

/** Build the API client for the current base URL, or `null` when none is set.
 *  Wired to the per-device bearer token (audit C1): `getToken` attaches it to
 *  every request, and a 401 from a gated route drops the stored token so the app
 *  falls back to master-password re-auth. */
export function createVerityClient(): VerityClient | null {
  if (!currentBaseUrl) return null;
  const endpoint = getServerProfile()?.endpoints.find(({ url }) => url === currentBaseUrl);
  const pinnedFetch =
    endpoint?.transport === 'direct' ? createPinnedFetch(endpoint.tlsPin!) : undefined;
  return new VerityClient({
    baseUrl: currentBaseUrl,
    // expo-file-system File implements Blob through Expo's native networking
    // stack. Keep ordinary API calls on the global fetch and route only uploads
    // through expo/fetch so large picked files stream without a JS copy.
    ...(pinnedFetch
      ? { fetch: pinnedFetch, uploadFetch: pinnedFetch, allowBackgroundUpload: false }
      : { uploadFetch: expoFetch as typeof fetch }),
    getToken: () => getAuthToken(currentBaseUrl),
    onUnauthorized: () => {
      void clearAuthToken(currentBaseUrl);
    },
  });
}
