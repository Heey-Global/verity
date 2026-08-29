// Smoke tests for the Settings screen's secret-store onboarding UI. Focused on
// the three status→UI branches (uninitialized → set, sealed → unlock + wrong-
// password error, unlocked → paste fields enabled). Not exhaustive — the pure
// status/validation logic is unit-tested in packages/mobile (vitest); here we only
// assert the screen wires those into the rendered React Native tree.
//
// The @verity/mobile client is never real: `../lib/client` is mocked so
// `createVerityClient()` returns an in-memory fake whose methods we control per
// test. No network, no env var needed. `VerityApiError` is the REAL class (imported
// from the actual module) so the screen's `instanceof VerityApiError` + `.status`
// branch for a rejected unlock is exercised faithfully.
import {
  VerityApiError,
  type VerityClient,
  type VeritySettings,
  type SecretStatus,
} from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openURL: jest.fn().mockResolvedValue(undefined),
}));

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
const mockCheckForAppUpdate = jest.fn();

jest.mock('../lib/automaticUpdates', () => ({
  checkForAppUpdate: () => mockCheckForAppUpdate(),
}));

// expo-router's `Stack.Screen` is a navigation-config sink with no host output; a
// null-rendering stub keeps it out of the tree without pulling in the router.
const mockPush = jest.fn<void, [string]>();
let mockSearchParams: { agentLogin?: string | string[] } = {};
const mockFocusCallbacks = new Set<() => void>();
jest.mock('expo-router', () => {
  // Run the focus callback once on mount (the settings screen uses it to re-read
  // the server version) — a faithful-enough stand-in for navigation focus.
  const react = require('react') as typeof import('react');
  return {
    Stack: { Screen: () => null },
    router: { push: (href: string) => mockPush(href) },
    useFocusEffect: (cb: () => void) =>
      react.useEffect(() => {
        mockFocusCallbacks.add(cb);
        cb();
        return () => {
          mockFocusCallbacks.delete(cb);
        };
      }, [cb]),
    useLocalSearchParams: () => mockSearchParams,
  };
});

const refocusSettings = () => {
  for (const callback of mockFocusCallbacks) callback();
};

jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => 'http://verity.test:8082',
}));

import SettingsScreen from '../app/settings';
import { ATTENTION_ACTION_ROUTES } from '../components/ServerAttentionBanner';

// A neutral, fully-configured settings object so the screen renders past its
// loading state. No secret/key material — only paths + plain identifiers (the
// write-only PEM boxes are never populated from server state).
function makeSettings(overrides: Partial<VeritySettings> = {}): VeritySettings {
  return {
    advancedModeEnabled: false,
    gitUserName: 'test-bot',
    gitUserEmail: 'bot@example.test',
    gitSshPrivateKeyPath: '/data/keys/id',
    gitSshPublicKeyPath: '/data/keys/id.pub',
    gitKnownHostsPath: '/data/keys/known_hosts',
    gitAllowedSignersPath: '/data/keys/allowed_signers',
    gitSshPrivateKeyConfigured: true,
    gitSshPublicKeyConfigured: true,
    gitKnownHostsConfigured: true,
    gitAllowedSignersConfigured: true,
    githubAppId: '123456',
    githubAppInstallationId: '78901234',
    githubAppPrivateKeyConfigured: true,
    dopplerServiceTokenConfigured: false,
    transcribeBaseUrl: null,
    transcribeModel: null,
    transcribeBackendMode: null,
    transcribeApiKeyConfigured: false,
    // No deployment bundles a local backend any more; the server reports this
    // permanently false, so the fixture must not claim otherwise. Nothing points
    // at a remote backend either — matching the null URL/model above.
    transcribeLocalAvailable: false,
    transcribeExternalConfigured: false,
    claudeCodeOauthCredentialsConfigured: false,
    codexAuthJsonConfigured: false,
    uplinkSubscriptionKeyConfigured: false,
    uplinkInstallationId: null,
    googleDriveClientId: null,
    googleDriveAccountEmail: null,
    googleDriveConnected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Build a fake client returning a fixed secret-store status. Only the methods the
// screen calls on mount + interaction are implemented; the rest throw if touched so
// an unexpected call surfaces loudly instead of silently no-op'ing.
function makeClient(
  status: SecretStatus,
  opts: {
    unlock?: jest.Mock;
    init?: jest.Mock;
    getSecretStatus?: jest.Mock;
    settings?: VeritySettings;
    startAgentLogin?: jest.Mock;
    updateVeritySettings?: jest.Mock;
    getServerUpdates?: jest.Mock;
    requestServerUpdate?: jest.Mock;
  } = {},
): VerityClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`unexpected client.${name} call`);
  };
  return {
    getVeritySettings: jest.fn().mockResolvedValue(opts.settings ?? makeSettings()),
    getSigningKey: jest.fn().mockResolvedValue({ configured: false, publicKey: null }),
    getSecretStatus: opts.getSecretStatus ?? jest.fn().mockResolvedValue(status),
    getHealth: jest.fn().mockResolvedValue({ status: 'ok', version: '9.9.9' }),
    initSecretPassword: opts.init ?? jest.fn().mockResolvedValue(undefined),
    unlockSecret: opts.unlock ?? jest.fn().mockResolvedValue(undefined),
    updateVeritySettings:
      opts.updateVeritySettings ?? jest.fn(notImplemented('updateVeritySettings')),
    startAgentLogin: opts.startAgentLogin ?? jest.fn(notImplemented('startAgentLogin')),
    getAgentLogin: jest.fn(notImplemented('getAgentLogin')),
    submitAgentLoginCode: jest.fn(notImplemented('submitAgentLoginCode')),
    disconnectAgentLogin: jest.fn(notImplemented('disconnectAgentLogin')),
    listProjects: jest.fn(notImplemented('listProjects')),
    recreateProjectContainer: jest.fn(notImplemented('recreateProjectContainer')),
    // Most deployments are not Verity-managed, so the self-update panel stays
    // hidden unless a test says otherwise.
    getServerUpdates:
      opts.getServerUpdates ??
      jest.fn().mockResolvedValue({ state: 'unsupported', reason: 'not managed', operation: null }),
    requestServerUpdate: opts.requestServerUpdate ?? jest.fn(notImplemented('requestServerUpdate')),
  } as unknown as VerityClient;
}

afterEach(() => {
  mockCreateVerityClient.mockReset();
  mockCheckForAppUpdate.mockReset();
  jest.restoreAllMocks();
  mockSearchParams = {};
});

describe('SettingsScreen — secret store onboarding', () => {
  it('renders the "set master password" UI when the store is uninitialized', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized'));
    render(<SettingsScreen />);

    // The onboarding copy + a set-password action are the tell for the `set` mode.
    expect(
      await screen.findByText('Set a master password to protect secrets at rest.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Set master password')).toBeOnTheScreen();
    // A confirm field is unique to `set` (unlock has only one password box).
    expect(screen.getByText('Confirm password')).toBeOnTheScreen();
  });

  it('submits init with the typed password and refetches status on success when uninitialized', async () => {
    const init = jest.fn().mockResolvedValue(undefined);
    // Distinct mock so we can count status fetches: mount (1) + post-init refresh (2).
    const getSecretStatus = jest.fn().mockResolvedValue('uninitialized');
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized', { init, getSecretStatus }));
    render(<SettingsScreen />);

    // Wait for the `set` form, then fill password + matching confirm (both boxes
    // share the •••• placeholder; order is [password, confirm]).
    await screen.findByLabelText('Set master password');
    const [passwordField, confirmField] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'correct-horse');
    fireEvent.changeText(confirmField, 'correct-horse');
    fireEvent.press(screen.getByLabelText('Set master password'));

    // The client is called with the typed password, and onUnlocked re-queries status.
    await waitFor(() => expect(init).toHaveBeenCalledWith('correct-horse'));
    await waitFor(() => expect(getSecretStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('blocks init on a mismatched confirmation and shows the inline validation error', async () => {
    const init = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized', { init }));
    render(<SettingsScreen />);

    await screen.findByLabelText('Set master password');
    const [passwordField, confirmField] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'correct-horse');
    fireEvent.changeText(confirmField, 'battery-staple');
    fireEvent.press(screen.getByLabelText('Set master password'));

    // Client-side validation rejects the mismatch before any network call.
    expect(await screen.findByText('Passwords do not match.')).toBeOnTheScreen();
    expect(init).not.toHaveBeenCalled();
  });

  it('renders the unlock UI and shows an inline error on a wrong password when sealed', async () => {
    // Reject with the real VerityApiError(401) the client throws for a bad password.
    const unlock = jest.fn().mockRejectedValue(new VerityApiError(401, 'unauthorized'));
    mockCreateVerityClient.mockReturnValue(makeClient('sealed', { unlock }));
    render(<SettingsScreen />);

    expect(
      await screen.findByText(
        'Enter the master password to unlock stored secrets after a restart.',
      ),
    ).toBeOnTheScreen();
    // `set` mode's confirm field must be absent in `unlock`.
    expect(screen.queryByText('Confirm password')).toBeNull();

    const passwordField = screen.getByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'wrong-password');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('wrong-password'));
    // The 401 branch surfaces an inline field error rather than the top banner.
    expect(await screen.findByText('Incorrect password.')).toBeOnTheScreen();
  });

  it('shows the Unlocked indicator and enables the secret paste fields when unlocked', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsScreen />);

    // The compact "Unlocked" pill replaces the password form in `ready` mode.
    expect(await screen.findByText('Unlocked')).toBeOnTheScreen();
    // The password form is gone once unlocked.
    expect(screen.queryByText('Master password')).toBeNull();
    // A write-only secret paste box is present and editable when unlocked (the
    // Doppler token box is always rendered under a managed store). The GitHub App
    // private-key box moved out of Settings to the dedicated /github-connect screen.
    expect(screen.getByPlaceholderText('Paste the Doppler token…')).toBeOnTheScreen();
    expect(screen.queryByText('Unlock the secret store to change this.')).toBeNull();
    // The editable GitHub-App fields are gone from Settings; a compact summary + a
    // link to the manage screen replaces them.
    expect(screen.queryByPlaceholderText('Paste PEM…')).toBeNull();
    expect(screen.getByLabelText('Manage GitHub connection')).toBeOnTheScreen();
    expect(screen.getByText('Connected')).toBeOnTheScreen();
    // Only the running app version is visible; build/server diagnostics no longer
    // compete with the release number in the footer.
    const version = await screen.findByLabelText('Version mock');
    expect(version).toBeOnTheScreen();
    expect(screen.queryByText(/Server 9\.9\.9/)).toBeNull();
  });

  it('checks EAS Update when the version is long-pressed', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    mockCheckForAppUpdate.mockResolvedValue('current');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<SettingsScreen />);

    const version = await screen.findByLabelText('Version mock');
    const releaseVersion = String(version.props.accessibilityLabel).replace('Version ', '');
    fireEvent(version, 'longPress');

    await waitFor(() => expect(mockCheckForAppUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Verity is up to date', releaseVersion));
  });

  it('shows the active Claude flow when re-login starts from a configured account', async () => {
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      provider: 'claude',
      status: 'ready',
      verificationUri: 'https://claude.com/oauth/authorize',
      userCode: null,
      needsCode: true,
      configured: false,
      message: null,
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ claudeCodeOauthCredentialsConfigured: true }),
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Reconnect Claude'));

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('claude'));
    expect(await screen.findByLabelText('Open Claude login page')).toBeOnTheScreen();
    expect(screen.getByLabelText('Claude returned code')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Reconnect Claude')).toBeNull();
  });

  it('starts Claude re-login automatically when opened from an expired chat session', async () => {
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      provider: 'claude',
      status: 'ready',
      verificationUri: 'https://claude.com/oauth/authorize',
      userCode: null,
      needsCode: true,
      configured: false,
      message: null,
    });
    mockSearchParams = { agentLogin: 'claude' };
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ claudeCodeOauthCredentialsConfigured: true }),
      }),
    );

    render(<SettingsScreen />);

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledTimes(1));
    expect(startAgentLogin).toHaveBeenCalledWith('claude');
    expect(await screen.findByLabelText('Open Claude login page')).toBeOnTheScreen();
  });

  // The other end of the overview's "Sign in to Codex" banner action: the tap only
  // helps if arriving here opens the Codex flow rather than the settings screen.
  it('starts Codex re-login automatically when opened from the attention banner', async () => {
    const startAgentLogin = jest.fn().mockResolvedValue({
      sessionId: '33333333-3333-4333-8333-333333333333',
      provider: 'codex',
      status: 'ready',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'UXAB-12345',
      needsCode: false,
      configured: false,
      message: null,
    });
    // Parsed from the route the banner actually navigates to, rather than a hand-
    // written `{ agentLogin: 'codex' }`: the two ends are a query-string key apart,
    // and spelling it twice lets one side be renamed with both suites still green.
    mockSearchParams = Object.fromEntries(
      new URL(String(ATTENTION_ACTION_ROUTES['codex-login']), 'https://verity.invalid')
        .searchParams,
    );
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ codexAuthJsonConfigured: true }),
      }),
    );

    render(<SettingsScreen />);

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledTimes(1));
    expect(startAgentLogin).toHaveBeenCalledWith('codex');
    // And the flow is actually on screen: the call alone would be satisfied by a
    // login started into a panel the operator never sees.
    expect(await screen.findByLabelText('Open Codex login page')).toBeOnTheScreen();

    // Tapping the banner again returns to THIS screen — `navigate`, not `push` —
    // and must not start a second login: the device code already on screen would
    // be invalidated by the one that replaced it, mid-entry. The flow stays where
    // the first tap left it, which is what returning to it is for.
    refocusSettings();
    await waitFor(() => expect(screen.getByLabelText('Open Codex login page')).toBeOnTheScreen());
    expect(startAgentLogin).toHaveBeenCalledTimes(1);
  });

  // The same tap into a store that cannot yet hold the result. Nothing can start
  // here, so the screen has to say what the tap is waiting on rather than let it
  // read as a button that did nothing.
  it('says what a sealed store is blocking when opened from the banner', async () => {
    const startAgentLogin = jest.fn();
    mockSearchParams = { agentLogin: 'codex' };
    mockCreateVerityClient.mockReturnValue(makeClient('sealed', { startAgentLogin }));

    render(<SettingsScreen />);

    expect(
      await screen.findByText(/Unlock the secret store to sign in/, { exact: false }),
    ).toBeOnTheScreen();
    expect(startAgentLogin).not.toHaveBeenCalled();
  });

  // The parameter comes off a URL and can say anything. An unrecognised provider
  // has to land on a settings screen doing nothing, not start a login for it.
  it('ignores an agentLogin the app does not know', async () => {
    const startAgentLogin = jest.fn();
    mockSearchParams = { agentLogin: 'gemini' };
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { startAgentLogin }));

    render(<SettingsScreen />);

    await screen.findByLabelText('Manage GitHub connection');
    expect(startAgentLogin).not.toHaveBeenCalled();
  });

  // Repeating the parameter makes the router hand over an array, not a string.
  it('ignores a repeated agentLogin parameter', async () => {
    const startAgentLogin = jest.fn();
    mockSearchParams = { agentLogin: ['codex', 'claude'] };
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { startAgentLogin }));

    render(<SettingsScreen />);

    await screen.findByLabelText('Manage GitHub connection');
    expect(startAgentLogin).not.toHaveBeenCalled();
  });

  it('links to the standalone GitHub manage screen from the connection summary', async () => {
    mockPush.mockClear();
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsScreen />);

    const manage = await screen.findByLabelText('Manage GitHub connection');
    // Technical App/installation identifiers stay out of the user-facing summary.
    expect(screen.queryByText('123456')).toBeNull();
    expect(screen.queryByText('78901234')).toBeNull();
    fireEvent.press(manage);
    expect(mockPush).toHaveBeenCalledWith('/github-connect');
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<SettingsScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });

  it('offers a "Change server address" recovery entry that routes to the reconfigure step', async () => {
    mockPush.mockClear();
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsScreen />);
    // The current address is shown, and the entry routes to the server-url step in
    // reconfigure mode — the recovery path from a wrong/stale saved address. (Await
    // the loaded view; the screen shows a spinner during the initial settings load.)
    const entry = await screen.findByLabelText('Change server address');
    expect(screen.getByText('http://verity.test:8082')).toBeOnTheScreen();
    fireEvent.press(entry);
    expect(mockPush).toHaveBeenCalledWith('/onboarding/server-url?reconfigure=1');
  });

  it('keeps GitHub access, commit author, and verification in one dedicated group', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({ transcribeBackendMode: 'external' }),
      }),
    );
    render(<SettingsScreen />);

    expect(await screen.findByText('This app')).toBeOnTheScreen();
    expect(screen.getByText('GitHub')).toBeOnTheScreen();
    expect(screen.getByText('Connected services')).toBeOnTheScreen();
    expect(screen.getByText('Maintenance')).toBeOnTheScreen();
    expect(screen.getByText('Repository access')).toBeOnTheScreen();
    expect(screen.getByText('Commit author')).toBeOnTheScreen();
    expect(screen.getByText('Verified commits')).toBeOnTheScreen();
    expect(screen.queryByText('Agent Git identity')).toBeNull();
    expect(screen.queryByText(/File paths|Advanced: key files/)).toBeNull();
    expect(screen.getByText('Meeting transcription')).toBeOnTheScreen();
    expect(screen.getByLabelText('Transcription API base URL')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Paste the transcription token…')).toBeOnTheScreen();
    expect(screen.getByLabelText('Transcription model')).toBeOnTheScreen();
  });

  it('saves the transcription URL, token, and model without echoing the token', async () => {
    const initial = makeSettings({ transcribeBackendMode: 'external' });
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsScreen />);

    const url = await screen.findByLabelText('Transcription API base URL');
    const token = screen.getByPlaceholderText('Paste the transcription token…');
    const model = screen.getByLabelText('Transcription model');
    fireEvent.changeText(url, 'https://api.example.test/v1');
    fireEvent.changeText(token, 'transcription-token-fixture');
    fireEvent.changeText(model, 'whisper-test');
    fireEvent(model, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    expect(updateVeritySettings.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        transcribeBaseUrl: 'https://api.example.test/v1',
        transcribeApiKey: 'transcription-token-fixture',
        transcribeModel: 'whisper-test',
      }),
    );
    await waitFor(() => expect(token).toHaveProp('value', ''));
  });

  it('persists an explicit backend choice', async () => {
    const initial = makeSettings({ transcribeBackendMode: null });
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsScreen />);

    const pill = await screen.findByLabelText('Choose backend');
    expect(within(pill).getByText('!')).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Use external transcription'));
    await waitFor(() =>
      expect(updateVeritySettings).toHaveBeenCalledWith(
        expect.objectContaining({ transcribeBackendMode: 'external' }),
      ),
    );
    // Picking external does not configure it: this fixture has no URL or model
    // on either side, so the section must keep asking for them rather than
    // reporting a backend that would reject the upload.
    const chosen = await screen.findByLabelText('Add URL and model');
    expect(within(chosen).getByText('!')).toBeOnTheScreen();
    expect(within(chosen).queryByText('✓')).toBeNull();
  });

  it('reports an external backend the deployment can reach as ready', async () => {
    // `transcribeExternalConfigured` is the server's own answer, so this covers
    // the deployment-configured case too: the URL and model may come from the
    // environment and never appear in these fields.
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({
          transcribeBackendMode: 'external',
          transcribeExternalConfigured: true,
        }),
      }),
    );
    render(<SettingsScreen />);

    // The pill's glyph follows its intent (`✓` ready, `!` needs setup).
    expect(within(await screen.findByLabelText('External')).getByText('✓')).toBeOnTheScreen();
  });

  it('never presents the removed local backend as ready or selectable', async () => {
    // Store migration 0083 clears this preference, but a server that has not
    // restarted into the new schema yet can still hand the app a persisted
    // `local`. It must read as unavailable — every upload against it is rejected
    // as not configured — never as a backend that is set up.
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: makeSettings({ transcribeBackendMode: 'local' }) }),
    );
    render(<SettingsScreen />);

    const pill = await screen.findByLabelText('Local unavailable');
    expect(within(pill).getByText('!')).toBeOnTheScreen();
    expect(within(pill).queryByText('✓')).toBeNull();
    expect(screen.getByLabelText('Use local transcription')).toBeDisabled();
    expect(screen.getByText('Not available in this deployment.')).toBeOnTheScreen();
  });

  it('auto-saves text fields on blur without a Save button', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsScreen />);

    const gitUser = await screen.findByLabelText('Commit name');
    fireEvent.changeText(gitUser, 'new-bot');
    fireEvent(gitUser, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    expect(updateVeritySettings.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ gitUserName: 'new-bot' }),
    );
    expect(screen.queryByLabelText('Save Verity settings')).toBeNull();
    expect(await screen.findByLabelText('Reprovision running containers now')).toBeOnTheScreen();
  });

  it('auto-saves a toggle switch immediately', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Advanced mode'));

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    expect(updateVeritySettings.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ advancedModeEnabled: true }),
    );
    expect(screen.queryByLabelText('Reprovision running containers now')).toBeNull();
  });

  // Verity updating itself: the panel only exists on a managed deployment, and
  // the digest it installs is the server's, never one the app composed.
  it('hides the server update panel on a deployment Verity does not manage', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsScreen />);

    expect(await screen.findByText('Maintenance')).toBeTruthy();
    expect(screen.queryByText('Updates are managed elsewhere')).toBeNull();
  });

  it('refreshes a transiently unreachable release channel when settings regains focus', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({
        state: 'unreachable',
        reason: 'release channel manifest request failed: HTTP 404',
        lastGood: null,
        operation: null,
      })
      .mockResolvedValue({
        state: 'available',
        release: { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' },
        operation: null,
      });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { getServerUpdates }));
    render(<SettingsScreen />);

    expect(await screen.findByText('Update check unavailable')).toBeOnTheScreen();
    await act(async () => refocusSettings());

    expect(await screen.findByText('Version 1.4.0 available')).toBeOnTheScreen();
    expect(getServerUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not let an older update check overwrite a newer focused result', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    let finishFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const getServerUpdates = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        state: 'available',
        release: { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' },
        operation: null,
      });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { getServerUpdates: getServerUpdates as never }),
    );
    render(<SettingsScreen />);

    await waitFor(() => expect(getServerUpdates).toHaveBeenCalledTimes(1));
    await act(async () => refocusSettings());
    expect(await screen.findByText('Version 1.4.0 available')).toBeOnTheScreen();
    await act(async () =>
      finishFirst?.({
        state: 'unreachable',
        reason: 'slow failure',
        lastGood: null,
        operation: null,
      }),
    );

    expect(screen.getByText('Version 1.4.0 available')).toBeOnTheScreen();
    expect(screen.queryByText('Update check unavailable')).toBeNull();
  });

  it('installs exactly the digest the server offered', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    const requestServerUpdate = jest.fn().mockResolvedValue({
      updateId: 'update-1',
      state: 'preparing',
      phase: 'requested',
      step: 1,
      totalSteps: 14,
      generation: 3,
      previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      targetDigest: serverImage,
      failureCode: null,
      startedAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: {
            version: '1.4.0',
            serverImage,
            publishedAt: '2026-08-10T00:00:00.000Z',
          },
          operation: null,
        }),
        requestServerUpdate,
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    await waitFor(() => expect(requestServerUpdate).toHaveBeenCalledTimes(1));
    expect(requestServerUpdate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ targetDigest: serverImage }),
    );
    // Once accepted, the panel reports progress instead of offering the action
    // again — a second press would race the operation already running.
    expect(await screen.findByText('Step 1 of 14')).toBeTruthy();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  // A failed attempt stays the current journal entry, so retrying under the key
  // of the first attempt would be answered with that same failure forever.
  it('retries a failed update under a key that starts a new attempt', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    const requestServerUpdate = jest.fn().mockRejectedValue(new VerityApiError(503, 'unavailable'));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' },
          operation: {
            updateId: 'update-1',
            state: 'failed',
            phase: 'failed',
            step: 2,
            totalSteps: 14,
            generation: 3,
            previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
            targetDigest: serverImage,
            failureCode: 'pulling-failed',
            startedAt: '2026-08-10T00:00:00.000Z',
            updatedAt: '2026-08-10T00:00:05.000Z',
          },
        }),
        requestServerUpdate,
      }),
    );
    render(<SettingsScreen />);

    expect(await screen.findByText('The new version could not be downloaded.')).toBeTruthy();
    fireEvent.press(await screen.findByLabelText('Try again'));

    await waitFor(() => expect(requestServerUpdate).toHaveBeenCalledTimes(1));
    const sent: unknown = requestServerUpdate.mock.calls[0]?.[0];
    expect(sent).toEqual(
      expect.objectContaining({ targetDigest: serverImage, idempotencyKey: expect.any(String) }),
    );
    expect((sent as { idempotencyKey: string }).idempotencyKey).toContain('g3');
  });

  // The response to an accepted request is exactly what cutover drops. Treating
  // that as a failed start would leave the panel idle, and re-offering Install
  // while the server is already replacing itself.
  it('picks up an update whose acceptance response was lost', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'d'.repeat(64)}`;
    const release = { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' };
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({ state: 'available', release, operation: null })
      .mockResolvedValue({
        state: 'available',
        release,
        operation: {
          updateId: 'update-1',
          state: 'preparing',
          phase: 'pulling',
          step: 2,
          totalSteps: 14,
          generation: 1,
          previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          targetDigest: serverImage,
          failureCode: null,
          startedAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:05.000Z',
        },
      });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates,
        requestServerUpdate: jest.fn().mockRejectedValue(new Error('network')),
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(await screen.findByText('Step 2 of 14')).toBeTruthy();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  it('explains a rejected update instead of leaving the button silent', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'c'.repeat(64)}`;
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' },
          operation: null,
        }),
        requestServerUpdate: jest
          .fn()
          .mockRejectedValue(new VerityApiError(403, 'updates require a paired device')),
      }),
    );
    render(<SettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(await screen.findByText('Set a master password before updating Verity.')).toBeTruthy();
  });
});
