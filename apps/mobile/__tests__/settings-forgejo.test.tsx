// Forgejo as a code host next to GitHub: the Connections "Code" group in every
// setup, connecting the one Forgejo instance, and managing it afterwards.
import { VerityApiError, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-clipboard', () => require('./support/settingsHarness').clipboardMock());
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import ConnectionsScreen from '../app/settings/services/index';
import ForgejoConnectionScreen from '../app/settings/forgejo/[id]';
import NewForgejoConnectionScreen from '../app/settings/forgejo/new';
import {
  makeClient,
  makeSettings,
  mockBack,
  mockCreateVerityClient,
  mockPush,
  mockReplace,
  resetSettingsHarness,
  setSearchParams,
} from './support/settingsHarness';

const forgejo = {
  id: 'forgejo-1',
  provider: 'forgejo',
  baseUrl: 'https://git.example.org',
  label: 'Forgejo',
};
const githubOff = makeSettings({
  githubAppId: null,
  githubAppInstallationId: null,
  githubAppPrivateKeyConfigured: false,
});

function useClient(
  opts: {
    github?: boolean;
    forgejo?: boolean;
    extra?: Partial<Record<keyof VerityClient, unknown>>;
  } = {},
) {
  const client = makeClient('unlocked', opts.github === false ? { settings: githubOff } : {});
  Object.assign(client, {
    listConnections: jest.fn().mockResolvedValue({
      connections: opts.forgejo ? [forgejo] : [],
      forgejoProjectsAvailable: true,
    }),
    getConnectionUsage: jest.fn().mockResolvedValue({
      github: 4,
      claude: 0,
      codex: 0,
      opencode: 0,
      google: 0,
      matrix: 0,
      doppler: 0,
      mcp: 0,
      forgejo: { 'forgejo-1': 2 },
    }),
    ...opts.extra,
  });
  mockCreateVerityClient.mockReturnValue(client);
  return client;
}

beforeEach(() => resetSettingsHarness());

describe('Connections → Code', () => {
  // A missing or duplicated row is what makes one provider look secondary.
  it.each([
    [
      'GitHub only',
      true,
      false,
      /^GitHub,.*Connected/,
      /^Forgejo, Self-hosted Git server, Connect/,
    ],
    [
      'Forgejo only',
      false,
      true,
      /^GitHub,.*Connect$/,
      /^Forgejo, git\.example\.org · Used in 2 projects, Connected/,
    ],
    [
      'both',
      true,
      true,
      /^GitHub,.*Used in 4 projects, Connected/,
      /^Forgejo, git\.example\.org · Used in 2 projects, Connected/,
    ],
    ['none', false, false, /^GitHub,.*Connect$/, /^Forgejo, Self-hosted Git server, Connect/],
  ] as const)('%s', async (_name, github, withForgejo, githubRow, forgejoRow) => {
    useClient({ github, forgejo: withForgejo });
    render(<ConnectionsScreen />);
    expect(await screen.findByLabelText(forgejoRow)).toBeOnTheScreen();
    expect(screen.getByLabelText(githubRow)).toBeOnTheScreen();
    expect(screen.getAllByLabelText(/^Forgejo,/)).toHaveLength(1);
  });

  it('opens the connect form, or the existing instance', async () => {
    useClient({ forgejo: false });
    const first = render(<ConnectionsScreen />);
    fireEvent.press(await screen.findByLabelText(/^Forgejo, Self-hosted/));
    expect(mockPush).toHaveBeenCalledWith('/settings/forgejo/new');
    first.unmount();

    useClient({ forgejo: true });
    render(<ConnectionsScreen />);
    fireEvent.press(await screen.findByLabelText(/^Forgejo, git\.example\.org/));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings/forgejo/[id]',
      params: { id: 'forgejo-1' },
    });
  });

  it('shows no Forgejo row where the server cannot list connections', async () => {
    useClient({ extra: { listConnections: jest.fn().mockResolvedValue(null) } });
    render(<ConnectionsScreen />);
    expect(await screen.findByLabelText(/^GitHub,/)).toBeOnTheScreen();
    await act(async () => {});
    expect(screen.queryByLabelText(/^Forgejo,/)).toBeNull();
  });
});

describe('Connect Forgejo', () => {
  it('validates through the server and opens the new connection', async () => {
    const createForgejoConnection = jest.fn().mockResolvedValue(forgejo);
    useClient({ extra: { createForgejoConnection } });
    render(<NewForgejoConnectionScreen />);
    fireEvent.changeText(await screen.findByLabelText('Server URL'), ' https://git.example.org ');
    fireEvent.changeText(screen.getByLabelText('Access token'), 'token-fixture');
    fireEvent.press(screen.getByRole('button', { name: 'Connect Forgejo' }));
    await waitFor(() =>
      expect(createForgejoConnection).toHaveBeenCalledWith({
        baseUrl: 'https://git.example.org',
        label: 'Forgejo',
        token: 'token-fixture',
      }),
    );
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/settings/forgejo/[id]',
      params: { id: 'forgejo-1' },
    });
  });

  it('explains a rejected connection without echoing the token', async () => {
    useClient({
      extra: {
        createForgejoConnection: jest
          .fn()
          .mockRejectedValue(new VerityApiError(422, 'Forgejo connection validation failed')),
      },
    });
    render(<NewForgejoConnectionScreen />);
    fireEvent.changeText(await screen.findByLabelText('Server URL'), 'http://git.example.org');
    fireEvent.changeText(screen.getByLabelText('Access token'), 'token-fixture');
    fireEvent.press(screen.getByRole('button', { name: 'Connect Forgejo' }));
    expect(await screen.findByText('Could not connect')).toBeOnTheScreen();
    expect(screen.queryByText(/token-fixture/)).toBeNull();
  });

  // The app keeps one instance; a stale link must not create a second one.
  it('forwards to the existing connection', async () => {
    useClient({ forgejo: true });
    render(<NewForgejoConnectionScreen />);
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/settings/forgejo/[id]',
        params: { id: 'forgejo-1' },
      }),
    );
  });
});

describe('Forgejo connection', () => {
  beforeEach(() => setSearchParams({ id: 'forgejo-1' }));

  it('blocks disconnecting while projects use it', async () => {
    useClient({ forgejo: true });
    render(<ForgejoConnectionScreen />);
    expect(await screen.findByText('2 projects')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Disconnect Forgejo' })).toBeDisabled();
  });

  it('replaces the token and disconnects an unused instance', async () => {
    const updateForgejoConnection = jest.fn().mockResolvedValue(forgejo);
    const deleteConnection = jest.fn().mockResolvedValue(undefined);
    const client = useClient({
      forgejo: true,
      extra: { updateForgejoConnection, deleteConnection },
    });
    (client.getConnectionUsage as jest.Mock).mockResolvedValue({
      github: 0,
      claude: 0,
      codex: 0,
      opencode: 0,
      google: 0,
      matrix: 0,
      doppler: 0,
      mcp: 0,
      forgejo: {},
    });
    render(<ForgejoConnectionScreen />);
    fireEvent.press(await screen.findByLabelText('Access token'));
    fireEvent.changeText(screen.getByLabelText('New access token'), 'rotated-fixture');
    fireEvent.press(screen.getByRole('button', { name: 'Replace token' }));
    await waitFor(() =>
      expect(updateForgejoConnection).toHaveBeenCalledWith('forgejo-1', {
        token: 'rotated-fixture',
      }),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Disconnect Forgejo' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(deleteConnection).toHaveBeenCalledWith('forgejo-1'));
    expect(mockBack).toHaveBeenCalled();
  });
});
