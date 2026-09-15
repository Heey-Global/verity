// The GitHub settings screen: repository access, commit author, signing key.
//
// The guard this suite exists for is the second one below. Settings used to be
// one screen whose save sent every field it held; split across five screens,
// that same patch shape means saving a commit name here would send `null` for
// the Doppler token, the OpenCode endpoint and the transcription backend — all
// of them fields this screen never rendered, all of them cleared without a word
// on screen. This screen owns two keys, and a save from it may mention no other.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import GitHubSettingsScreen from '../app/settings/github';
import {
  expectPatchClearsNothing,
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  mockOpenURL,
  mockPush,
  refocus,
  resetSettingsHarness,
} from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings/github — commit author', () => {
  it('auto-saves the author fields on blur, with no Save button anywhere', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<GitHubSettingsScreen />);

    const name = await screen.findByLabelText('Commit name');
    fireEvent.changeText(name, 'new-bot');
    expect(screen.getByText('Unsaved changes')).toBeOnTheScreen();
    fireEvent(name, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('All changes saved')).toBeOnTheScreen();
    expect(updateVeritySettings.mock.calls[0]?.[0]).toEqual({ gitUserName: 'new-bot' });
    expect(screen.queryByLabelText('Save Verity settings')).toBeNull();
  });

  // The landmine. A save from this screen may carry only what this screen shows;
  // `expectPatchClearsNothing` checks the general shape of the failure — no key
  // going out as `null` while the server holds a value for it — against the
  // loaded record rather than a restated list of the other screens' fields.
  it('sends no field this screen does not render', async () => {
    const initial = makeSettings({
      dopplerServiceTokenConfigured: true,
      opencodeBaseUrl: 'https://api.example.test/v1',
      opencodeModels: 'gpt-4.1',
      transcribeBaseUrl: 'https://transcribe.example.test/v1',
      transcribeModel: 'whisper-large-v3',
      transcribeBackendMode: 'external',
    });
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<GitHubSettingsScreen />);

    const email = await screen.findByLabelText('Commit email');
    fireEvent.changeText(email, 'bot@acme.test');
    fireEvent(email, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    const patch = updateVeritySettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['gitUserEmail']);
    expectPatchClearsNothing(patch, initial);
  });

  it('retries a failed author auto-save from the error banner', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...initial, gitUserName: 'retry-bot' });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<GitHubSettingsScreen />);

    const name = await screen.findByLabelText('Commit name');
    fireEvent.changeText(name, 'retry-bot');
    fireEvent(name, 'blur');
    expect(await screen.findByText('Could not save settings')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Retry'));

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('All changes saved')).toBeOnTheScreen();
  });

  it('does not save a field the operator only tabbed through', async () => {
    const updateVeritySettings = jest.fn();
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { updateVeritySettings }));
    render(<GitHubSettingsScreen />);

    const name = await screen.findByLabelText('Commit name');
    fireEvent(name, 'blur');
    fireEvent(screen.getByLabelText('Commit email'), 'blur');

    // Nothing changed, so there is nothing to write — an unchanged PATCH would
    // still bump `updatedAt` and mark running containers as out of date.
    await waitFor(() => expect(screen.getByText('All changes saved')).toBeOnTheScreen());
    expect(updateVeritySettings).not.toHaveBeenCalled();
  });

  // Readiness follows what is on screen, not what was last stored: a pill that
  // stays red until the blur lands reads as if the typing did not count.
  it('turns the identity pill ready as soon as both fields are filled', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        // Nothing on this screen is ready yet, so "Ready" appearing at all is
        // the identity pill and no other.
        settings: makeSettings({
          gitUserName: '',
          gitUserEmail: '',
          gitSshPrivateKeyConfigured: false,
          gitSshPrivateKeyPath: '',
        }),
      }),
    );
    render(<GitHubSettingsScreen />);

    const name = await screen.findByLabelText('Commit name');
    expect(screen.queryByText('Ready')).toBeNull();

    fireEvent.changeText(name, 'new-bot');
    fireEvent.changeText(screen.getByLabelText('Commit email'), 'bot@acme.test');

    // Typed, not yet blurred: nothing has been saved, and the pill still agrees
    // with what the operator can see.
    await waitFor(() => expect(screen.getByText('Ready')).toBeOnTheScreen());
  });
});

describe('settings/github — repository access', () => {
  it('links to the standalone manage screen instead of editing App credentials here', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<GitHubSettingsScreen />);

    const manage = await screen.findByLabelText('Manage GitHub connection');
    // The App id / installation id are plumbing, not settings: they stay off
    // this screen, and the private key is pasted on /github-connect.
    expect(screen.queryByText('123456')).toBeNull();
    expect(screen.queryByText('78901234')).toBeNull();
    expect(screen.queryByPlaceholderText('Paste PEM…')).toBeNull();
    expect(screen.getByText('Connected')).toBeOnTheScreen();

    fireEvent.press(manage);
    expect(mockPush).toHaveBeenCalledWith('/github-connect');
  });

  it('does not report a partial GitHub credential tuple as connected', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({
          githubAppId: null,
          githubAppInstallationId: null,
          githubAppPrivateKeyConfigured: true,
        }),
      }),
    );
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText('Not connected')).toBeOnTheScreen();
  });

  it('refreshes the connection status after returning from GitHub Connect', async () => {
    const disconnected = makeSettings({
      githubAppId: null,
      githubAppInstallationId: null,
      githubAppPrivateKeyConfigured: false,
    });
    const getVeritySettings = jest
      .fn()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue(makeSettings());
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { getVeritySettings }));
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText('Not connected')).toBeOnTheScreen();
    await act(async () => refocus());

    expect(await screen.findByText('Connected')).toBeOnTheScreen();
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<GitHubSettingsScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });
});

describe('settings/github — verified commits', () => {
  it('creates a missing signing key without sending the user back through onboarding', async () => {
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIgenerated verity';
    const generateSigningKey = jest.fn().mockResolvedValue({ ok: true, publicKey });
    const missingIdentity = makeSettings({
      gitUserName: null,
      gitUserEmail: null,
      gitSshPrivateKeyConfigured: false,
      gitSshPrivateKeyPath: null,
    });
    const getVeritySettings = jest
      .fn()
      .mockResolvedValueOnce(missingIdentity)
      .mockResolvedValue(
        makeSettings({ gitSshPrivateKeyConfigured: true, gitSshPublicKeyConfigured: true }),
      );
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings,
        getSigningKey: jest.fn().mockResolvedValue({ configured: false, publicKey: null }),
        generateSigningKey,
      }),
    );
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Create signing key'));

    await waitFor(() => expect(generateSigningKey).toHaveBeenCalledWith(undefined));
    expect(await screen.findByText(publicKey)).toBeOnTheScreen();
    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(2));
  });

  it('shows the public signing key and offers the GitHub page to paste it into', async () => {
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplekeymaterial verity';
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getSigningKey: jest.fn().mockResolvedValue({ configured: true, publicKey }),
      }),
    );
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText(publicKey)).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Open GitHub SSH key settings'));
    // The key is added on GitHub's own page; the app only takes the operator
    // there. Any other destination sends them somewhere it cannot be pasted.
    expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/settings/ssh/new');
  });

  it('offers a retry when the signing key could not be loaded', async () => {
    const getSigningKey = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ configured: false, publicKey: null });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { getSigningKey }));
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Retry loading signing key'));
    await waitFor(() => expect(getSigningKey).toHaveBeenCalledTimes(2));
  });
});
