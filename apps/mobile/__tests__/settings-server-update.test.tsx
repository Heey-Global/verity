// Server update: Verity replacing itself, plus the apply-settings banner every
// settings screen carries while a saved change has not reached running containers.
//
// The update panel talks to the thing being replaced, so requests are expected
// to fail mid-cutover; most of what follows is about not turning those expected
// failures into a screen that offers to start an update already running, or one
// that reports a stale result forever.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { VerityApiError } from '@verity/mobile';
import { Alert } from 'react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import ServerUpdateScreen from '../app/settings/server-update';
import ServerUpdateChannelScreen from '../app/settings/server-update-channel';
import { resetServerReleaseNotesCache } from '../lib/serverReleaseNotes';
import { resetVeritySettingsStore, saveVeritySettings } from '../lib/settingsStore';
import {
  makeClient,
  makeProject,
  makeSettings,
  mockCreateVerityClient,
  mockOpenURL,
  refocus,
  resetSettingsHarness,
} from './support/settingsHarness';

const SERVER_IMAGE = `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`;
const RELEASE = {
  version: '1.4.0',
  serverImage: SERVER_IMAGE,
  publishedAt: '2026-08-10T00:00:00.000Z',
};

// No test reaches GitHub: an unstubbed fetch fails, which the screen must
// treat as "no release notes" anyway.
const realFetch = globalThis.fetch;
const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset().mockRejectedValue(new Error('offline'));
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetServerReleaseNotesCache();
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('apply-settings banner', () => {
  const APPLY = 'Apply saved settings to running containers';

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
  it('stays hidden while nothing saved needs applying', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient('unlocked'));
    render(<ServerUpdateScreen />);

    await screen.findByText(/updates itself externally/);
    expect(screen.queryByLabelText(APPLY)).toBeNull();
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
    render(<ServerUpdateScreen />);

    await screen.findByText(/updates itself externally/);
    expect(screen.queryByLabelText(APPLY)).toBeNull();
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
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText(APPLY));

    expect(await screen.findByText('Applied to 2 running containers.')).toBeOnTheScreen();
    // A non-active container has no recreate to perform — the server 409s on it.
    expect(recreateProjectContainer.mock.calls.map(([id]) => id)).toEqual(['one', 'three']);
    expect(screen.queryByLabelText(APPLY)).toBeNull();
  });

  it('says there was nothing running rather than reporting a silent success', async () => {
    await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one', 'absent')]),
      recreateProjectContainer: jest.fn(),
    });
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText(APPLY));
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
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText(APPLY));

    expect(await screen.findByText('Not applied to acme/two.')).toBeOnTheScreen();
    expect(screen.getByLabelText(APPLY)).toBeOnTheScreen();
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
        <ServerUpdateScreen />
        <ServerUpdateScreen />
      </>,
    );

    const [first] = await screen.findAllByLabelText(APPLY);
    fireEvent.press(first!);
    await waitFor(() => expect(recreateProjectContainer).toHaveBeenCalledTimes(1));
    for (const button of screen.getAllByLabelText(APPLY)) expect(button).toBeDisabled();

    await act(async () => finish?.());
    expect(recreateProjectContainer).toHaveBeenCalledTimes(1);
  });

  // A finished run is kept so its outcome can be read; left in place, a later
  // save would show it as this change's result — "Not applied to ." beside a
  // Retry for a run that succeeded.
  it('asks again for a change saved after a clean run', async () => {
    const client = await saveIdentityChange({
      listProjects: jest.fn().mockResolvedValue([makeProject('one')]),
      recreateProjectContainer: jest.fn().mockResolvedValue(undefined),
    });
    render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(APPLY));
    await screen.findByText('Applied to 1 running container.');

    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'newer-bot' });
    });

    expect(screen.getByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.queryByText(/Not applied/)).toBeNull();
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
    render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(APPLY));
    await waitFor(() => expect(finish).toBeDefined());

    await act(async () => {
      await saveVeritySettings(client, { gitUserName: 'newer-bot' });
    });
    await act(async () => finish?.());

    expect(await screen.findByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.getByLabelText(APPLY)).toBeEnabled();
    expect(screen.queryByText(/Applied to/)).toBeNull();
  });

  // Re-pairing resets the store, but a run against the old server is still in
  // flight. Its progress describes containers the app no longer talks to, and
  // landing on the new server's banner would disable that server's Apply.
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
    render(<ServerUpdateScreen />);
    fireEvent.press(await screen.findByLabelText(APPLY));
    await waitFor(() => expect(pending).toHaveLength(1));

    act(() => resetVeritySettingsStore());
    await saveIdentityChange();
    await act(async () => pending[0]?.());

    expect(screen.queryByText(/Applying/)).toBeNull();
    expect(screen.getByText(/keep the old settings/)).toBeOnTheScreen();
    expect(screen.getByLabelText(APPLY)).toBeEnabled();
  });

  it('surfaces a failed project listing and stays retryable', async () => {
    await saveIdentityChange({
      listProjects: jest.fn().mockRejectedValue(new VerityApiError(503, 'store sealed')),
    });
    render(<ServerUpdateScreen />);

    fireEvent.press(await screen.findByLabelText(APPLY));
    expect(await screen.findByText('store sealed')).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByLabelText(APPLY)).toBeEnabled());
  });
});

describe('release notes', () => {
  const githubRelease = (version: string, body: string) => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/Heey-Global/verity/releases/tag/v${version}`,
    body: `## [${version}](https://github.com/Heey-Global/verity/compare) (2026-08-10)\n\n${body}`,
  });
  const RELEASES = [
    githubRelease(
      '1.4.0',
      '### Features\n\n* **mobile:** announce updates ([#1](https://x/1)) ([abc1234](https://x/c))',
    ),
    githubRelease(
      '1.3.0',
      '### Bug Fixes\n\n* **server:** keep sessions alive ([#2](https://x/2))',
    ),
    githubRelease('1.2.0', '### Features\n\n* already installed'),
  ];

  function renderAvailable(running: string | undefined) {
    const client = makeClient('unlocked', {
      getServerUpdates: jest
        .fn()
        .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
    });
    (client.getHealth as jest.Mock).mockResolvedValue({ status: 'ok', version: running });
    mockCreateVerityClient.mockReturnValue(client);
    render(<ServerUpdateScreen />);
  }

  it('lists what changed since the running version under the install button', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(RELEASES) });
    renderAvailable('1.2.0');

    expect(await screen.findByText("What's new")).toBeOnTheScreen();
    expect(screen.getByText('Announce updates')).toBeOnTheScreen();
    // 1.3.0 was skipped, and ships with this update too.
    expect(screen.getByText('Keep sessions alive')).toBeOnTheScreen();
    expect(screen.queryByText('Already installed')).toBeNull();

    fireEvent.press(screen.getByLabelText('Full release notes on GitHub'));
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://github.com/Heey-Global/verity/releases/tag/v1.4.0',
    );
  });

  // GitHub is a convenience here, not a dependency of updating: a rate limit or
  // an offline phone must leave the install exactly as it was.
  it('leaves the install alone when GitHub cannot be read', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    renderAvailable('1.2.0');

    expect(await screen.findByLabelText('Install 1.4.0')).toBeEnabled();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("What's new")).toBeNull());
  });
});

describe('settings/server-update', () => {
  it('keeps channel preferences off the installation screen', async () => {
    const client = makeClient('unlocked', {
      getServerUpdates: jest
        .fn()
        .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
      getServerUpdateChannel: jest.fn().mockResolvedValue('stable'),
    });
    mockCreateVerityClient.mockReturnValue(client);
    render(<ServerUpdateScreen />);
    await screen.findByLabelText('Install 1.4.0');
    expect(screen.queryByText('Update channel')).toBeNull();
    expect(client.getServerUpdateChannel).not.toHaveBeenCalled();
  });

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

describe('server update channel selection', () => {
  it('shows preferences without version, installation or release notes', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
        getServerUpdateChannel: jest.fn().mockResolvedValue('stable'),
      }),
    );
    render(<ServerUpdateChannelScreen />);
    await screen.findByText('Prereleases');
    expect(screen.queryByText('Version')).toBeNull();
    expect(screen.queryByText('Version 1.4.0 available')).toBeNull();
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
    expect(screen.queryByText("What's new")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('disables preferences while the server is installing an update', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest.fn().mockResolvedValue({
          state: 'available',
          release: RELEASE,
          operation: {
            updateId: 'update-1',
            state: 'preparing',
            phase: 'requested',
            step: 1,
            totalSteps: 14,
            generation: 1,
            previousDigest: SERVER_IMAGE,
            targetDigest: SERVER_IMAGE,
            failureCode: null,
            startedAt: '2026-08-10T00:00:00.000Z',
            updatedAt: '2026-08-10T00:00:00.000Z',
          },
        }),
        getServerUpdateChannel: jest.fn().mockResolvedValue('stable'),
      }),
    );
    render(<ServerUpdateChannelScreen />);
    await screen.findByText('Prereleases');
    expect(screen.getByRole('radio', { name: 'Prereleases' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Stable' })).toBeDisabled();
  });

  it('keeps channel choices disabled until a lost write and failed recovery read are reconciled', async () => {
    jest.useFakeTimers();
    try {
      const alert = jest.spyOn(Alert, 'alert');
      const getServerUpdates = jest
        .fn()
        .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null })
        .mockResolvedValue({ state: 'current', release: RELEASE, operation: null });
      mockCreateVerityClient.mockReturnValue(
        makeClient('unlocked', {
          getServerUpdates,
          getServerUpdateChannel: jest
            .fn()
            .mockResolvedValueOnce('stable')
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue('staging'),
          setServerUpdateChannel: jest.fn().mockRejectedValue(new Error('response lost')),
        }),
      );
      render(<ServerUpdateChannelScreen />);
      fireEvent.press(await screen.findByText('Prereleases'));
      await act(async () => {
        alert.mock.calls[0]![2]!.find((action) => action.text === 'Change channel')!.onPress!();
      });
      expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
      expect(
        await screen.findByText('The channel change is unconfirmed. Checking the server…'),
      ).toBeTruthy();
      expect(screen.getByRole('radio', { name: 'Stable' })).toBeDisabled();
      expect(getServerUpdates).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(2_000);
      });
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Prereleases' })).toBeChecked());
      expect(screen.queryByText('Verity is up to date')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('discards the previous release if the channel refresh fails and retries on focus', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    const getServerUpdates = jest
      .fn()
      .mockResolvedValueOnce({ state: 'available', release: RELEASE, operation: null })
      .mockRejectedValue(new Error('offline'));
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates,
        getServerUpdateChannel: jest
          .fn()
          .mockResolvedValueOnce('stable')
          .mockResolvedValue('staging'),
        setServerUpdateChannel: jest.fn().mockResolvedValue('staging'),
      }),
    );
    render(<ServerUpdateChannelScreen />);
    await screen.findByText('Prereleases');
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
    fireEvent.press(await screen.findByText('Prereleases'));
    await act(async () => {
      alert.mock.calls[0]![2]!.find((action) => action.text === 'Change channel')!.onPress!();
    });
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
    expect(
      await screen.findByText(
        'Checking the selected channel… Retrying if the server is unavailable.',
      ),
    ).toBeTruthy();
    getServerUpdates.mockResolvedValue({ state: 'current', release: RELEASE, operation: null });
    await act(async () => {
      refocus();
    });
    await waitFor(() =>
      expect(
        screen.queryByText('Checking the selected channel… Retrying if the server is unavailable.'),
      ).toBeNull(),
    );
  });

  it('disables channel choices while the selection is being saved', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    let finish!: (value: 'staging') => void;
    const saved = new Promise<'staging'>((resolve) => {
      finish = resolve;
    });
    const requestServerUpdate = jest.fn();
    mockCreateVerityClient.mockReturnValue(
      makeClient('unlocked', {
        getServerUpdates: jest
          .fn()
          .mockResolvedValue({ state: 'available', release: RELEASE, operation: null }),
        getServerUpdateChannel: jest.fn().mockResolvedValue('stable'),
        setServerUpdateChannel: jest.fn(() => saved),
        requestServerUpdate,
      }),
    );
    render(<ServerUpdateChannelScreen />);
    fireEvent.press(await screen.findByText('Prereleases'));
    await act(async () => {
      alert.mock.calls[0]![2]!.find((action) => action.text === 'Change channel')!.onPress!();
    });
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
    expect(requestServerUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Stable' })).toBeDisabled();
    await act(async () => {
      finish('staging');
    });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Prereleases' })).toBeEnabled());
    expect(screen.queryByLabelText('Install 1.4.0')).toBeNull();
  });

  it.each([false, true])(
    'requires confirmation and refreshes availability (lost response: %s)',
    async (lostResponse) => {
      const alert = jest.spyOn(Alert, 'alert');
      const getServerUpdates = jest
        .fn()
        .mockResolvedValue({ state: 'current', release: RELEASE, operation: null });
      const setServerUpdateChannel = lostResponse
        ? jest.fn().mockRejectedValue(new Error('response lost'))
        : jest.fn().mockResolvedValue('staging');
      mockCreateVerityClient.mockReturnValue(
        makeClient('unlocked', {
          getServerUpdates,
          getServerUpdateChannel: jest
            .fn()
            .mockResolvedValueOnce('stable')
            .mockResolvedValue('staging'),
          setServerUpdateChannel,
        }),
      );
      render(<ServerUpdateChannelScreen />);
      const prereleases = await screen.findByText('Prereleases');
      fireEvent.press(prereleases);
      expect(setServerUpdateChannel).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith(
        'Use prereleases?',
        expect.stringContaining('does not install an older version'),
        expect.any(Array),
      );
      const actions = alert.mock.calls[0]![2]!;
      await act(async () => {
        actions.find((action) => action.text === 'Change channel')!.onPress!();
      });
      expect(setServerUpdateChannel).toHaveBeenCalledWith('staging');
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Prereleases' })).toBeChecked());
      expect(screen.queryByText('Could not confirm the update channel. Try again.')).toBeNull();
      expect(getServerUpdates.mock.calls.length).toBeGreaterThan(1);
    },
  );
});
