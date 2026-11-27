import { VerityApiError, type VerityClient } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
import { NetworkShareConnections } from '../components/settings/NetworkShareConnections';
import { ProjectNetworkShares } from '../components/settings/ProjectNetworkShares';
import { resetSettingsHarness } from './support/settingsHarness';
afterEach(resetSettingsHarness);

const studio = {
  id: 'studio',
  label: 'Studio NAS',
  address: 'smb://nas.studio.lan/team',
  username: 'verity',
  projectCount: 1,
  createdAt: '2026-11-27T00:00:00.000Z',
};
const briefs = {
  id: 'f1',
  connectionId: 'studio',
  connectionLabel: 'Studio NAS',
  path: 'Projects/Briefs',
  name: 'Briefs',
  accessMode: 'read-write' as const,
  stale: false,
};

function shareClient(overrides: Record<string, unknown> = {}) {
  return {
    networkShares: {
      listConnections: jest.fn().mockResolvedValue([studio]),
      testConnection: jest.fn().mockResolvedValue({ ok: true }),
      addConnection: jest.fn(),
      updateConnection: jest.fn(),
      removeConnection: jest.fn(),
      listProjectFolders: jest.fn().mockResolvedValue([briefs]),
      browseFolders: jest.fn(async (_id: string, path: string) =>
        path === ''
          ? { path: '', folders: [{ name: 'Projects', path: 'Projects' }] }
          : { path, folders: [] },
      ),
      grantProjectFolder: jest.fn().mockResolvedValue(briefs),
      setProjectFolderAccess: jest.fn().mockResolvedValue({ ...briefs, accessMode: 'read-only' }),
      removeProjectFolder: jest.fn(),
      ...overrides,
    },
  } as unknown as VerityClient;
}

describe('network share settings', () => {
  it('shows each share with its test result', async () => {
    const client = shareClient();
    render(<NetworkShareConnections client={client} />);
    expect(await screen.findByText('Studio NAS')).toBeTruthy();
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('nas.studio.lan/team · Used in 1 project')).toBeTruthy();
  });

  // A sign-in error belongs under the password, not as a generic banner the
  // administrator has to map back to a field.
  it('shows a failed sign-in at the password field', async () => {
    const client = shareClient({
      listConnections: jest.fn().mockResolvedValue([]),
      addConnection: jest.fn().mockRejectedValue(
        new VerityApiError(502, 'The NAS rejected the username or password.', {
          code: 'sign_in_failed',
        }),
      ),
    });
    render(<NetworkShareConnections client={client} />);
    fireEvent.press(await screen.findByText('Add network share'));
    fireEvent.changeText(screen.getByLabelText('Name'), 'Studio NAS');
    fireEvent.changeText(screen.getByLabelText('Address'), 'smb://nas.studio.lan/team');
    fireEvent.changeText(screen.getByLabelText('Username'), 'verity');
    fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    fireEvent.press(screen.getByText('Test and add'));
    expect(await screen.findByText('The NAS rejected the username or password.')).toBeTruthy();
    expect(client.networkShares.addConnection).toHaveBeenCalledWith({
      label: 'Studio NAS',
      address: 'smb://nas.studio.lan/team',
      username: 'verity',
      password: 'wrong',
    });
  });
});

describe('project network share folders', () => {
  it('adds a folder read only unless write access is chosen', async () => {
    const client = shareClient({ listProjectFolders: jest.fn().mockResolvedValue([]) });
    render(<ProjectNetworkShares client={client} projectId="p" />);
    fireEvent.press(await screen.findByText('Add folder'));
    fireEvent.press(await screen.findByText('Projects'));
    await waitFor(() =>
      expect(client.networkShares.browseFolders).toHaveBeenCalledWith('studio', 'Projects'),
    );
    fireEvent.press(await screen.findByText('Use this folder'));
    expect(await screen.findByText('Access to “Projects”')).toBeTruthy();
    // The sheet's button, not the list row behind the sheet.
    fireEvent.press(screen.getAllByText('Add folder').at(-1)!);
    await waitFor(() =>
      expect(client.networkShares.grantProjectFolder).toHaveBeenCalledWith('p', {
        connectionId: 'studio',
        path: 'Projects',
        accessMode: 'read-only',
      }),
    );
  });

  it('changes and removes a folder’s access', async () => {
    const client = shareClient();
    render(<ProjectNetworkShares client={client} projectId="p" />);
    expect(await screen.findByText('Read and write')).toBeTruthy();
    fireEvent.press(screen.getByText('Briefs'));
    fireEvent.press(await screen.findByText('Read only'));
    await waitFor(() =>
      expect(client.networkShares.setProjectFolderAccess).toHaveBeenCalledWith(
        'p',
        'f1',
        'read-only',
      ),
    );
    fireEvent.press(screen.getByText('Remove from project'));
    await waitFor(() =>
      expect(client.networkShares.removeProjectFolder).toHaveBeenCalledWith('p', 'f1'),
    );
  });

  // Members may see which folders agents use, but the server refuses changes;
  // the screen must not offer controls that can only fail.
  it('shows folders read-only to people who cannot manage shares', async () => {
    const client = shareClient({
      listConnections: jest.fn().mockRejectedValue(new VerityApiError(403, 'forbidden')),
    });
    render(<ProjectNetworkShares client={client} projectId="p" />);
    expect(await screen.findByText('Briefs')).toBeTruthy();
    expect(screen.queryByText('Add folder')).toBeNull();
    fireEvent.press(screen.getByText('Briefs'));
    expect(screen.queryByText('Remove from project')).toBeNull();
  });
});
