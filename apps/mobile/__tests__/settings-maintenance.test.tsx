// Maintenance: replacing the Verity server, and pushing saved settings into
// project containers that are already running.
//
// The update panel talks to the thing being replaced, so requests are expected
// to fail mid-cutover; most of what follows is about not turning those expected
// failures into a screen that offers to start an update already running, or one
// that reports a stale result forever.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError } from '@verity/mobile';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import MaintenanceSettingsScreen from '../app/settings/maintenance';
import { saveVeritySettings } from '../lib/settingsStore';
import {
  makeClient,
  makeProject,
  makeSettings,
  mockCreateVerityClient,
  refocus,
  resetSettingsHarness,
} from './support/settingsHarness';

const SERVER_IMAGE = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const RELEASE = {
  version: '1.4.0',
  serverImage: SERVER_IMAGE,
  publishedAt: '2026-08-10T00:00:00.000Z',
};

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('settings/maintenance — project containers', () => {
  it('recreates every active container and skips the rest', async () => {
    const listProjects = jest
      .fn()
      .mockResolvedValue([makeProject('one'), makeProject('two', 'absent'), makeProject('three')]);
    const recreateProjectContainer = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', { listProjects, recreateProjectContainer }),
    );
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    fireEvent.press(await screen.findByLabelText('Reprovision running containers now'));

    await waitFor(() => expect(screen.getByText(/Reprovisioned 2\/2/)).toBeOnTheScreen());
    // A non-active container has no recreate to perform — the server 409s on it.
    expect(recreateProjectContainer.mock.calls.map(([id]) => id)).toEqual(['one', 'three']);
  });

  it('says there was nothing running rather than reporting a silent success', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockResolvedValue([makeProject('one', 'absent')]),
        recreateProjectContainer: jest.fn(),
      }),
    );
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    fireEvent.press(await screen.findByLabelText('Reprovision running containers now'));
    expect(await screen.findByText('No running containers to reprovision.')).toBeOnTheScreen();
  });

  it('names the containers that did not come back', async () => {
    const recreateProjectContainer = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('daemon refused'));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockResolvedValue([makeProject('one'), makeProject('two')]),
        recreateProjectContainer,
      }),
    );
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    fireEvent.press(await screen.findByLabelText('Reprovision running containers now'));
    // One failure does not abort the run: the second container is still tried.
    expect(await screen.findByText(/failed: acme\/two/)).toBeOnTheScreen();
  });

  // The prompt is the only thing telling the operator their saved change has not
  // reached anything yet. It may only be cleared by a run that actually got
  // every container back — a failed one is still running the old settings.
  it('keeps the pending prompt until every container has been recreated', async () => {
    const initial = makeSettings();
    const client = makeClient('unlocked', {
      settings: initial,
      updateVeritySettings: jest
        .fn()
        .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch })),
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockRejectedValueOnce(new Error('daemon refused')),
    });
    mockCreateVerityClient.mockReturnValue(client);
    // A save made elsewhere in Settings — the shared store is what carries it to
    // this screen after the screen that made it was popped.
    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'new-bot' });
    });
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    expect(
      await screen.findByText('Settings changed since these containers started.'),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Reprovision running containers now'));
    await screen.findByText(/failed: acme\/one/);
    expect(screen.getByText('Settings changed since these containers started.')).toBeOnTheScreen();
  });

  it('clears the pending prompt after a clean run', async () => {
    const initial = makeSettings();
    const client = makeClient('unlocked', {
      settings: initial,
      updateVeritySettings: jest
        .fn()
        .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch })),
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateVerityClient.mockReturnValue(client);
    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'new-bot' });
    });
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    fireEvent.press(await screen.findByLabelText('Reprovision running containers now'));

    await waitFor(() =>
      expect(screen.queryByText('Settings changed since these containers started.')).toBeNull(),
    );
  });

  it('surfaces a failed project listing instead of an idle button', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockRejectedValue(new VerityApiError(503, 'store sealed')),
      }),
    );
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));

    fireEvent.press(await screen.findByLabelText('Reprovision running containers now'));
    expect(await screen.findByText('store sealed')).toBeOnTheScreen();
    // Back to idle, so the run can be retried once the store is open.
    await waitFor(() =>
      expect(screen.getByLabelText('Reprovision running containers now')).toBeEnabled(),
    );
  });

  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<MaintenanceSettingsScreen />);
    if (screen.queryByLabelText('Running containers'))
      fireEvent.press(screen.getByLabelText('Running containers'));
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });
});

describe('settings/maintenance — server updates', () => {
  it('hides the update panel on a deployment Verity does not manage', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<MaintenanceSettingsScreen />);

    // The panel is gone, but the screen is not: reprovisioning is available on
    // every deployment.
    fireEvent.press(await screen.findByLabelText('Running containers'));
    expect(await screen.findByLabelText('Reprovision running containers now')).toBeOnTheScreen();
    expect(screen.queryByText('Updates are managed elsewhere')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  it('refreshes a transiently unreachable release channel when the screen regains focus', async () => {
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({
        state: 'unreachable',
        reason: 'release channel manifest request failed: HTTP 404',
        lastGood: null,
        operation: null,
      })
      .mockResolvedValue({ state: 'available', release: RELEASE, operation: null });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { getServerUpdates }));
    render(<MaintenanceSettingsScreen />);

    expect(await screen.findByText('Update check unavailable')).toBeOnTheScreen();
    await act(async () => refocus());

    expect(await screen.findByText('Version 1.4.0 available')).toBeOnTheScreen();
  });

  it('does not let an older update check overwrite a newer focused result', async () => {
    let finishFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const getServerUpdates = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null });
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked', { getServerUpdates }));
    render(<MaintenanceSettingsScreen />);

    await waitFor(() => expect(getServerUpdates).toHaveBeenCalledTimes(1));
    await act(async () => refocus());
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
    const requestServerUpdate = jest.fn().mockResolvedValue({
      updateId: 'update-1',
      state: 'preparing',
      phase: 'requested',
      step: 1,
      totalSteps: 14,
      generation: 3,
      previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
      targetDigest: SERVER_IMAGE,
      failureCode: null,
      startedAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
        requestServerUpdate,
      }),
    );
    render(<MaintenanceSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Server update'));
    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    await waitFor(() => expect(requestServerUpdate).toHaveBeenCalledTimes(1));
    expect(requestServerUpdate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ targetDigest: SERVER_IMAGE }),
    );
    // Once accepted, the panel reports progress instead of offering the action
    // again — a second press would race the operation already running.
    expect(await screen.findByText('Step 1 of 14')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  // A failed attempt stays the current journal entry, so retrying under the key
  // of the first attempt would be answered with that same failure forever.
  it('retries a failed update under a key that starts a new attempt', async () => {
    const requestServerUpdate = jest.fn().mockRejectedValue(new VerityApiError(503, 'unavailable'));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: RELEASE,
          operation: {
            updateId: 'update-1',
            state: 'failed',
            phase: 'failed',
            step: 2,
            totalSteps: 14,
            generation: 3,
            previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
            targetDigest: SERVER_IMAGE,
            failureCode: 'pulling-failed',
            startedAt: '2026-08-10T00:00:00.000Z',
            updatedAt: '2026-08-10T00:00:05.000Z',
          },
        }),
        requestServerUpdate,
      }),
    );
    render(<MaintenanceSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Server update'));
    expect(await screen.findByText('The new version could not be downloaded.')).toBeOnTheScreen();
    fireEvent.press(await screen.findByLabelText('Try again'));

    await waitFor(() => expect(requestServerUpdate).toHaveBeenCalledTimes(1));
    const sent: unknown = requestServerUpdate.mock.calls[0]?.[0];
    expect(sent).toEqual(
      expect.objectContaining({ targetDigest: SERVER_IMAGE, idempotencyKey: expect.any(String) }),
    );
    expect((sent as { idempotencyKey: string }).idempotencyKey).toContain('g3');
  });

  // The response to an accepted request is exactly what cutover drops. Treating
  // that as a failed start would leave the panel idle, and re-offering Install
  // while the server is already replacing itself.
  it('picks up an update whose acceptance response was lost', async () => {
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null })
      .mockResolvedValue({
        state: 'available',
        release: RELEASE,
        operation: {
          updateId: 'update-1',
          state: 'preparing',
          phase: 'pulling',
          step: 2,
          totalSteps: 14,
          generation: 1,
          previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
          targetDigest: SERVER_IMAGE,
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
    render(<MaintenanceSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Server update'));
    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(await screen.findByText('Step 2 of 14')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  it('explains a rejected update instead of leaving the button silent', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
        requestServerUpdate: jest
          .fn()
          .mockRejectedValue(new VerityApiError(403, 'updates require a paired device')),
      }),
    );
    render(<MaintenanceSettingsScreen />);

    fireEvent.press(await screen.findByLabelText('Server update'));
    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(
      await screen.findByText('Set a master password before updating Verity.'),
    ).toBeOnTheScreen();
  });
});
