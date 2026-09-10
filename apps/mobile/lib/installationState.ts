import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearLegacyAuthState, clearStoredAuthState } from './authToken';
import { clearPairingSession } from './pairingSession';
import { clearServerProfile, hydrateServerProfile } from './serverProfile';

const INSTALLATION_MARKER_KEY = 'verity.installation.v1';
// Existing releases persist this alongside the SecureStore profile. Its presence
// distinguishes their first launch after upgrading from a true reinstall.
const SERVER_URL_KEY = 'verity.serverUrl';

/** Establish an app-container boundary before reading credentials from SecureStore.
 * iOS retains Keychain entries across uninstall/reinstall, while AsyncStorage is
 * removed. Existing installations migrate by carrying their persisted URL forward. */
export async function prepareInstallationState(): Promise<void> {
  if ((await AsyncStorage.getItem(INSTALLATION_MARKER_KEY)) !== null) return;

  const existingServerUrl = await AsyncStorage.getItem(SERVER_URL_KEY);
  if (existingServerUrl === null || existingServerUrl === '') {
    const profile = await hydrateServerProfile().catch(() => null);
    await clearLegacyAuthState();
    for (const endpoint of profile?.endpoints ?? []) {
      await clearStoredAuthState(endpoint.url);
    }
    await clearServerProfile();
    await clearPairingSession();
  }
  await AsyncStorage.setItem(INSTALLATION_MARKER_KEY, '1');
}
