import {
  clearAuthToken,
  copyAuthTokenToEndpoint,
  disableBiometricUnlock,
  enableBiometricUnlock,
  getAuthToken,
  hasStoredAuthToken,
  isBiometricUnlockEnabled,
  refreshBiometricUnlockSecret,
  setAuthToken,
  unlockAuthTokenWithBiometrics,
  unlockServerSecretWithBiometrics,
} from '../lib/authToken';

const secureStore = new Map<string, string>();
const mockSetItemAsync = jest.fn(async (key: string, value: string) => {
  secureStore.set(key, value);
});
const mockGetItemAsync = jest.fn(async (key: string) => secureStore.get(key) ?? null);
const mockDeleteItemAsync = jest.fn(async (key: string) => {
  secureStore.delete(key);
});
const mockHasHardwareAsync = jest.fn(async () => false);
const mockIsEnrolledAsync = jest.fn(async () => false);
const mockAuthenticateAsync = jest.fn(async () => ({ success: true }));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  setItemAsync: (...args: Parameters<typeof mockSetItemAsync>) => mockSetItemAsync(...args),
  getItemAsync: (...args: Parameters<typeof mockGetItemAsync>) => mockGetItemAsync(...args),
  deleteItemAsync: (...args: Parameters<typeof mockDeleteItemAsync>) =>
    mockDeleteItemAsync(...args),
}));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: () => mockHasHardwareAsync(),
  isEnrolledAsync: () => mockIsEnrolledAsync(),
  authenticateAsync: () => mockAuthenticateAsync(),
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    [...value].map((character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
}));

const DOGFOOD = 'http://dev-server:8082';
const ONBOARDING = 'http://dev-server:8090';

beforeEach(() => {
  secureStore.clear();
  mockSetItemAsync.mockClear();
  mockGetItemAsync.mockClear();
  mockDeleteItemAsync.mockClear();
  mockHasHardwareAsync.mockClear();
  mockIsEnrolledAsync.mockClear();
  mockAuthenticateAsync.mockClear();
});

describe('authToken', () => {
  it('reports durable storage success when only legacy cleanup fails', async () => {
    mockDeleteItemAsync.mockRejectedValueOnce(new Error('keychain cleanup failed'));

    await expect(setAuthToken(DOGFOOD, 'dogfood-token', 'device-id')).resolves.toBe(true);
    expect(await hasStoredAuthToken(DOGFOOD)).toBe(true);
  });

  it('scopes stored and in-memory tokens by Verity server URL', async () => {
    await setAuthToken(DOGFOOD, 'dogfood-token');

    expect(getAuthToken(DOGFOOD)).toBe('dogfood-token');
    expect(getAuthToken(ONBOARDING)).toBeNull();
    expect(await hasStoredAuthToken(DOGFOOD)).toBe(true);
    expect(await hasStoredAuthToken(ONBOARDING)).toBe(false);

    await setAuthToken(ONBOARDING, 'onboarding-token');

    expect(getAuthToken(ONBOARDING)).toBe('onboarding-token');
    expect(getAuthToken(DOGFOOD)).toBeNull();
    expect(await hasStoredAuthToken(DOGFOOD)).toBe(true);
    expect(await hasStoredAuthToken(ONBOARDING)).toBe(true);
  });

  it('copies an unlocked device credential after a verified endpoint change', async () => {
    await setAuthToken(DOGFOOD, 'dogfood-token', 'device-id');
    await copyAuthTokenToEndpoint(DOGFOOD, ONBOARDING);

    expect(getAuthToken(ONBOARDING)).toBe('dogfood-token');
    expect(await hasStoredAuthToken(DOGFOOD)).toBe(true);
    expect(await hasStoredAuthToken(ONBOARDING)).toBe(true);
    await clearAuthToken(null);
    expect(await hasStoredAuthToken(ONBOARDING)).toBe(true);
  });

  it('does not load a stored token until biometric unlock is explicitly enabled', async () => {
    await setAuthToken(DOGFOOD, 'dogfood-token');

    expect(await unlockAuthTokenWithBiometrics(DOGFOOD)).toBe(false);
    expect(getAuthToken(DOGFOOD)).toBe('dogfood-token');
  });

  it('stores the biometric preference for the selected server URL', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);

    expect(await isBiometricUnlockEnabled(DOGFOOD)).toBe(false);
    expect(await enableBiometricUnlock(DOGFOOD, 'master-password')).toBe(true);

    expect(await isBiometricUnlockEnabled(DOGFOOD)).toBe(true);
    expect(await isBiometricUnlockEnabled(ONBOARDING)).toBe(false);
    expect(mockSetItemAsync).toHaveBeenCalledWith(
      expect.stringContaining('verity.authToken.v2.'),
      expect.stringContaining('master-password'),
      expect.objectContaining({ requireAuthentication: true }),
    );
  });

  it('refreshes the Face ID-protected master password for existing opt-ins', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await enableBiometricUnlock(DOGFOOD);

    expect(await refreshBiometricUnlockSecret(DOGFOOD, 'master-password')).toBe(true);
    const unlockSecret = jest.fn(async (password: string) => ({
      token: password === 'master-password' ? 'fresh-token' : undefined,
    }));

    expect(await unlockServerSecretWithBiometrics(DOGFOOD, unlockSecret)).toBe(true);
    expect(unlockSecret).toHaveBeenCalledWith('master-password');
  });

  it('unlocks the server secret store with the Face ID-protected master password', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await enableBiometricUnlock(DOGFOOD, 'master-password');
    const unlockSecret = jest.fn(async (password: string) => ({
      token: password === 'master-password' ? 'fresh-token' : undefined,
    }));

    expect(await unlockServerSecretWithBiometrics(DOGFOOD, unlockSecret)).toBe(true);

    expect(unlockSecret).toHaveBeenCalledWith('master-password');
    expect(getAuthToken(DOGFOOD)).toBe('fresh-token');
  });

  it('loads only the token for the selected server URL after biometric opt-in', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await setAuthToken(DOGFOOD, 'dogfood-token');
    await setAuthToken(ONBOARDING, 'onboarding-token');
    await clearAuthToken(ONBOARDING);
    expect(await enableBiometricUnlock(DOGFOOD)).toBe(true);

    expect(getAuthToken(DOGFOOD)).toBeNull();
    expect(await unlockAuthTokenWithBiometrics(DOGFOOD)).toBe(true);
    expect(getAuthToken(DOGFOOD)).toBe('dogfood-token');
    expect(getAuthToken(ONBOARDING)).toBeNull();
  });

  it('rejects a protected token whose embedded server origin does not match', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await setAuthToken(DOGFOOD, 'dogfood-token');
    await enableBiometricUnlock(DOGFOOD);
    await clearAuthToken(null);
    const storedToken = [...secureStore.entries()].find(([key]) =>
      /^verity\.authToken\.v2\.[^.]+$/.test(key),
    );
    expect(storedToken).toBeDefined();
    secureStore.set(
      storedToken![0],
      JSON.stringify({ origin: 'https://attacker.example', secret: 'dogfood-token' }),
    );

    expect(await unlockAuthTokenWithBiometrics(DOGFOOD)).toBe(false);
    expect(getAuthToken(DOGFOOD)).toBeNull();
  });

  it('clears only the active server token plus the legacy global key', async () => {
    await setAuthToken(DOGFOOD, 'dogfood-token');
    await setAuthToken(ONBOARDING, 'onboarding-token');

    await clearAuthToken(ONBOARDING);

    expect(await hasStoredAuthToken(ONBOARDING)).toBe(false);
    expect(await hasStoredAuthToken(DOGFOOD)).toBe(true);
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('verity.authToken');
  });

  it('keeps biometric enrollment when a rejected bearer is cleared', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await setAuthToken(DOGFOOD, 'expired-token');
    expect(await enableBiometricUnlock(DOGFOOD, 'master-password')).toBe(true);

    await clearAuthToken(DOGFOOD);

    expect(await isBiometricUnlockEnabled(DOGFOOD)).toBe(true);
  });

  it('does not load the token after biometric unlock is disabled', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockIsEnrolledAsync.mockResolvedValue(true);
    await setAuthToken(DOGFOOD, 'dogfood-token');
    expect(await enableBiometricUnlock(DOGFOOD)).toBe(true);
    await disableBiometricUnlock(DOGFOOD);

    await clearAuthToken(null);

    expect(await unlockAuthTokenWithBiometrics(DOGFOOD)).toBe(false);
    expect(getAuthToken(DOGFOOD)).toBeNull();
  });
});
