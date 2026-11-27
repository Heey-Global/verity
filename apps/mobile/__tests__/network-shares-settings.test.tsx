import { VerityApiError, type VerityClient } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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

describe('changing a share address', () => {
  // A new address ends every project's folders on the share; a hostname typo
  // fix must not do that without asking.
  it('asks before a new address ends project access', async () => {
    const client = shareClient();
    render(<NetworkShareConnections client={client} />);
    fireEvent.press(await screen.findByText('Studio NAS'));
    fireEvent.press(await screen.findByText('Edit'));
    fireEvent.changeText(screen.getByLabelText('Address'), 'smb://nas2.studio.lan/team');
    expect(screen.getByText('Enter the password again for the new address.')).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText('Password'), 'pw');
    fireEvent.press(screen.getByText('Test and save'));
    expect(await screen.findByText('Change the address of Studio NAS?')).toBeTruthy();
    expect(client.networkShares.updateConnection).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Change address'));
    await waitFor(() =>
      expect(client.networkShares.updateConnection).toHaveBeenCalledWith('studio', {
        address: 'smb://nas2.studio.lan/team',
        password: 'pw',
      }),
    );
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

  it('does not reopen the sheet when a folder loads after it was closed', async () => {
    let finish: (listing: { path: string; folders: never[] }) => void = () => undefined;
    const client = shareClient({
      listProjectFolders: jest.fn().mockResolvedValue([]),
      browseFolders: jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
    render(<ProjectNetworkShares client={client} projectId="p" />);
    fireEvent.press(await screen.findByText('Add folder'));
    expect(await screen.findByText('Use this folder')).toBeTruthy();
    fireEvent.press(screen.getAllByLabelText('Close').at(-1)!);
    await act(async () => finish({ path: '', folders: [] }));
    expect(screen.queryByText('Use this folder')).toBeNull();
  });

  it('does not reopen the sheet when an access change answers after it was closed', async () => {
    let finish: (folder: unknown) => void = () => undefined;
    const client = shareClient({
      setProjectFolderAccess: jest.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
    render(<ProjectNetworkShares client={client} projectId="p" />);
    fireEvent.press(await screen.findByText('Briefs'));
    fireEvent.press(await screen.findByText('Read only'));
    fireEvent.press(screen.getAllByLabelText('Close').at(-1)!);
    await act(async () => finish({ ...briefs, accessMode: 'read-only' }));
    expect(screen.queryByText('Remove from project')).toBeNull();
  });
});
