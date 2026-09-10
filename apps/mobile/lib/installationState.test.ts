import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearLegacyAuthState, clearStoredAuthState } from './authToken';
import { clearPairingSession } from './pairingSession';
import { clearServerProfile, hydrateServerProfile } from './serverProfile';
import { prepareInstallationState } from './installationState';

jest.mock('./authToken', () => ({
  clearLegacyAuthState: jest.fn(),
  clearStoredAuthState: jest.fn(),
}));
jest.mock('./pairingSession', () => ({ clearPairingSession: jest.fn() }));
jest.mock('./serverProfile', () => ({
  clearServerProfile: jest.fn(),
  hydrateServerProfile: jest.fn(),
}));

describe('installation state', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    (clearLegacyAuthState as jest.Mock).mockResolvedValue(undefined);
    (clearStoredAuthState as jest.Mock).mockResolvedValue(undefined);
    (clearServerProfile as jest.Mock).mockResolvedValue(undefined);
    (clearPairingSession as jest.Mock).mockResolvedValue(undefined);
    (hydrateServerProfile as jest.Mock).mockResolvedValue({
      endpoints: [{ url: 'https://direct.example' }, { url: 'https://relay.example' }],
    });
    await AsyncStorage.clear();
  });

  it('forgets Keychain pairing state after an uninstall removed the app container', async () => {
    await prepareInstallationState();

    expect(clearServerProfile).toHaveBeenCalledTimes(1);
    expect(clearPairingSession).toHaveBeenCalledTimes(1);
    expect(clearStoredAuthState).toHaveBeenCalledTimes(2);
    expect(clearLegacyAuthState).toHaveBeenCalledTimes(1);
    expect(clearStoredAuthState).toHaveBeenNthCalledWith(1, 'https://direct.example');
    expect(clearStoredAuthState).toHaveBeenNthCalledWith(2, 'https://relay.example');
    expect(await AsyncStorage.getItem('verity.installation.v1')).toBe('1');
  });

  it('preserves an existing installation while introducing the marker', async () => {
    await AsyncStorage.setItem('verity.serverUrl', 'https://verity.example');

    await prepareInstallationState();

    expect(clearServerProfile).not.toHaveBeenCalled();
    expect(clearPairingSession).not.toHaveBeenCalled();
    expect(clearStoredAuthState).not.toHaveBeenCalled();
    expect(clearLegacyAuthState).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem('verity.installation.v1')).toBe('1');
  });

  it('does not clear pairing state again after the installation was marked', async () => {
    await AsyncStorage.setItem('verity.installation.v1', '1');

    await prepareInstallationState();

    expect(clearServerProfile).not.toHaveBeenCalled();
    expect(clearPairingSession).not.toHaveBeenCalled();
    expect(clearStoredAuthState).not.toHaveBeenCalled();
    expect(clearLegacyAuthState).not.toHaveBeenCalled();
  });

  it('retries cleanup on the next launch when a Keychain deletion fails', async () => {
    (clearStoredAuthState as jest.Mock).mockRejectedValueOnce(new Error('Keychain unavailable'));

    await expect(prepareInstallationState()).rejects.toThrow('Keychain unavailable');

    expect(await AsyncStorage.getItem('verity.installation.v1')).toBeNull();
  });

  it('deletes corrupt retained profile state instead of blocking every launch', async () => {
    (hydrateServerProfile as jest.Mock).mockRejectedValueOnce(new Error('Invalid profile'));

    await prepareInstallationState();

    expect(clearLegacyAuthState).toHaveBeenCalledTimes(1);
    expect(clearServerProfile).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem('verity.installation.v1')).toBe('1');
  });
});
