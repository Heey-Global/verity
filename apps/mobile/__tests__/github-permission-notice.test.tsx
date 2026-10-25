// A GitHub App permission the operator still has to grant in GitHub.
//
// The failures worth guarding are the quiet ones: a missing grant that no
// overview shows, so CI checks stay incomplete without a hint; an indicator
// that survives the grant on a screen the recheck did not run on; and a
// failed check rendered as "Action needed", sending the operator to change
// GitHub settings that are already right.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('react-native/Libraries/Linking/Linking', () =>
  require('./support/settingsHarness').linkingMock(),
);
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());
jest.mock('../lib/automaticUpdates', () =>
  require('./support/settingsHarness').automaticUpdatesMock(),
);

import GitHubSettingsScreen from '../app/settings/github';
import SettingsIndexScreen from '../app/settings/index';
import ConnectionsScreen from '../app/settings/services/index';
import {
  makeClient,
  mockCreateVerityClient,
  mockOpenURL,
  resetSettingsHarness,
} from './support/settingsHarness';

const APP_URL = 'https://github.com/settings/apps/verity/permissions';
const missing = {
  ok: true,
  commitStatusPermission: { state: 'app_update_required', url: APP_URL },
};
const ready = { ok: true, commitStatusPermission: { state: 'ready' } };

function useClient(validateGithubApp: jest.Mock) {
  const client = makeClient('unlocked', { validateGithubApp });
  mockCreateVerityClient.mockReturnValue(client);
  return client;
}

afterEach(() => {
  resetSettingsHarness();
  jest.restoreAllMocks();
});

describe('GitHub settings — action needed', () => {
  it('places the card below the settings, opens GitHub, and clears after the grant', async () => {
    const validateGithubApp = jest.fn().mockResolvedValueOnce(missing).mockResolvedValue(ready);
    useClient(validateGithubApp);
    render(<GitHubSettingsScreen />);

    expect(await screen.findByText('Allow reading CI statuses')).toBeOnTheScreen();
    expect(screen.getByText('Connected · 1 action needed')).toBeOnTheScreen();
    expect(screen.getByText(/Read-only/)).toBeOnTheScreen();
    // Below the Commits group: it is a step taken in GitHub, not a field here.
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('Signing')).toBeGreaterThanOrEqual(0);
    expect(tree.indexOf('Allow reading CI statuses')).toBeGreaterThan(tree.indexOf('Signing'));

    expect(screen.queryByText(/Commit statuses to Read-only/)).toBeNull();
    fireEvent.press(screen.getByText('Show steps'));
    expect(screen.getByText(/Commit statuses to Read-only/)).toBeOnTheScreen();

    fireEvent.press(screen.getByText('Open GitHub'));
    expect(mockOpenURL).toHaveBeenCalledWith(APP_URL);

    fireEvent.press(screen.getByText('Check again'));
    await waitFor(() => expect(screen.queryByText('Allow reading CI statuses')).toBeNull());
    expect(screen.getByText('Connected')).toBeOnTheScreen();
    expect(validateGithubApp).toHaveBeenCalledTimes(2);
  });

  it('keeps a confirmed gap when a recheck fails, and says the check failed', async () => {
    useClient(jest.fn().mockResolvedValueOnce(missing).mockRejectedValue(new Error('network')));
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByText('Check again'));
    expect(await screen.findByText('Could not check GitHub. Try again.')).toBeOnTheScreen();
    expect(screen.getByText('Allow reading CI statuses')).toBeOnTheScreen();
  });

  it('explains installation approval when the App already requests the permission', async () => {
    useClient(
      jest.fn().mockResolvedValue({
        ok: true,
        commitStatusPermission: {
          state: 'approval_required',
          url: 'https://github.com/settings/installations/123',
        },
      }),
    );
    render(<GitHubSettingsScreen />);
    fireEvent.press(await screen.findByText('Show steps'));
    expect(screen.getByText(/Approve it in the installation settings/)).toBeOnTheScreen();
  });

  it.each([
    ['a failed check', jest.fn().mockRejectedValue(new Error('network'))],
    [
      'an unknown state',
      jest.fn().mockResolvedValue({ ok: true, commitStatusPermission: { state: 'unknown' } }),
    ],
  ])('claims no missing grant after %s', async (_name, validateGithubApp) => {
    useClient(validateGithubApp);
    render(<GitHubSettingsScreen />);
    await waitFor(() => expect(validateGithubApp).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByText('Connected')).toBeOnTheScreen();
    expect(screen.queryByText('Allow reading CI statuses')).toBeNull();
  });
});

describe('overview indicators', () => {
  it('marks the GitHub row in Connections', async () => {
    useClient(jest.fn().mockResolvedValue(missing));
    render(<ConnectionsScreen />);
    expect(await screen.findByLabelText(/^GitHub,.*Action needed/)).toBeOnTheScreen();
  });

  it('marks the Connections row in Settings, and only while the grant is missing', async () => {
    useClient(jest.fn().mockResolvedValue(missing));
    const first = render(<SettingsIndexScreen />);
    expect(await screen.findByLabelText(/^Connections,.*Action needed/)).toBeOnTheScreen();
    first.unmount();
    resetSettingsHarness();

    const validateGithubApp = jest.fn().mockResolvedValue(ready);
    useClient(validateGithubApp);
    render(<SettingsIndexScreen />);
    await waitFor(() => expect(validateGithubApp).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByLabelText(/^Connections,.*Action needed/)).toBeNull();
  });
});
