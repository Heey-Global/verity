// Behaviour tests for required onboarding, device authorization, and legacy callback routes.
import { VerityApiError } from '@verity/mobile';
import type { VerityClient, OnboardingStatus, SecretUnlocked } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

const mockReplace = jest.fn<void, [string]>();
const mockPush = jest.fn<void, [string]>();
const mockBack = jest.fn<void, []>();
const mockCanGoBack = jest.fn<boolean, []>(() => false);
let mockLocalSearchParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
  router: {
    replace: (href: string) => mockReplace(href),
    push: (href: string) => mockPush(href),
    back: () => mockBack(),
    canGoBack: () => mockCanGoBack(),
  },
  useLocalSearchParams: () => mockLocalSearchParams,
  useSegments: () => [] as string[],
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockGetVerityBaseUrl = jest.fn<string | null, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => mockGetVerityBaseUrl(),
}));

const mockGetAuthToken = jest.fn<string | null, [string | null]>();
const mockSetAuthToken = jest.fn<Promise<void>, [string | null, string]>().mockResolvedValue();
const mockCanUseBiometricUnlock = jest.fn<Promise<boolean>, []>().mockResolvedValue(false);
const mockEnableBiometricUnlock = jest
  .fn<Promise<boolean>, [string | null, string | undefined]>()
  .mockResolvedValue(true);
const mockDisableBiometricUnlock = jest.fn<Promise<void>, [string | null]>().mockResolvedValue();
const mockIsBiometricUnlockEnabled = jest
  .fn<Promise<boolean>, [string | null]>()
  .mockResolvedValue(false);
const mockRefreshBiometricUnlockSecret = jest
  .fn<Promise<boolean>, [string | null, string]>()
  .mockResolvedValue(true);
const mockUnlockAuthTokenWithBiometrics = jest
  .fn<Promise<boolean>, [string | null]>()
  .mockResolvedValue(false);
const mockUnlockServerSecretWithBiometrics = jest
  .fn<Promise<boolean>, [string | null, (password: string) => Promise<SecretUnlocked>]>()
  .mockResolvedValue(false);
jest.mock('../lib/authToken', () => ({
  canUseBiometricUnlock: () => mockCanUseBiometricUnlock(),
  disableBiometricUnlock: (baseUrl: string | null) => mockDisableBiometricUnlock(baseUrl),
  enableBiometricUnlock: (baseUrl: string | null, masterPassword?: string) =>
    mockEnableBiometricUnlock(baseUrl, masterPassword),
  getAuthToken: (baseUrl: string | null) => mockGetAuthToken(baseUrl),
  isBiometricUnlockEnabled: (baseUrl: string | null) => mockIsBiometricUnlockEnabled(baseUrl),
  refreshBiometricUnlockSecret: (baseUrl: string | null, masterPassword: string) =>
    mockRefreshBiometricUnlockSecret(baseUrl, masterPassword),
  setAuthToken: (baseUrl: string | null, token: string) => mockSetAuthToken(baseUrl, token),
  unlockAuthTokenWithBiometrics: (baseUrl: string | null) =>
    mockUnlockAuthTokenWithBiometrics(baseUrl),
  unlockServerSecretWithBiometrics: (
    baseUrl: string | null,
    unlockSecret: (password: string) => Promise<SecretUnlocked>,
  ) => mockUnlockServerSecretWithBiometrics(baseUrl, unlockSecret),
}));

// Spy on the real `Linking.openURL` so the guidance link's effect is observable
// without opening a URL (jsdom/jest has no native Linking backend).
const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
const mockOpenAuthSessionAsync = jest.fn();
const mockDismissAuthSession = jest.fn<void, []>();
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: unknown[]) => mockOpenAuthSessionAsync(...args),
  dismissAuthSession: () => mockDismissAuthSession(),
}));

// `expo-clipboard` has no jsdom backend — mock it so the copy button's effect is
// observable without a native module.
const mockSetStringAsync = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
const mockGetStringAsync = jest.fn<Promise<string>, []>().mockResolvedValue('');
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockSetStringAsync(value),
  getStringAsync: () => mockGetStringAsync(),
}));

import OnboardingMasterPassword from '../app/onboarding/master-password';
import UnlockDevice from '../app/unlock-device';
import GithubManifestCallback from '../app/github/app/callback';
import OnboardingAiBackends from '../app/onboarding/ai-backends';

function fakeClient(overrides: Partial<VerityClient>): VerityClient {
  return {
    getVeritySettings: jest.fn().mockResolvedValue({}),
    updateVeritySettings: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as VerityClient;
}

function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    sealed: false,
    masterPasswordSet: true,
    githubAppConfigured: false,
    signingKeyConfigured: false,
    hasProject: false,
    dopplerConfigured: false,
    claudeConfigured: false,
    codexConfigured: false,
    complete: false,
    nextStep: 'github',
    ...overrides,
  };
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  mockBack.mockReset();
  mockCanGoBack.mockReset();
  mockCanGoBack.mockReturnValue(false);
  mockCreateVerityClient.mockReset();
  mockGetVerityBaseUrl.mockReset();
  mockLocalSearchParams = {};
  // Default: a server address is configured (server-url precedes this step). Tests
  // that exercise the null-guard override this explicitly.
  mockGetVerityBaseUrl.mockReturnValue('http://verity.example:8082');
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockReturnValue('device-token');
  mockSetAuthToken.mockClear();
  mockCanUseBiometricUnlock.mockReset();
  mockCanUseBiometricUnlock.mockResolvedValue(false);
  mockEnableBiometricUnlock.mockClear();
  mockDisableBiometricUnlock.mockClear();
  mockIsBiometricUnlockEnabled.mockReset();
  mockIsBiometricUnlockEnabled.mockResolvedValue(false);
  mockRefreshBiometricUnlockSecret.mockReset();
  mockRefreshBiometricUnlockSecret.mockResolvedValue(true);
  mockUnlockAuthTokenWithBiometrics.mockReset();
  mockUnlockAuthTokenWithBiometrics.mockResolvedValue(false);
  mockUnlockServerSecretWithBiometrics.mockReset();
  mockUnlockServerSecretWithBiometrics.mockResolvedValue(false);
  openURL.mockClear();
  mockOpenAuthSessionAsync.mockReset();
  mockDismissAuthSession.mockClear();
  mockSetStringAsync.mockClear();
});

describe('device authorization unlock route', () => {
  it('uses token biometric unlock for onboarding return routes when only device authorization is needed', async () => {
    mockLocalSearchParams = { returnTo: '/onboarding/github' };
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    await waitFor(() =>
      expect(mockUnlockAuthTokenWithBiometrics).toHaveBeenCalledWith('http://verity.example:8082'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/github');
  });

  it('uses biometric server-secret unlock when server secret unlock is required', async () => {
    mockLocalSearchParams = { returnTo: '/', serverSecret: '1' };
    const unlockSecret = jest.fn<Promise<SecretUnlocked>, [string]>().mockResolvedValue({
      status: 'unlocked',
      token: 'fresh-token',
    });
    mockCreateVerityClient.mockReturnValue(fakeClient({ unlockSecret }));
    mockUnlockServerSecretWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    await waitFor(() =>
      expect(mockUnlockServerSecretWithBiometrics).toHaveBeenCalledWith(
        'http://verity.example:8082',
        expect.any(Function),
      ),
    );
    expect(mockUnlockAuthTokenWithBiometrics).not.toHaveBeenCalled();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(screen.queryByLabelText('Master password')).toBeNull();
  });

  it('still loads the device bearer when the sealed store has no Face ID master password', async () => {
    mockLocalSearchParams = { returnTo: '/', serverSecret: '1' };
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));
    // A QR-paired device holds an enrolled bearer but never a Face ID-protected
    // master password, so the secret unlock above cannot run.
    mockUnlockServerSecretWithBiometrics.mockResolvedValue(false);
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    // Without this, the password form below submits an unproven device and
    // /secret/unlock rejects it before ever comparing the password — the operator
    // sees a correct master password refused, with no way to get past it.
    await waitFor(() =>
      expect(mockUnlockAuthTokenWithBiometrics).toHaveBeenCalledWith('http://verity.example:8082'),
    );
    expect(await screen.findByLabelText('Master password')).toBeOnTheScreen();
  });

  it('does not use token-only biometric unlock when server secret unlock is required', async () => {
    mockLocalSearchParams = { returnTo: '/', serverSecret: '1' };
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    expect(mockUnlockAuthTokenWithBiometrics).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Master password')).toBeOnTheScreen();
    expect(screen.getByText('Device authorization')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Step 1 of 4')).toBeNull();
  });
  it('tries biometric token unlock first for normal app re-entry and returns home when it succeeds', async () => {
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    await waitFor(() =>
      expect(mockUnlockAuthTokenWithBiometrics).toHaveBeenCalledWith('http://verity.example:8082'),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(screen.queryByLabelText('Master password')).toBeNull();
  });

  it('falls back to home after biometric unlock when no return route is supplied', async () => {
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('falls back to the password form when biometric unlock is not available', async () => {
    const getSecretStatus = jest.fn<Promise<'unlocked'>, []>().mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));
    mockGetAuthToken.mockReturnValue(null);
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(false);

    render(<UnlockDevice />);

    await waitFor(() =>
      expect(mockUnlockAuthTokenWithBiometrics).toHaveBeenCalledWith('http://verity.example:8082'),
    );
    expect(await screen.findByText('Unlock Verity')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Master password')).toBeOnTheScreen();
  });
});

describe('onboarding master-password step', () => {
  it('set-new mode: valid password + confirm calls initSecretPassword then reveals Next', async () => {
    const initSecretPassword = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked' });
    // First status read → uninitialized (set mode); after init → unlocked (ready).
    const getSecretStatus = jest
      .fn<Promise<'uninitialized' | 'unlocked'>, []>()
      .mockResolvedValueOnce('uninitialized')
      .mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, initSecretPassword }));

    render(<OnboardingMasterPassword />);

    // Set-new form: no Next yet (advance gated on unlock).
    await screen.findByLabelText('Master password');
    expect(screen.queryByLabelText('Next')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Master password'), 'super-secret-pw');
    fireEvent.changeText(screen.getByLabelText('Confirm password'), 'super-secret-pw');
    fireEvent.press(screen.getByLabelText('Set master password'));

    await waitFor(() =>
      expect(initSecretPassword).toHaveBeenCalledWith('super-secret-pw', 'iPhone', undefined),
    );
    // After a successful init the status refetch flips to `ready` and Next appears.
    await waitFor(() => expect(screen.getByLabelText('Next')).toBeOnTheScreen());
  });

  it('set-new mode: mismatched confirmation shows an error and does not call the API', async () => {
    const initSecretPassword = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked' });
    const getSecretStatus = jest
      .fn<Promise<'uninitialized'>, []>()
      .mockResolvedValue('uninitialized');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, initSecretPassword }));

    render(<OnboardingMasterPassword />);
    await screen.findByLabelText('Master password');

    fireEvent.changeText(screen.getByLabelText('Master password'), 'super-secret-pw');
    fireEvent.changeText(screen.getByLabelText('Confirm password'), 'different-pw');
    fireEvent.press(screen.getByLabelText('Set master password'));

    expect(await screen.findByText('Passwords do not match.')).toBeOnTheScreen();
    expect(initSecretPassword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Next')).toBeNull();
  });

  it('unlock mode: wrong password (401) shows an inline error and stays', async () => {
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockRejectedValue(new VerityApiError(401, 'incorrect master password'));
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);
    await screen.findByLabelText('Master password');
    // Unlock mode has no confirm field.
    expect(screen.queryByLabelText('Confirm password')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Master password'), 'wrong-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    expect(await screen.findByText('Incorrect password.')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Next')).toBeNull();
  });

  it('unlock mode: an unpaired device is told to re-pair, not that its password is wrong', async () => {
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockRejectedValue(new VerityApiError(401, 'valid device pairing is required'));
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);
    fireEvent.changeText(await screen.findByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    // The server refuses an unproven device BEFORE it compares the password. Both
    // rejections are 401, but only one is fixable by retyping — reporting this one
    // as a wrong password sends the operator into an unwinnable retry loop with a
    // password that is in fact correct.
    expect(await screen.findByText(/not authorized for this server/)).toBeOnTheScreen();
    expect(screen.queryByText('Incorrect password.')).toBeNull();
  });

  it('unlock mode: correct password with returnTo goes back to sessions', async () => {
    mockLocalSearchParams = { returnTo: '/' };
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked', token: 'device-token' });
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);
    await screen.findByLabelText('Master password');

    fireEvent.changeText(screen.getByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() =>
      expect(unlockSecret).toHaveBeenCalledWith('correct-pw', 'iPhone', undefined),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('reauth mode: unlocked server without a scoped token asks for the password outside the setup wizard', async () => {
    mockLocalSearchParams = { returnTo: '/' };
    mockGetAuthToken.mockReturnValue(null);
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked', token: 'dogfood-token' });
    const getSecretStatus = jest.fn<Promise<'unlocked'>, []>().mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);

    expect(await screen.findByText('Unlock Verity')).toBeOnTheScreen();
    expect(screen.getByText('Device authorization')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Step 1 of 4')).toBeNull();
    expect(screen.queryByText('Secrets are unlocked for this device.')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() =>
      expect(unlockSecret).toHaveBeenCalledWith('correct-pw', 'iPhone', undefined),
    );
    await waitFor(() =>
      expect(mockSetAuthToken).toHaveBeenCalledWith('http://verity.example:8082', 'dogfood-token'),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('reauth mode: asks for biometric opt-in after authorizing the device', async () => {
    mockLocalSearchParams = { returnTo: '/' };
    mockGetAuthToken.mockReturnValue(null);
    mockCanUseBiometricUnlock.mockResolvedValue(true);
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked', token: 'dogfood-token' });
    const getSecretStatus = jest.fn<Promise<'unlocked'>, []>().mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);

    fireEvent.changeText(await screen.findByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    expect(await screen.findByText('Use Face ID or Touch ID?')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Step 1 of 4')).toBeNull();

    fireEvent.press(screen.getByLabelText('Use Face ID'));

    await waitFor(() =>
      expect(mockEnableBiometricUnlock).toHaveBeenCalledWith(
        'http://verity.example:8082',
        'correct-pw',
      ),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('reauth mode: skips biometric opt-in when Face ID is already enabled', async () => {
    mockLocalSearchParams = { returnTo: '/' };
    mockGetAuthToken.mockReturnValue(null);
    mockCanUseBiometricUnlock.mockResolvedValue(true);
    mockIsBiometricUnlockEnabled.mockResolvedValue(true);
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked', token: 'dogfood-token' });
    const getSecretStatus = jest.fn<Promise<'unlocked'>, []>().mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);

    fireEvent.changeText(await screen.findByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockRefreshBiometricUnlockSecret).toHaveBeenCalledWith(
      'http://verity.example:8082',
      'correct-pw',
    );
    expect(screen.queryByText('Use Face ID or Touch ID?')).toBeNull();
    expect(mockEnableBiometricUnlock).not.toHaveBeenCalled();
  });

  it('unlock mode: correct password unlocks and reveals Next', async () => {
    const unlockSecret = jest
      .fn<Promise<SecretUnlocked>, [string]>()
      .mockResolvedValue({ status: 'unlocked' });
    const getSecretStatus = jest
      .fn<Promise<'sealed' | 'unlocked'>, []>()
      .mockResolvedValueOnce('sealed')
      .mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus, unlockSecret }));

    render(<OnboardingMasterPassword />);
    fireEvent.changeText(await screen.findByLabelText('Master password'), 'right-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() => expect(unlockSecret).toHaveBeenCalledWith('right-pw', 'iPhone', undefined));
    await waitFor(() => expect(screen.getByLabelText('Next')).toBeOnTheScreen());
  });

  it('already-unlocked: shows the done note with Next immediately', async () => {
    const getSecretStatus = jest.fn<Promise<'unlocked'>, []>().mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));

    render(<OnboardingMasterPassword />);
    expect(await screen.findByLabelText('Next')).toBeOnTheScreen();
  });

  it('status fetch failure shows a retry (no indefinite spinner) and recovers on retry', async () => {
    const getSecretStatus = jest
      .fn<Promise<'unlocked'>, []>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));

    render(<OnboardingMasterPassword />);
    // Failed pre-fetch → a Retry affordance, not a dead-end spinner.
    const retry = await screen.findByLabelText('Retry');
    expect(retry).toBeOnTheScreen();
    // Retry → status resolves → the step advances (Next appears).
    fireEvent.press(retry);
    expect(await screen.findByLabelText('Next')).toBeOnTheScreen();
  });
});

describe('native GitHub manifest callback', () => {
  it('forwards the creation code to the paired server and opens installation', async () => {
    mockLocalSearchParams = { phase: 'created', code: 'code-1', state: 'state-1' };
    const completeGithubManifest = jest
      .fn()
      .mockResolvedValue('https://github.com/apps/verity/installations/new?state=state-2');
    mockCreateVerityClient.mockReturnValue(fakeClient({ completeGithubManifest }));

    render(<GithubManifestCallback />);

    await waitFor(() => expect(completeGithubManifest).toHaveBeenCalledWith('code-1', 'state-1'));
    expect(openURL).toHaveBeenCalledWith(
      'https://github.com/apps/verity/installations/new?state=state-2',
    );
  });

  it('forwards the installation id and returns to the originating screen', async () => {
    mockLocalSearchParams = {
      phase: 'installed',
      state: 'state-2',
      installation_id: 'installation-1',
      returnTo: '/onboarding/github',
    };
    const completeGithubManifestInstallation = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(fakeClient({ completeGithubManifestInstallation }));

    render(<GithubManifestCallback />);

    await waitFor(() =>
      expect(completeGithubManifestInstallation).toHaveBeenCalledWith('installation-1', 'state-2'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/github');
  });

  it('handles installation when the callback parameters change on the mounted route', async () => {
    mockLocalSearchParams = { phase: 'created', code: 'code-1', state: 'state-1' };
    const completeGithubManifest = jest
      .fn()
      .mockResolvedValue('https://github.com/apps/verity/installations/new?state=state-2');
    const completeGithubManifestInstallation = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      fakeClient({ completeGithubManifest, completeGithubManifestInstallation }),
    );

    const view = render(<GithubManifestCallback />);
    await waitFor(() => expect(completeGithubManifest).toHaveBeenCalledWith('code-1', 'state-1'));

    mockLocalSearchParams = {
      phase: 'installed',
      state: 'state-2',
      installation_id: 'installation-1',
      returnTo: '/onboarding/github',
    };
    view.rerender(<GithubManifestCallback />);

    await waitFor(() =>
      expect(completeGithubManifestInstallation).toHaveBeenCalledWith('installation-1', 'state-2'),
    );
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/github');
  });
});

describe('onboarding agent logins step', () => {
  it('redirects to device unlock when the server secret store is sealed on resume', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status({ sealed: true, masterPasswordSet: true }));
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus }));

    render(<OnboardingAiBackends />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/unlock-device?returnTo=%2Fonboarding%2Fai-backends',
      ),
    );
    expect(screen.queryByLabelText('Connect Claude')).toBeNull();
  });

  it('uses the declared previous step even when unrelated history exists', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status());
    mockCanGoBack.mockReturnValue(true);
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus }));

    render(<OnboardingAiBackends />);

    fireEvent.press(await screen.findByLabelText('Back'));

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/master-password');
  });
  it('waits for Codex to return a device code before showing the login page', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status({ claudeConfigured: false, codexConfigured: false }));
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '33333333-3333-4333-8333-333333333333',
      provider: 'codex',
      status: 'starting',
      verificationUri: null,
      userCode: null,
      needsCode: false,
      configured: false,
      message: null,
    });
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus, startAgentLogin }));

    render(<OnboardingAiBackends />);

    fireEvent.press(await screen.findByLabelText('Connect Codex'));

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('codex'));
    expect(await screen.findByLabelText('Preparing...')).toBeOnTheScreen();
    expect(screen.queryByText('Waiting for Codex to issue a device code...')).toBeNull();
    expect(screen.queryByLabelText('Open Codex login page')).toBeNull();
  });

  it('starts a Codex device login and exposes the URL/code without manual auth.json paste', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status({ claudeConfigured: false, codexConfigured: false }));
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      status: 'ready',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'UXAB-12345',
      needsCode: false,
      configured: false,
      message: null,
    });
    const getAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      provider: 'codex',
      status: 'complete',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'UXAB-12345',
      needsCode: false,
      configured: true,
      message: null,
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({ fetchOnboardingStatus, startAgentLogin, getAgentLogin }),
    );

    render(<OnboardingAiBackends />);

    fireEvent.press(await screen.findByLabelText('Connect Codex'));

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('codex'));
    expect(await screen.findByText('UXAB-12345')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Codex login file')).toBeNull();

    expect(screen.getByLabelText('Open Codex login page')).toBeEnabled();
    mockSetStringAsync.mockRejectedValueOnce(new Error('clipboard unavailable'));
    fireEvent.press(screen.getByLabelText('Copy Codex code'));
    expect(
      await screen.findByText(
        'Could not copy the code. Select it manually, then continue to the login page.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Open Codex login page')).toBeEnabled();

    fireEvent.press(screen.getByLabelText('Copy Codex code'));
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('UXAB-12345'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 750)));
    expect(screen.getByLabelText('Open Codex login page')).toBeEnabled();

    fireEvent.press(screen.getByLabelText('Open Codex login page'));
    expect(openURL).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    expect(screen.getByLabelText('Open Codex login again')).toBeOnTheScreen();
    expect(screen.getByText('Finish there, then return to Verity')).toBeOnTheScreen();
    expect(screen.getByText('We will detect the completed login automatically.')).toBeOnTheScreen();
  });

  it('does not expose a Claude login link before the server marks the URL ready', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status());
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '33333333-3333-4333-8333-333333333333',
      provider: 'claude',
      status: 'starting',
      verificationUri: 'https://claude.com/cai/oauth/authorize?code=true',
      userCode: null,
      needsCode: true,
      configured: false,
      message: null,
    });
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus, startAgentLogin }));

    render(<OnboardingAiBackends />);

    fireEvent.press(await screen.findByLabelText('Connect Claude'));
    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('claude'));

    expect(await screen.findByLabelText('Preparing...')).toBeOnTheScreen();
    expect(screen.queryByText('Waiting for Claude to prepare a complete login page...')).toBeNull();
    expect(screen.queryByLabelText('Open Claude login page')).toBeNull();
  });

  it('submits the Claude returned code through the server-side login session', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status());
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      provider: 'claude',
      status: 'ready',
      verificationUri:
        'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge&state=state',
      userCode: null,
      needsCode: true,
      configured: false,
      message: null,
    });
    const submitAgentLoginCode = jest.fn().mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      provider: 'claude',
      status: 'complete',
      verificationUri:
        'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge&state=state',
      userCode: null,
      needsCode: true,
      configured: true,
      message: null,
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({ fetchOnboardingStatus, startAgentLogin, submitAgentLoginCode }),
    );

    render(<OnboardingAiBackends />);

    fireEvent.press(await screen.findByLabelText('Connect Claude'));
    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('claude'));
    await waitFor(() => expect(screen.queryByLabelText('Next')).toBeNull());
    fireEvent.press(await screen.findByLabelText('Open Claude login page'));
    expect(await screen.findByLabelText('Open Claude login again')).toBeOnTheScreen();
    mockGetStringAsync.mockResolvedValueOnce('  claude-code  ');
    fireEvent.press(screen.getByLabelText('Paste Claude code from clipboard'));
    await waitFor(() =>
      expect(screen.getByLabelText('Claude returned code')).toHaveProp('value', 'claude-code'),
    );
    fireEvent.press(screen.getByLabelText('Submit Claude code'));

    await waitFor(() =>
      expect(submitAgentLoginCode).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
        'claude-code',
      ),
    );
    expect(await screen.findByText('Claude connected.')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Open Claude login page')).toBeNull();
    expect(screen.queryByLabelText('Reconnect Claude')).toBeNull();
  });

  it('hides completed login controls once Codex is saved', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status({ codexConfigured: true }));
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus }));

    render(<OnboardingAiBackends />);

    expect(await screen.findByText('Codex connected.')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Reconnect Codex')).toBeNull();
    expect(screen.queryByLabelText('Open Codex login page')).toBeNull();
  });

  it('requires at least one agent login before continuing', async () => {
    const fetchOnboardingStatus = jest
      .fn<Promise<OnboardingStatus>, []>()
      .mockResolvedValue(status());
    mockCreateVerityClient.mockReturnValue(fakeClient({ fetchOnboardingStatus }));

    render(<OnboardingAiBackends />);

    await screen.findByLabelText('Open Verity');
    expect(screen.queryByLabelText('Skip — set up later')).toBeNull();
    expect(screen.getByLabelText('Open Verity')).toHaveProp('accessibilityState', {
      disabled: true,
    });
  });

  it('accepts a configured OpenCode provider as the first agent connection', async () => {
    const updateVeritySettings = jest.fn().mockResolvedValue({
      opencodeBaseUrl: 'https://api.example.com/v1',
      opencodeApiKeyConfigured: true,
      opencodeModels: 'provider/model-a\nprovider/model-b',
    });
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        getVeritySettings: jest.fn().mockResolvedValue({
          opencodeApiKeyConfigured: false,
          opencodeBaseUrl: null,
          opencodeModels: null,
        }),
        updateVeritySettings,
      }),
    );

    render(<OnboardingAiBackends />);
    fireEvent.press(await screen.findByLabelText('Configure OpenCode'));
    expect(screen.queryByLabelText('Open Verity')).toBeNull();

    fireEvent.changeText(
      screen.getByLabelText('OpenCode API base URL'),
      'https://api.example.com/v1',
    );
    fireEvent.changeText(screen.getByLabelText('OpenCode API key'), 'provider-secret');
    expect(screen.queryByLabelText('OpenCode models')).toBeNull();
    fireEvent.press(screen.getByLabelText('Save OpenCode'));

    await waitFor(() =>
      expect(updateVeritySettings).toHaveBeenCalledWith({
        opencodeBaseUrl: 'https://api.example.com/v1',
        opencodeApiKey: 'provider-secret',
      }),
    );
    expect(await screen.findByLabelText('Open Verity')).toBeEnabled();
  });

  it('hides wizard navigation while editing OpenCode even when another provider is ready', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status({ claudeConfigured: true })),
        getVeritySettings: jest.fn().mockResolvedValue({}),
      }),
    );

    render(<OnboardingAiBackends />);
    expect(await screen.findByLabelText('Open Verity')).toBeEnabled();
    expect(screen.getByLabelText('Back')).toBeOnTheScreen();

    fireEvent.press(await screen.findByLabelText('Configure OpenCode'));
    expect(screen.queryByLabelText('Open Verity')).toBeNull();
    expect(screen.queryByLabelText('Back')).toBeNull();

    fireEvent.press(screen.getByLabelText('Cancel OpenCode setup'));
    expect(await screen.findByLabelText('Open Verity')).toBeEnabled();
    expect(screen.getByLabelText('Back')).toBeOnTheScreen();
  });

  it.each([
    { disabled: 'provider/model-a,provider/model-b', ready: false },
    { disabled: 'provider/model-a', ready: true },
  ])(
    'requires an enabled OpenCode model before opening Verity ($ready)',
    async ({ disabled, ready }) => {
      mockCreateVerityClient.mockReturnValue(
        fakeClient({
          fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
          getVeritySettings: jest.fn().mockResolvedValue({
            opencodeBaseUrl: 'https://api.example.com/v1',
            opencodeApiKeyConfigured: true,
            opencodeModels: 'provider/model-a\nprovider/model-b',
            opencodeDisabledModels: disabled,
          }),
        }),
      );
      render(<OnboardingAiBackends />);
      await screen.findByLabelText(ready ? 'Edit OpenCode' : 'Configure OpenCode');
      await waitFor(() =>
        expect(screen.getByLabelText('Open Verity')).toHaveProp('accessibilityState', {
          disabled: !ready,
        }),
      );
    },
  );

  it('requires a fresh API key when an existing OpenCode endpoint changes', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        getVeritySettings: jest.fn().mockResolvedValue({
          opencodeApiKeyConfigured: true,
          opencodeBaseUrl: 'https://old.example.com/v1',
          opencodeModels: 'provider/model-a',
        }),
      }),
    );

    render(<OnboardingAiBackends />);
    fireEvent.press(await screen.findByLabelText('Edit OpenCode'));
    expect(screen.getByLabelText('Save OpenCode')).toBeEnabled();

    fireEvent.changeText(
      screen.getByLabelText('OpenCode API base URL'),
      'https://new.example.com/v1',
    );
    expect(screen.getByLabelText('Save OpenCode')).toBeDisabled();

    fireEvent.changeText(screen.getByLabelText('OpenCode API key'), 'replacement-secret');
    expect(screen.getByLabelText('Save OpenCode')).toBeEnabled();
  });
});
