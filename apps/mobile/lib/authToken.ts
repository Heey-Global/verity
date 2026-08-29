import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

// Per-device API bearer token for the control-plane auth gate (audit C1). The
// token is minted server-side when the operator proves the master password
// (POST /secret/init | /secret/unlock) and is the credential every gated request
// then carries. Tokens are scoped by Verity server URL so dogfood, onboarding,
// and future parallel instances cannot overwrite or reuse each other's bearer.
// Two layers protect each token on the device:
//   1. It lives in the OS keychain via expo-secure-store (never AsyncStorage,
//      which is plain-text) — see lib/client.ts for the base URL, which is NOT a
//      secret and stays in AsyncStorage.
//   2. Loading it into memory after a fresh launch requires a biometric/passcode
//      check (Face ID / Touch ID), so a stolen-but-locked device can't use it.

const LEGACY_TOKEN_KEY = 'verity.authToken';
const BIOMETRIC_ENABLED_VALUE = '1';
const BIOMETRIC_DISABLED_VALUE = '0';

function tokenKey(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < baseUrl.length; i += 1) {
    hash ^= baseUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `verity.authToken.${hash.toString(16).padStart(8, '0')}`;
}

function biometricPreferenceKey(baseUrl: string | null): string | null {
  const key = tokenKey(baseUrl);
  return key === null ? null : `${key}.biometric`;
}

// The auth-token id (the `tokenId` the server returns from /secret/init|unlock) is
// this device's OWN identifier — the `:id` the push-token endpoint matches against
// the bearer. It is NOT secret (it authorizes nothing on its own), but it is stored
// next to the bearer so both are cleared together on forget.
function tokenIdKey(baseUrl: string | null): string | null {
  const key = tokenKey(baseUrl);
  return key === null ? null : `${key}.id`;
}

function masterPasswordKey(baseUrl: string | null): string | null {
  const key = tokenKey(baseUrl);
  return key === null ? null : `${key}.masterPassword`;
}

// The token for the current server URL, or null when not yet loaded/unlocked. The
// VerityClient's getToken reads this synchronously on every request.
let currentToken: string | null = null;
let currentTokenId: string | null = null;
let currentTokenBaseUrl: string | null = null;

/** The in-memory bearer token for this server URL, or null when none is loaded. */
export function getAuthToken(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl !== currentTokenBaseUrl) return null;
  return currentToken;
}

/** This device's auth-token id for the current server URL (the push-token
 *  endpoint's `:id`), or null when unknown. Loaded alongside the bearer. */
export function getAuthTokenId(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl !== currentTokenBaseUrl) return null;
  return currentTokenId;
}

/** Read this device's persisted auth-token id from the keychain, independent of
 *  whether the bearer has been loaded into memory this session — the push
 *  registration needs it even on a biometric-unlock launch. */
export async function getStoredAuthTokenId(baseUrl: string | null): Promise<string | null> {
  const key = tokenIdKey(baseUrl);
  if (key === null) return null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

/**
 * Persist a freshly minted token (right after a successful master-password
 * unlock) for the active server URL and load it into memory. No biometric prompt
 * here — the operator just proved the master password, which is a stronger
 * check. Best-effort on the keychain write: an in-memory token still powers the
 * current session even if persistence fails (the next launch just asks for the
 * password again).
 */
export async function setAuthToken(
  baseUrl: string | null,
  token: string,
  tokenId?: string,
): Promise<void> {
  const key = tokenKey(baseUrl);
  if (key === null) return;
  currentTokenBaseUrl = baseUrl;
  currentToken = token;
  // Reset (not preserve) when absent, so a base-URL switch can't leave the prior
  // URL's id readable under the new URL's now-passing base-URL guard.
  currentTokenId = tokenId ?? null;
  try {
    await SecureStore.setItemAsync(key, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    const idKey = tokenIdKey(baseUrl);
    if (idKey !== null && tokenId !== undefined) {
      await SecureStore.setItemAsync(idKey, tokenId, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    }
    await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
  } catch {
    // Keep the in-memory token; persistence is a convenience, not a requirement.
  }
}

/** Whether this device can present a biometric/passcode prompt for Verity. */
export async function canUseBiometricUnlock(): Promise<boolean> {
  try {
    return (
      (await LocalAuthentication.hasHardwareAsync()) &&
      (await LocalAuthentication.isEnrolledAsync())
    );
  } catch {
    return false;
  }
}

/** Prompt once before enabling biometric unlock for this Verity server. */
export async function enableBiometricUnlock(
  baseUrl: string | null,
  masterPassword?: string,
): Promise<boolean> {
  const key = biometricPreferenceKey(baseUrl);
  if (key === null) return false;
  try {
    if (!(await canUseBiometricUnlock())) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Enable Face ID for Verity',
    });
    if (!result.success) return false;
    await SecureStore.setItemAsync(key, BIOMETRIC_ENABLED_VALUE, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    const passwordKey = masterPasswordKey(baseUrl);
    if (passwordKey !== null && masterPassword !== undefined) {
      await SecureStore.setItemAsync(passwordKey, masterPassword, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Explicitly disable biometric auto-unlock for this server on this device. */
export async function disableBiometricUnlock(baseUrl: string | null): Promise<void> {
  const key = biometricPreferenceKey(baseUrl);
  if (key === null) return;
  try {
    await SecureStore.setItemAsync(key, BIOMETRIC_DISABLED_VALUE, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    const passwordKey = masterPasswordKey(baseUrl);
    if (passwordKey !== null) await SecureStore.deleteItemAsync(passwordKey);
  } catch {
    // Best effort; the absence of an enabled preference already means disabled.
  }
}

/** Whether a token is persisted on this device for the current server URL
 *  (independent of whether it's been loaded into memory this session) — lets the
 *  launch flow choose between a biometric unlock and master-password entry. */
export async function hasStoredAuthToken(baseUrl: string | null): Promise<boolean> {
  const key = tokenKey(baseUrl);
  if (key === null) return false;
  try {
    return (await SecureStore.getItemAsync(key)) !== null;
  } catch {
    return false;
  }
}

/** Whether biometric unlock has already been explicitly enabled for this server. */
export async function isBiometricUnlockEnabled(baseUrl: string | null): Promise<boolean> {
  const key = biometricPreferenceKey(baseUrl);
  if (key === null) return false;
  try {
    return (await SecureStore.getItemAsync(key)) === BIOMETRIC_ENABLED_VALUE;
  } catch {
    return false;
  }
}

/**
 * Existing devices may have enabled Face ID before Verity stored the server
 * master password. After the operator manually unlocks once, refresh that
 * Face-ID-protected secret so the next sealed-server launch can unlock directly.
 */
export async function refreshBiometricUnlockSecret(
  baseUrl: string | null,
  masterPassword: string,
): Promise<boolean> {
  if (!(await isBiometricUnlockEnabled(baseUrl))) return false;
  const key = masterPasswordKey(baseUrl);
  if (key === null) return false;
  try {
    await SecureStore.setItemAsync(key, masterPassword, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the stored token for this server URL into memory behind a
 * biometric/passcode check. Call at startup when {@link hasStoredAuthToken} is
 * true. Returns true when the token is now available (getAuthToken(baseUrl) will
 * return it). When the device has no biometric hardware/enrollment we skip the
 * prompt and trust the device-passcode protection already on the keychain item.
 */
export async function unlockAuthTokenWithBiometrics(baseUrl: string | null): Promise<boolean> {
  const key = tokenKey(baseUrl);
  const preferenceKey = biometricPreferenceKey(baseUrl);
  if (key === null || preferenceKey === null) return false;
  try {
    const stored = await SecureStore.getItemAsync(key);
    if (stored === null) return false;
    if (!(await isBiometricUnlockEnabled(baseUrl))) return false;
    await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
    if (!(await canUseBiometricUnlock())) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Verity',
    });
    if (!result.success) return false;
    currentTokenBaseUrl = baseUrl;
    currentToken = stored;
    currentTokenId = await getStoredAuthTokenId(baseUrl);
    return true;
  } catch {
    return false;
  }
}

/** Unlock the server secret store with the Face ID-protected master password. */
export async function unlockServerSecretWithBiometrics(
  baseUrl: string | null,
  unlockSecret: (
    password: string,
  ) => Promise<{ token?: string | undefined; tokenId?: string | undefined }>,
): Promise<boolean> {
  const passwordKey = masterPasswordKey(baseUrl);
  if (passwordKey === null) return false;
  try {
    if (!(await isBiometricUnlockEnabled(baseUrl))) return false;
    if (!(await canUseBiometricUnlock())) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Verity',
    });
    if (!result.success) return false;
    const password = await SecureStore.getItemAsync(passwordKey);
    if (password === null) return false;
    const unlocked = await unlockSecret(password);
    if (unlocked.token) await setAuthToken(baseUrl, unlocked.token, unlocked.tokenId);
    return true;
  } catch {
    return false;
  }
}

/** Forget the token for this server URL (on a 401 re-auth signal, or an explicit
 *  disconnect) — forcing the operator to re-enter the master password. */
export async function clearAuthToken(baseUrl: string | null): Promise<void> {
  const key = tokenKey(baseUrl);
  const idKey = tokenIdKey(baseUrl);
  if (baseUrl === null || baseUrl === currentTokenBaseUrl) {
    currentTokenBaseUrl = null;
    currentToken = null;
    currentTokenId = null;
  }
  try {
    if (key !== null) await SecureStore.deleteItemAsync(key);
    if (idKey !== null) await SecureStore.deleteItemAsync(idKey);
    await SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY);
    await disableBiometricUnlock(baseUrl);
  } catch {
    // Best effort — the in-memory token is already cleared.
  }
}
