// The Settings index: what is still unfinished, where the rest of it lives, and
// the two switches that stayed on the top level.
//
// The index owns no form. Its job is to route, so most of what is worth testing
// here is that every row and every checklist item reaches a screen that can act
// on it — a row that explains a problem and goes nowhere is the failure this
// suite is watching for.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<SettingsIndexScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });

  // Each row is the entry point to one of the sub-screens the settings surface
  // was split into. They are the only way to reach four of the five routes.
  it.each([
    ['GitHub', '/settings/github'],
    ['Connected services', '/settings/services'],
    ['Maintenance', '/settings/maintenance'],
    ['Knowledge model', '/settings/knowledge'],
    ['Change server address', '/onboarding/server-url?reconfigure=1'],
    ['Manage paired devices', '/devices'],
  ])('routes %s to %s', async (label, href) => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    fireEvent.press(await screen.findByLabelText(label));
    expect(mockPush).toHaveBeenCalledWith(href);
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

    await screen.findByLabelText('GitHub');
    expect(screen.queryByLabelText('Commit name')).toBeNull();
    expect(screen.queryByPlaceholderText('Paste the Doppler token…')).toBeNull();
    expect(screen.queryByLabelText('Reprovision running containers now')).toBeNull();
    expect(screen.queryByLabelText('Set master password')).toBeNull();
  });

  it('reports GitHub as needing setup while its credentials are incomplete', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        settings: makeSettings({ githubAppId: null, githubAppInstallationId: null }),
      }),
    );
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('GitHub');
    expect(screen.getByText('Needs setup')).toBeOnTheScreen();
    // Technical App/installation identifiers never appear in a summary row.
    expect(screen.queryByText('78901234')).toBeNull();
  });

  // The model every project's Wiki jobs run on is the reason anyone opens this
  // row, and reading it should not require tapping in — the complaint that put
  // the setting here was "which model is writing my Wiki, and where do I change
  // it".
  it('names the pinned Knowledge model on the row itself', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { settings: makeSettings({ knowledgeModel: 'claude-opus-4-8' }) }),
    );
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Knowledge model');
    expect(screen.getByText('Claude Opus 4.8')).toBeOnTheScreen();
  });

  // Unset is a halt, not a default: nothing maintains any Wiki until someone
  // picks a model, so the row has to read as an outstanding task rather than as
  // a working configuration.
  it('flags the Knowledge model as outstanding while none is pinned', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Knowledge model');
    expect(screen.getByText('Not set')).toBeOnTheScreen();
    expect(screen.getByText('Maintenance paused')).toBeOnTheScreen();
  });

  it('marks Connected services as locked while the store is sealed', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('sealed'));
    render(<SettingsIndexScreen />);

    expect(await screen.findByText('Locked')).toBeOnTheScreen();
  });

  // The header's update dot points at Settings because that is where an update
  // can be started — which is now one screen further in. Without this badge the
  // dot would lead to a screen that says nothing about the update it announced.
  it('carries a waiting server update through to the Maintenance row', async () => {
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

    expect(await screen.findByText('Update available')).toBeOnTheScreen();
  });

  it('does not badge Maintenance on a deployment Verity does not manage', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('Maintenance');
    expect(screen.queryByText('Update available')).toBeNull();
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
    await screen.findByLabelText('GitHub');

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
    expect(mockPush).toHaveBeenCalledWith('/settings/services');
  });

  it('drops the checklist entirely once nothing is outstanding', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('GitHub');
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

    await screen.findByLabelText('GitHub');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // Repeating the parameter makes the router hand over an array, not a string.
  it('stays put for a repeated agentLogin parameter', async () => {
    setSearchParams({ agentLogin: ['codex', 'claude'] });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<SettingsIndexScreen />);

    await screen.findByLabelText('GitHub');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
