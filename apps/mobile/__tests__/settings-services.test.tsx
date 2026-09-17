// Connected services: the secret store's master-password lifecycle, the AI
// backend logins, transcription, Doppler, and the way into MCP connections.
//
// Two things are worth more than the rest here. The secret-store branches
// (uninitialized → set, sealed → unlock, unlocked → paste boxes editable),
// because every credential below them is unwritable until one of them lands.
// And the write-only paste boxes, which are where a patch built from the whole
// draft would do its worst damage: pasting a Doppler token would send the GitHub
// App id as `null` in the same request, disconnecting a working GitHub while the
// screen reported a saved token.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { VerityApiError } from '@verity/mobile';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import ServicesSettingsScreen from '../app/settings/services/index';
import { ATTENTION_ACTION_ROUTES } from '../components/ServerAttentionBanner';
import {
  expectPatchClearsNothing,
  makeClient,
  makeSettings,
  mockCreateVerityClient,
  mockPush,
  refocus,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings/services — secret store onboarding', () => {
  it('renders the "set master password" UI when the store is uninitialized', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized'));
    render(<ServicesSettingsScreen />);

    expect(
      await screen.findByText('Set a master password to protect secrets at rest.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Set master password')).toBeOnTheScreen();
    // A confirm field is unique to `set` (unlock has only one password box).
    expect(screen.getByText('Confirm password')).toBeOnTheScreen();
  });

  it('submits init with the typed password and refetches status on success', async () => {
    const init = jest.fn().mockResolvedValue(undefined);
    // Distinct mock so status fetches can be counted: mount (1) + refresh (2).
    const getSecretStatus = jest.fn().mockResolvedValue('uninitialized');
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized', { init, getSecretStatus }));
    render(<ServicesSettingsScreen />);

    await screen.findByLabelText('Set master password');
    const [passwordField, confirmField] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'correct-horse');
    fireEvent.changeText(confirmField, 'correct-horse');
    fireEvent.press(screen.getByLabelText('Set master password'));

    await waitFor(() => expect(init).toHaveBeenCalledWith('correct-horse'));
    await waitFor(() => expect(getSecretStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('blocks init on a mismatched confirmation and shows the inline validation error', async () => {
    const init = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized', { init }));
    render(<ServicesSettingsScreen />);

    await screen.findByLabelText('Set master password');
    const [passwordField, confirmField] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'correct-horse');
    fireEvent.changeText(confirmField, 'battery-staple');
    fireEvent.press(screen.getByLabelText('Set master password'));

    expect(await screen.findByText('Passwords do not match.')).toBeOnTheScreen();
    expect(init).not.toHaveBeenCalled();
  });

  // 409 means the password was set from somewhere else while this form was open.
  // The form is stale, not wrong — refetching advances it instead of leaving the
  // operator retyping into a screen that can no longer accept it.
  it('advances a stale set-password form when the store already has a password', async () => {
    const init = jest.fn().mockRejectedValue(new VerityApiError(409, 'already initialized'));
    const getSecretStatus = jest
      .fn()
      .mockResolvedValueOnce('uninitialized')
      .mockResolvedValue('unlocked');
    mockCreateVerityClient.mockReturnValue(makeClient('uninitialized', { init, getSecretStatus }));
    render(<ServicesSettingsScreen />);

    await screen.findByLabelText('Set master password');
    const [passwordField, confirmField] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.changeText(passwordField, 'correct-horse');
    fireEvent.changeText(confirmField, 'correct-horse');
    fireEvent.press(screen.getByLabelText('Set master password'));

    expect(await screen.findByText('Unlocked')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Set master password')).toBeNull();
  });

  it('renders the unlock UI and shows an inline error on a wrong password', async () => {
    const unlock = jest.fn().mockRejectedValue(new VerityApiError(401, 'unauthorized'));
    mockCreateVerityClient.mockReturnValue(makeClient('sealed', { unlock }));
    render(<ServicesSettingsScreen />);

    expect(
      await screen.findByText(
        'Enter the master password to unlock stored secrets after a restart.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Confirm password')).toBeNull();

    fireEvent.changeText(screen.getByPlaceholderText('••••••••'), 'wrong-password');
    fireEvent.press(screen.getByLabelText('Unlock secret store'));

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('wrong-password'));
    // The 401 branch surfaces an inline field error rather than the top banner.
    expect(await screen.findByText('Incorrect password.')).toBeOnTheScreen();
  });

  it('shows the Unlocked indicator and enables the paste boxes when unlocked', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    expect(await screen.findByText('Unlocked')).toBeOnTheScreen();
    expect(screen.queryByText('Master password')).toBeNull();
    expect(screen.getByPlaceholderText('Paste the Doppler token…')).toBeOnTheScreen();
    expect(screen.queryByText('Unlock the secret store to change this.')).toBeNull();
  });

  it('keeps the credential boxes read-only while the store is sealed', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('sealed'));
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    const doppler = await screen.findByPlaceholderText('Paste the Doppler token…');
    // A write while sealed 503s, so the box says why rather than failing later.
    expect(doppler.props.editable).toBe(false);
    expect(screen.getAllByText('Unlock the secret store to change this.').length).toBeGreaterThan(
      0,
    );
  });

  // A deployment with no cipher of its own (env-injected credentials) has no
  // store to unlock and no encrypted fields to offer.
  it('hides the store and its credential fields entirely when unmanaged', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unmanaged'));
    render(<ServicesSettingsScreen />);

    // The MCP row is not gated on a secret store, so it is what proves the
    // screen rendered at all rather than merely failing to find the rest.
    await screen.findByLabelText('MCP connections');
    expect(screen.queryByText('Secret store')).toBeNull();
    expect(screen.queryByPlaceholderText('Paste the Doppler token…')).toBeNull();
  });
});

describe('settings/services — write-only credentials', () => {
  // The sharpest form of the split's landmine: a paste box saving the whole
  // draft would clear the GitHub App identifiers in the same request.
  it('sends only the credential that was pasted', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    const doppler = await screen.findByPlaceholderText('Paste the Doppler token…');
    fireEvent.changeText(doppler, 'dp.sa.fixture-token');
    fireEvent(doppler, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    const patch = updateVeritySettings.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['dopplerServiceToken']);
    expectPatchClearsNothing(patch, initial);
    // The plaintext leaves component state as soon as the request owns a copy.
    await waitFor(() => expect(doppler).toHaveProp('value', ''));
  });

  it('does not send a credential the operator left blank', async () => {
    const updateVeritySettings = jest.fn();
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { updateVeritySettings }));
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    const doppler = await screen.findByPlaceholderText('Paste the Doppler token…');
    fireEvent(doppler, 'blur');

    // A blank box means "leave it alone". Sent as `null`, it would clear a
    // credential the operator never touched.
    await waitFor(() => expect(screen.getByText('Unlocked')).toBeOnTheScreen());
    expect(updateVeritySettings).not.toHaveBeenCalled();
  });

  it('puts a failed paste back in the box so it is not silently lost', async () => {
    const updateVeritySettings = jest
      .fn()
      .mockRejectedValueOnce(new VerityApiError(503, 'sealed'))
      .mockResolvedValue(makeSettings({ dopplerServiceTokenConfigured: true }));
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { updateVeritySettings }));
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Doppler'));

    const doppler = await screen.findByPlaceholderText('Paste the Doppler token…');
    fireEvent.changeText(doppler, 'dp.sa.fixture-token');
    fireEvent(doppler, 'blur');

    await waitFor(() => expect(doppler).toHaveProp('value', 'dp.sa.fixture-token'));
    expect(await screen.findByText('Unlock the secret store first.')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Retry'));

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(2));
    expect(doppler).toHaveProp('value', '');
  });
});

describe('settings/services — AI backends', () => {
  const claudeSession = {
    sessionId: '22222222-2222-4222-8222-222222222222',
    provider: 'claude',
    status: 'ready',
    verificationUri: 'https://claude.com/oauth/authorize',
    userCode: null,
    needsCode: true,
    configured: false,
    message: null,
  };

  it('shows the active Claude flow when re-login starts from a configured account', async () => {
    const startAgentLogin = jest.fn().mockResolvedValue(claudeSession);
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ claudeCodeOauthCredentialsConfigured: true }),
      }),
    );
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Claude'));

    fireEvent.press(await screen.findByLabelText('Reconnect Claude'));

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith('claude'));
    expect(await screen.findByLabelText('Open Claude login page')).toBeOnTheScreen();
    expect(screen.getByLabelText('Claude returned code')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Reconnect Claude')).toBeNull();
  });

  it('starts Claude re-login automatically when opened from an expired chat session', async () => {
    const startAgentLogin = jest.fn().mockResolvedValue(claudeSession);
    setSearchParams({ agentLogin: 'claude' });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ claudeCodeOauthCredentialsConfigured: true }),
      }),
    );
    render(<ServicesSettingsScreen />);

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledTimes(1));
    expect(startAgentLogin).toHaveBeenCalledWith('claude');
    expect(await screen.findByLabelText('Open Claude login page')).toBeOnTheScreen();
  });

  // The other end of the overview's "Sign in to Codex" banner action: the tap
  // only helps if arriving here opens the Codex flow rather than the settings
  // screen. The parameters are parsed from the route the banner navigates to,
  // rather than hand-written — the two ends are a query-string key apart, and
  // spelling it twice lets one side be renamed with both suites still green.
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
    const route = new URL(String(ATTENTION_ACTION_ROUTES['codex-login']), 'https://verity.invalid');
    setSearchParams(Object.fromEntries(route.searchParams));
    // The banner must also point at the screen that now holds the login panel;
    // a correct parameter on the wrong route opens nothing.
    expect(route.pathname).toBe('/settings/services');
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        startAgentLogin,
        settings: makeSettings({ codexAuthJsonConfigured: true }),
      }),
    );
    render(<ServicesSettingsScreen />);

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledTimes(1));
    expect(startAgentLogin).toHaveBeenCalledWith('codex');
    // And the flow is actually on screen: the call alone would be satisfied by a
    // login started into a panel the operator never sees.
    expect(await screen.findByLabelText('Open Codex login page')).toBeOnTheScreen();

    // Tapping the banner again returns to THIS screen and must not start a
    // second login: the device code already on screen would be invalidated by
    // the one that replaced it, mid-entry.
    await act(async () => refocus());
    await waitFor(() => expect(screen.getByLabelText('Open Codex login page')).toBeOnTheScreen());
    expect(startAgentLogin).toHaveBeenCalledTimes(1);
  });

  // The same tap into a store that cannot yet hold the result. Nothing can start
  // here, so the screen has to say what the tap is waiting on rather than let it
  // read as a button that did nothing.
  it('says what a sealed store is blocking when opened from the banner', async () => {
    const startAgentLogin = jest.fn();
    setSearchParams({ agentLogin: 'codex' });
    mockCreateVerityClient.mockReturnValue(makeClient('sealed', { startAgentLogin }));
    render(<ServicesSettingsScreen />);

    expect(
      await screen.findByText(/Unlock the secret store to sign in/, { exact: false }),
    ).toBeOnTheScreen();
    expect(startAgentLogin).not.toHaveBeenCalled();
  });

  // The parameter comes off a URL and can say anything. An unrecognised provider
  // has to land on a screen doing nothing, not start a login for it.
  it.each([
    ['an unknown provider', 'gemini'],
    ['a repeated parameter', ['codex', 'claude']],
  ])('ignores %s', async (_label, agentLogin) => {
    const startAgentLogin = jest.fn();
    setSearchParams({ agentLogin });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { startAgentLogin }));
    render(<ServicesSettingsScreen />);

    await screen.findByText('Unlocked');
    expect(startAgentLogin).not.toHaveBeenCalled();
  });

  it('opens OpenCode connection and model settings on its own page', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('OpenCode'));
    expect(mockPush).toHaveBeenCalledWith('/settings/services/opencode');
  });
});

describe('settings/services — meeting transcription', () => {
  it('persists an explicit backend choice', async () => {
    const initial = makeSettings({ transcribeBackendMode: null });
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Transcription'));

    const pill = await screen.findByLabelText('Choose backend');
    expect(within(pill).getByText('!')).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Use external transcription'));
    await waitFor(() =>
      expect(updateVeritySettings).toHaveBeenCalledWith({ transcribeBackendMode: 'external' }),
    );
    // Picking external does not configure it: this fixture has no URL or model
    // on either side, so the section must keep asking for them rather than
    // reporting a backend that would reject the upload.
    const chosen = await screen.findByLabelText('Add URL and model');
    expect(within(chosen).getByText('!')).toBeOnTheScreen();
    expect(within(chosen).queryByText('✓')).toBeNull();
  });

  it('saves the transcription URL, token, and model without echoing the token', async () => {
    const initial = makeSettings({ transcribeBackendMode: 'external' });
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Transcription'));

    const url = await screen.findByLabelText('Transcription API base URL');
    const token = screen.getByPlaceholderText('Paste the transcription token…');
    const model = screen.getByLabelText('Transcription model');
    fireEvent.changeText(url, 'https://api.example.test/v1');
    fireEvent.changeText(model, 'whisper-test');
    fireEvent(model, 'blur');
    fireEvent.changeText(token, 'transcription-token-fixture');
    fireEvent(token, 'blur');

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(2));
    const sent = Object.assign(
      {},
      ...updateVeritySettings.mock.calls.map(([patch]) => patch as Record<string, unknown>),
    ) as Record<string, unknown>;
    expect(sent).toEqual({
      transcribeBaseUrl: 'https://api.example.test/v1',
      transcribeModel: 'whisper-test',
      transcribeApiKey: 'transcription-token-fixture',
    });
    for (const [patch] of updateVeritySettings.mock.calls) {
      expectPatchClearsNothing(patch as Record<string, unknown>, initial);
    }
    await waitFor(() => expect(token).toHaveProp('value', ''));
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
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Transcription'));

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
    render(<ServicesSettingsScreen />);
    fireEvent.press(await screen.findByLabelText('Transcription'));

    const pill = await screen.findByLabelText('Local unavailable');
    expect(within(pill).getByText('!')).toBeOnTheScreen();
    expect(within(pill).queryByText('✓')).toBeNull();
    expect(screen.getByLabelText('Use local transcription')).toBeDisabled();
    expect(screen.getByText('Not available in this deployment.')).toBeOnTheScreen();
  });
});

describe('settings/services — tools', () => {
  it('leads to MCP connections rather than holding the form itself', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<ServicesSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('MCP connections'));
    expect(mockPush).toHaveBeenCalledWith('/settings/services/mcp');
    // The add form lives on its own route; an inline one here is what made the
    // old single screen unreadable.
    expect(screen.queryByLabelText('Remote HTTPS MCP URL')).toBeNull();
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<ServicesSettingsScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });
});
