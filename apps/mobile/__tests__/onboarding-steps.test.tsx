// Behaviour tests for the real onboarding STEP screens (#320): the master-password
// step (set / unlock / wrong-password / already-unlocked) and the GitHub App step in
// BOTH modes — manifest one-click (default: opens the start URL, polls status, and
// advances on githubAppConfigured; null-base guard) and the existing-App fallback
// (save → validate → advance gate, failure blocks, guidance). These assert
// user-visible behaviour — what the operator sees and what the screen does with the
// client — not the components' internals, so a valid re-implementation would pass.
//
// `expo-router` is mocked so `router.replace` (the scaffold's Back/Next) is
// observable; `../lib/client` is mocked so each test injects an in-memory fake
// VerityClient. `@verity/mobile` resolves to its built dist (jest moduleNameMapper)
// so `secretUiMode` / `secretPatchFromDraft` run for real.
import { VerityApiError } from '@verity/mobile';
import type { VerityClient, OnboardingStatus, SecretUnlocked } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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

// `expo-clipboard` has no jsdom backend — mock it so the copy button's effect is
// observable without a native module.
const mockSetStringAsync = jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true);
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockSetStringAsync(value),
}));

import OnboardingMasterPassword from '../app/onboarding/master-password';
import UnlockDevice from '../app/unlock-device';
import OnboardingGithub from '../app/onboarding/github';
import OnboardingAiBackends from '../app/onboarding/ai-backends';

function fakeClient(overrides: Partial<VerityClient>): VerityClient {
  return overrides as unknown as VerityClient;
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

  it('does not use token-only biometric unlock when server secret unlock is required', async () => {
    mockLocalSearchParams = { returnTo: '/', serverSecret: '1' };
    const getSecretStatus = jest.fn<Promise<'sealed'>, []>().mockResolvedValue('sealed');
    mockCreateVerityClient.mockReturnValue(fakeClient({ getSecretStatus }));
    mockUnlockAuthTokenWithBiometrics.mockResolvedValue(true);

    render(<UnlockDevice />);

    expect(mockUnlockAuthTokenWithBiometrics).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Master password')).toBeOnTheScreen();
    expect(screen.getByText('Device authorization')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Step 1 of 6')).toBeNull();
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

    await waitFor(() => expect(initSecretPassword).toHaveBeenCalledWith('super-secret-pw'));
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

    await waitFor(() => expect(unlockSecret).toHaveBeenCalledWith('correct-pw'));
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
    expect(screen.queryByLabelText('Step 1 of 6')).toBeNull();
    expect(screen.queryByText('Secrets are unlocked for this device.')).toBeNull();

    fireEvent.changeText(screen.getByLabelText('Master password'), 'correct-pw');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() => expect(unlockSecret).toHaveBeenCalledWith('correct-pw'));
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
    expect(screen.queryByLabelText('Step 1 of 6')).toBeNull();

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

    await waitFor(() => expect(unlockSecret).toHaveBeenCalledWith('right-pw'));
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

describe('onboarding github one-page setup', () => {
  const PUBLIC_KEY = 'ssh-ed25519 AAAAExamplePublicKeyBody holger@example.test';

  it('shows one Connect to GitHub path without existing-App credentials', () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest.fn().mockResolvedValue(status()),
        prepareGithubManifest: jest.fn().mockResolvedValue('ott-test'),
      }),
    );

    render(<OnboardingGithub />);

    expect(screen.getByLabelText('Connect to GitHub')).toBeOnTheScreen();
    expect(screen.queryByText('Use existing App')).toBeNull();
    expect(screen.queryByLabelText('App ID')).toBeNull();
    expect(screen.queryByLabelText('App private key')).toBeNull();
  });

  it('shows author and signing key on the same page and unlocks Next after copy', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest
          .fn()
          .mockResolvedValue(status({ githubAppConfigured: true, nextStep: 'github' })),
        getVeritySettings: jest.fn().mockResolvedValue({
          gitUserName: 'Holger',
          gitUserEmail: 'holger@example.test',
        }),
        getSigningKey: jest.fn().mockResolvedValue({ configured: true, publicKey: PUBLIC_KEY }),
      }),
    );

    render(<OnboardingGithub />);

    expect(await screen.findByText('GitHub connected')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Holger')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('holger@example.test')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Next')).toBeNull();

    fireEvent.press(screen.getByLabelText('Copy signing public key'));
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith(PUBLIC_KEY));
    expect(await screen.findByLabelText('Next')).toBeOnTheScreen();
  });

  it('treats an already-configured key with no readable public key as done, not a dead end', async () => {
    mockCreateVerityClient.mockReturnValue(
      fakeClient({
        fetchOnboardingStatus: jest
          .fn()
          .mockResolvedValue(status({ githubAppConfigured: true, nextStep: 'github' })),
        getVeritySettings: jest.fn().mockResolvedValue({
          gitUserName: 'Holger',
          gitUserEmail: 'holger@example.test',
        }),
        // A path-configured signing key: configured, but no public key to copy here.
        getSigningKey: jest.fn().mockResolvedValue({ configured: true, publicKey: null }),
      }),
    );

    render(<OnboardingGithub />);

    expect(await screen.findByText('GitHub connected')).toBeOnTheScreen();
    // No key to copy, so no copy affordance — but Next must still be reachable.
    expect(screen.queryByLabelText('Copy signing public key')).toBeNull();
    expect(await screen.findByLabelText('Next')).toBeOnTheScreen();
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
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/doppler');
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

    fireEvent.press(screen.getByLabelText('Open Codex login page'));
    expect(openURL).toHaveBeenCalledWith('https://auth.openai.com/codex/device');

    fireEvent.press(screen.getByLabelText('Copy Codex code'));
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('UXAB-12345'));
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
    fireEvent.changeText(await screen.findByLabelText('Claude returned code'), '  claude-code  ');
    fireEvent.press(screen.getByLabelText('Submit Claude code'));

    await waitFor(() =>
      expect(submitAgentLoginCode).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
        '  claude-code  ',
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

    await screen.findByLabelText('Next');
    expect(screen.queryByLabelText('Skip — set up later')).toBeNull();
    expect(screen.getByLabelText('Next')).toHaveProp('accessibilityState', { disabled: true });
  });
});
