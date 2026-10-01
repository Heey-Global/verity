// Server update: Verity replacing itself, the recreate banner every other
// settings screen carries while a saved change has not reached running
// containers, and the standing recreate entry on the Server update screen.
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

import GitHubSettingsScreen from '../app/settings/github';
import ServerUpdateScreen from '../app/settings/server-update';
import { RECREATE_LABEL as RECREATE } from '../components/settings/RecreatePendingBanner';
import { resetVeritySettingsStore, saveVeritySettings } from '../lib/settingsStore';
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

describe('recreate banner after a save', () => {
  /** A container-affecting save, made on some other settings screen. */
  async function saveIdentityChange(overrides: Parameters<typeof makeClient>[1] = {}) {
    const initial = makeSettings();
    const client = makeClient('unlocked', {
      settings: initial,
      updateVeritySettings: jest
        .fn()
        .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch })),
      ...overrides,
    });
    mockCreateVerityClient.mockReturnValue(client);
    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'new-bot' });
    });
    return client;
  }

  // The banner replaced a permanent Maintenance row; showing it with nothing to
  // apply would just be that row again, in a louder place.
  it('stays hidden while nothing saved needs recreating', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<GitHubSettingsScreen />);
    await act(async () => undefined);
    expect(screen.queryByLabelText(RECREATE)).toBeNull();
  });

  it('does not offer a reprovision for a change only this app reads', async () => {
    const initial = makeSettings();
    const client = makeClient('unlocked', {
      settings: initial,
      updateVeritySettings: jest
        .fn()
        .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch })),
    });
    mockCreateVerityClient.mockReturnValue(client);
    await act(async () => {
      await saveVeritySettings(client, { advancedModeEnabled: true });
    });
    render(<GitHubSettingsScreen />);
    await act(async () => undefined);
    expect(screen.queryByLabelText(RECREATE)).toBeNull();
  });

  it('recreates every active container and skips the rest', async () => {
    const recreateProjectContainer = jest.fn().mockResolvedValue(undefined);
    await saveIdentityChange({
      listProjects: jest
        .fn()
        .mockResolvedValue([
          makeProject('one'),
          makeProject('two', 'absent'),
          makeProject('three'),
        ]),
      recreateProjectContainer,
    });
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText(RECREATE));

    expect(await screen.findByText('Recreated 2 running containers.')).toBeOnTheScreen();
    // A non-active container has no recreate to perform — the server 409s on it.
    expect(recreateProjectContainer.mock.calls.map(([id]) => id)).toEqual(['one', 'three']);
    expect(screen.queryByLabelText(RECREATE)).toBeNull();
  });

  it('says there was nothing running rather than reporting a silent success', async () => {
    await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one', 'absent')]),
      recreateProjectContainer: jest.fn(),
    });
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText(RECREATE));
    expect(await screen.findByText(/No running containers/)).toBeOnTheScreen();
  });

  // A container that failed to come back still runs the old settings.
  it('keeps the prompt, naming what failed, until every container is recreated', async () => {
    await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one'), makeProject('two')]),
      recreateProjectContainer: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('daemon refused')),
    });
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText(RECREATE));

    expect(await screen.findByText('Could not recreate acme/two.')).toBeOnTheScreen();
    expect(screen.getByLabelText(RECREATE)).toBeOnTheScreen();
    expect(screen.getByText('Retry')).toBeOnTheScreen();
  });

  // Every settings screen mounts this banner and the ones behind stay mounted.
  // A run that only one of them knew about would leave the other's button live,
  // and a second tap would recreate each container twice at once.
  it('does not start a second run from another mounted screen', async () => {
    let finish: (() => void) | undefined;
    const recreateProjectContainer = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer,
    });
    render(
      <>
        <GitHubSettingsScreen />
        <ServerUpdateScreen />
      </>,
    );

    const [first] = await screen.findAllByLabelText(RECREATE);
    fireEvent.press(first!);
    await waitFor(() => expect(recreateProjectContainer).toHaveBeenCalledTimes(1));
    for (const button of screen.getAllByLabelText(RECREATE)) expect(button).toBeDisabled();

    await act(async () => finish?.());
    expect(recreateProjectContainer).toHaveBeenCalledTimes(1);
  });

  // A finished run is kept so its outcome can be read; left in place, a later
  // save would show it as this change's result — "Could not recreate ." beside a
  // Retry for a run that succeeded.
  it('asks again for a change saved after a clean run', async () => {
    const client = await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockResolvedValue(undefined),
    });
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await screen.findByText('Recreated 1 running container.');

    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'newer-bot' });
    });

    expect(screen.getByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.queryByText(/Could not recreate/)).toBeNull();
  });

  // Containers recreated before the save came back with the old settings, so
  // clearing the prompt at the end of the run would strand that change.
  it('keeps asking for a change saved while a run was underway', async () => {
    let finish: (() => void) | undefined;
    const client = await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await waitFor(() => expect(finish).toBeDefined());

    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'newer-bot' });
    });
    await act(async () => finish?.());

    expect(await screen.findByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.getByLabelText(RECREATE)).toBeEnabled();
    expect(screen.queryByText(/Recreated /)).toBeNull();
  });

  // The save makes the run's success moot, but not its failure: dropping it
  // would leave a broken container unnamed behind the generic prompt.
  it('still names a failure from a run a save overtook', async () => {
    let fail: ((error: Error) => void) | undefined;
    const client = await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      ),
    });
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await waitFor(() => expect(fail).toBeDefined());

    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'newer-bot' });
    });
    await act(async () => fail?.(new Error('boom')));

    expect(await screen.findByText('Could not recreate acme/one.')).toBeOnTheScreen();
    expect(screen.getByLabelText(RECREATE)).toBeEnabled();
  });

  // Re-pairing resets the store, but a run against the old server is still in
  // flight. Its progress describes containers the app no longer talks to, and
  // landing on the new server's banner would disable its Recreate.
  it('keeps a run against the previous server off the new one', async () => {
    const pending: (() => void)[] = [];
    await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one'), makeProject('two')]),
      recreateProjectContainer: jest.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            pending.push(resolve);
          }),
      ),
    });
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await waitFor(() => expect(pending).toHaveLength(1));

    act(() => resetVeritySettingsStore());
    await saveIdentityChange();
    await act(async () => pending[0]?.());

    expect(screen.queryByText(/Recreating/)).toBeNull();
    expect(screen.getByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.getByLabelText(RECREATE)).toBeEnabled();
  });

  it('surfaces a failed project listing and stays retryable', async () => {
    await saveIdentityChange({
      listProjects: jest.fn().mockRejectedValue(new VerityApiError(503, 'store sealed')),
    });
    render(<GitHubSettingsScreen />);

    fireEvent.press(await screen.findByLabelText(RECREATE));
    expect(await screen.findByText('store sealed')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByLabelText(RECREATE)).toBeEnabled());
  });
});

// The banner only knows about saves this app made since it started. A change
// saved before a restart, or from another device, needs a way in that does not
// depend on that — short of recreating each project by hand.
describe('standing recreate entry', () => {
  it('is offered on the Server update screen with nothing pending', async () => {
    const recreateProjectContainer = jest.fn().mockResolvedValue(undefined);
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest
          .fn()
          .mockResolvedValue([makeProject('one'), makeProject('two', 'absent')]),
        recreateProjectContainer,
      }),
    );
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText(RECREATE));

    expect(await screen.findByText('Recreated 1 running container.')).toBeOnTheScreen();
    expect(recreateProjectContainer.mock.calls.map(([id]) => id)).toEqual(['one']);
  });

  it('does not leave its result behind as a banner on the next screen', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
        recreateProjectContainer: jest.fn().mockResolvedValue(undefined),
      }),
    );
    const view = render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await screen.findByText('Recreated 1 running container.');

    view.unmount();
    render(<GitHubSettingsScreen />);
    await act(async () => undefined);

    expect(screen.queryByText(/Recreated/)).toBeNull();
  });

  it('keeps a failure from there in view on the next screen', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
        recreateProjectContainer: jest.fn().mockRejectedValue(new Error('boom')),
      }),
    );
    const view = render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await screen.findByText('Could not recreate acme/one.');

    view.unmount();
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText('Could not recreate acme/one.')).toBeOnTheScreen();

    // Nothing saved is waiting on it, so a container that keeps failing must
    // not pin the line to every settings screen for the rest of the session.
    fireEvent.press(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText(/Could not recreate/)).toBeNull();
  });

  it('reports a run still going when the operator left', async () => {
    let finish: (() => void) | undefined;
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        listProjects: jest.fn().mockResolvedValue([makeProject('one'), makeProject('two')]),
        recreateProjectContainer: jest.fn().mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
      }),
    );
    const view = render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(RECREATE));
    await waitFor(() => expect(finish).toBeDefined());

    view.unmount();
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText(/Recreating running containers/)).toBeOnTheScreen();
    await act(async () => finish?.());
    await act(async () => finish?.());
    expect(await screen.findByText('Recreated 2 running containers.')).toBeOnTheScreen();
  });

  // The banner would offer the same run a second time on the same screen.
  it('replaces the banner there rather than sitting next to it', async () => {
    const initial = makeSettings();
    const client = makeClient('unlocked', {
      settings: initial,
      updateVeritySettings: jest
        .fn()
        .mockImplementation((patch) => Promise.resolve({ ...initial, ...patch })),
    });
    mockCreateVerityClient.mockReturnValue(client);
    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'new-bot' });
    });
    render(<ServerUpdateScreen />);

    expect(await screen.findByText(/have not reached the running containers/)).toBeOnTheScreen();
    expect(screen.getAllByLabelText(RECREATE)).toHaveLength(1);
    expect(screen.queryByText(/keep the old settings/)).toBeNull();
  });
});

describe('settings/server-update', () => {
  it('renders a not-connected message when no server URL is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<ServerUpdateScreen />);
    expect(screen.getByText('Not connected')).toBeOnTheScreen();
  });

  // The screen is reachable from the Settings index on every deployment, so an
  // unmanaged one must say why there is nothing to install rather than go blank.
  it('explains a deployment Verity does not manage instead of offering an install', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<ServerUpdateScreen />);

    expect(await screen.findByText(/updates itself externally/)).toBeOnTheScreen();
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
    render(<ServerUpdateScreen />);

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
    render(<ServerUpdateScreen />);

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
    render(<ServerUpdateScreen />);

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
    render(<ServerUpdateScreen />);

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
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(await screen.findByText('Step 2 of 14')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  // The reported failure: the update ran to completion while the request was
  // in flight, so the new server reports "current" and refuses a repeat with a
  // 409. Keeping the stale "available" panel then offered an install already
  // done and called it a failed start.
  it('reports an update that already went through instead of a failed start', async () => {
    const completed = {
      state: 'current',
      release: RELEASE,
      operation: {
        updateId: 'update-1',
        state: 'completed',
        phase: 'completed',
        step: 14,
        totalSteps: 14,
        generation: 1,
        previousDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
        targetDigest: SERVER_IMAGE,
        failureCode: null,
        startedAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:01:00.000Z',
      },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null })
          .mockResolvedValue(completed),
        requestServerUpdate: jest
          .fn()
          .mockRejectedValue(new VerityApiError(409, 'no update is available (current)')),
      }),
    );
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(await screen.findByText('Verity is up to date')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  // Mid-cutover neither the request nor the follow-up check is answered. That is
  // an unknown outcome, not a failure: the panel has to keep asking until the
  // new server is up instead of freezing on an error and a stale Install button.
  it('keeps asking when Verity goes silent after an install request', async () => {
    jest.useFakeTimers();
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null })
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ state: 'current', release: RELEASE, operation: null });
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates,
        requestServerUpdate: jest.fn().mockRejectedValue(new Error('network')),
      }),
    );
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));
    expect(await screen.findByText('Starting…')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();

    await act(() => jest.advanceTimersByTimeAsync(4_000));

    expect(await screen.findByText('Verity is up to date')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    jest.useRealTimers();
  });

  // The Server gives up on the Updater after its own timeout and answers 503,
  // while the Updater goes on to journal and run the update. A status read in
  // that window still shows the previous operation; concluding "did not start"
  // from it is how the first tap reported failure for an update that ran.
  it('waits for an update the Updater accepted after the server gave up on it', async () => {
    jest.useFakeTimers();
    const idle = { state: 'available', release: RELEASE, operation: null };
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(idle)
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
        requestServerUpdate: jest
          .fn()
          .mockRejectedValue(new VerityApiError(503, 'updater is unavailable')),
      }),
    );
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));
    await act(() => jest.advanceTimersByTimeAsync(2_000));

    expect(await screen.findByText('Step 2 of 14')).toBeOnTheScreen();
    expect(screen.queryByText('Could not start the update.')).toBeNull();
    jest.useRealTimers();
  });

  it('says the update did not start once Verity keeps offering the same install', async () => {
    jest.useFakeTimers();
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
        requestServerUpdate: jest.fn().mockRejectedValue(new VerityApiError(503, 'unavailable')),
      }),
    );
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));
    await act(() => jest.advanceTimersByTimeAsync(10_000));
    expect(screen.queryByText('Could not start the update.')).toBeNull();

    await act(() => jest.advanceTimersByTimeAsync(14_000));
    expect(await screen.findByText('Could not start the update.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Install 1.4.0')).toBeOnTheScreen();
    jest.useRealTimers();
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
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText('Install 1.4.0'));

    expect(
      await screen.findByText('Set a master password before updating Verity.'),
    ).toBeOnTheScreen();
  });
});
