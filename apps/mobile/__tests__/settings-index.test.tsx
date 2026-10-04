// The Settings index: what is still unfinished, where the rest of it lives, and
// the two switches that stayed on the top level.
//
// The index owns no form. Its job is to route, so most of what is worth testing
// here is that every row and every checklist item reaches a screen that can act
// on it — a row that explains a problem and goes nowhere is the failure this
// suite is watching for.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { settingsChecklist, settingsChecklistHeadline } from '@verity/mobile';
import { Alert } from 'react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/automaticUpdates', () =>
  require('./support/settingsHarness').automaticUpdatesMock(),
);

import SettingsIndexScreen from '../app/settings/index';
import {
  VERITY_BASE_URL,
  expectPatchClearsNothing,
  makeClient,
  makeSettings,
  mockCheckForAppUpdate,
  mockCreateVerityClient,
  mockPush,
  mockReplace,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings index — destinations', () => {
  it('keeps destinations usable while settings are pending', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getVeritySettings: jest.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    );
    render(<SettingsIndexScreen />);
    fireEvent.press(screen.getByLabelText('Manage paired devices'));
    expect(mockPush).toHaveBeenCalledWith('/devices');
    expect(screen.getByLabelText('Advanced mode')).toBeDisabled();
    expect(screen.queryByText('Needs setup')).toBeNull();
    await act(async () => undefined);
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<SettingsIndexScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });

  // Each destination must still reach its settings or recovery screen.
  it.each([
    ['Remote access', '/settings/remote-access'],
    ['Meeting transcription', '/settings/transcription'],
    ['Connections', '/settings/services'],
    ['Server update', '/settings/server-update'],
    ['Change server address', '/onboarding/server-url?reconfigure=1'],
    ['Manage paired devices', '/devices'],
  ])('routes %s to %s', async (label, href) => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText(label));
    expect(mockPush).toHaveBeenCalledWith(href);
  });

  it('keeps update channel preferences inside server update', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);
    await screen.findByLabelText('Server update');
    expect(screen.queryByLabelText('Update channel')).toBeNull();
  });

  it('shows the configured server address without tapping in', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Change server address');
    expect(screen.getByText(VERITY_BASE_URL)).toBeOnTheScreen();
  });

  // The index is a list of destinations. Anything with a form of its own moved
  // one screen deeper, and pulling one back up here is how this screen starts
  // needing to be scrolled past the fold to find what needs attention.
  it('keeps every editable field off the index', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Connections');
    expect(screen.queryByLabelText('Commit name')).toBeNull();
    expect(screen.queryByPlaceholderText('Paste the Doppler token…')).toBeNull();
    expect(screen.queryByLabelText('Apply saved settings to running containers')).toBeNull();
    expect(screen.queryByLabelText('Set master password')).toBeNull();
  });

  it('reports GitHub as needing setup while its credentials are incomplete', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({ githubAppId: null, githubAppInstallationId: null }),
      }),
    );
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Connections');
    expect(screen.queryByText('Needs setup')).toBeNull();
    // Technical App/installation identifiers never appear in a summary row.
    expect(screen.queryByText('78901234')).toBeNull();
  });

  it.each(['unlocked', 'sealed'] as const)(
    'omits the redundant secret-store navigation row when %s',
    async (status) => {
      mockCreateVerityClient.mockReturnValue(makeClient(status));
      render(<SettingsIndexScreen />);

      await screen.findByLabelText('Connections');
      expect(screen.queryByLabelText('Secret store')).toBeNull();
    },
  );

  // Settings is the way back to an update once the overview banner has been
  // scrolled past or the push dismissed, so the row names the waiting version.
  it('names a waiting server update on its row', async () => {
    const serverImage = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: { version: '1.4.0', serverImage, publishedAt: '2026-08-10T00:00:00.000Z' },
          operation: null,
        }),
      }),
    );
    render(<SettingsIndexScreen />);

    expect(await screen.findByText('Version 1.4.0 available')).toBeOnTheScreen();
  });

  it('does not badge Server update on a deployment Verity does not manage', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Server update');
    expect(screen.queryByText(/available$/)).toBeNull();
  });
});

describe('settings index — setup checklist', () => {
  // A sealed store and a half-connected GitHub App: two outstanding steps, so
  // the header has something to say. The expectations below are computed from
  // `settingsChecklist` rather than written out, so a step added or reworded in
  // @verity/mobile is covered here without this file being touched.
  const SETTINGS = makeSettings({ githubAppId: null, githubAppInstallationId: null });
  const CHECKLIST = settingsChecklist({
    settings: SETTINGS,
    secretStatus: 'sealed',
    failed: false,
  });

  function renderWithOutstandingSteps() {
    mockCreateVerityClient.mockReturnValue(makeClient('sealed', { settings: SETTINGS }));
    render(<SettingsIndexScreen />);
  }

  it('heads the screen with the count of outstanding steps', async () => {
    renderWithOutstandingSteps();
    expect(await screen.findByText(settingsChecklistHeadline(CHECKLIST))).toBeOnTheScreen();
  });

  it('sends every outstanding step to a screen that can fix it', async () => {
    renderWithOutstandingSteps();
    await screen.findByLabelText('Connections');

    const items = CHECKLIST.kind === 'ready' ? CHECKLIST.items : [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      mockPush.mockClear();
      fireEvent.press(screen.getByLabelText(`${item.title}. ${item.done ? 'Done' : item.detail}`));
      const [href] = mockPush.mock.calls.at(-1) ?? [];
      // A destination deeper than the index itself: the step is fixed on one of
      // the sub-screens, never here.
      expect(href).toMatch(/^\/settings\/.+/);
    }
  });

  it('sends the secret-store step to the screen holding the unlock form', async () => {
    renderWithOutstandingSteps();
    const secretStore = (CHECKLIST.kind === 'ready' ? CHECKLIST.items : []).find(
      (item) => item.id === 'secretStore',
    );
    expect(secretStore).toBeDefined();

    fireEvent.press(await screen.findByLabelText(`${secretStore!.title}. ${secretStore!.detail}`));
    expect(mockPush).toHaveBeenCalledWith('/settings/secret-store');
  });

  it('drops the checklist entirely once nothing is outstanding', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Connections');
    // "All set" is a headline with nothing to act on; the screen shows the rows
    // instead of a panel of ticks.
    expect(screen.queryByText('All set')).toBeNull();
    expect(screen.queryByText(/^Setup · /)).toBeNull();
  });

  // A checklist computed from a failed fetch under-reports: the steps it cannot
  // see read as done. So a failure shows the banner and no count at all.
  it('claims no count when the settings fetch failed', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('sealed', {
        getVeritySettings: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    );
    render(<SettingsIndexScreen />);

    expect(await screen.findByText('Retry')).toBeOnTheScreen();
    expect(screen.queryByText(settingsChecklistHeadline(CHECKLIST))).toBeNull();
    expect(screen.queryByText(/^Setup · /)).toBeNull();
    expect(screen.queryByText('All set')).toBeNull();
  });
});

describe('settings index — app-level controls', () => {
  it('saves the advanced-mode switch on its own', async () => {
    const initial = makeSettings();
    const updateVeritySettings = jest
      .fn()
      .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch }));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText('Advanced mode'));

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    const patch = updateVeritySettings.mock.calls[0]?.[0] as Record<string, unknown>;
    // Exactly the one key: the index renders no other field, so anything else in
    // this patch is a value the operator never saw being written.
    expect(Object.keys(patch)).toEqual(['advancedModeEnabled']);
    expect(patch.advancedModeEnabled).toBe(true);
    expectPatchClearsNothing(patch, initial);
  });

  it('accepts only one advanced-mode change while its save is pending', async () => {
    let resolveSave!: (value: ReturnType<typeof makeSettings>) => void;
    const pending = new Promise<ReturnType<typeof makeSettings>>((resolve) => {
      resolveSave = resolve;
    });
    const updateVeritySettings = jest.fn().mockReturnValue(pending);
    const initial = makeSettings();
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: initial, updateVeritySettings }),
    );
    render(<SettingsIndexScreen />);

    const toggle = await screen.findByLabelText('Advanced mode');
    fireEvent.press(toggle);
    fireEvent.press(toggle);

    await waitFor(() => expect(updateVeritySettings).toHaveBeenCalledTimes(1));
    expect(toggle).toBeDisabled();
    resolveSave({ ...initial, advancedModeEnabled: true });
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it('checks EAS Update when the version is long-pressed', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    mockCheckForAppUpdate.mockResolvedValue('current');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<SettingsIndexScreen />);

    const version = await screen.findByLabelText(/^Version /);
    const releaseVersion = String(version.props.accessibilityLabel).replace('Version ', '');
    fireEvent(version, 'longPress');

    await waitFor(() => expect(mockCheckForAppUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Verity is up to date', releaseVersion));
    // Only the running app version is in the footer; server diagnostics do not
    // compete with the release number.
    expect(screen.queryByText(/Server 9\.9\.9/)).toBeNull();
  });
});

describe('settings index — legacy deep links', () => {
  // `/settings?agentLogin=…` opened the AI-login panel back when Settings was one
  // screen. An older notification or an un-updated client still sends it, and it
  // has to arrive at the panel rather than at a screen that ignores it.
  it.each(['claude', 'codex'])(
    'forwards ?agentLogin=%s to Connected services',
    async (provider) => {
      setSearchParams({ agentLogin: provider });
      mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
      render(<SettingsIndexScreen />);

      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith(`/settings/services?agentLogin=${provider}`),
      );
    },
  );

  it('stays put for an agentLogin the app does not know', async () => {
    setSearchParams({ agentLogin: 'gemini' });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Connections');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // Repeating the parameter makes the router hand over an array, not a string.
  it('stays put for a repeated agentLogin parameter', async () => {
    setSearchParams({ agentLogin: ['codex', 'claude'] });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Connections');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
