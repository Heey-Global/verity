import { VerityApiError, type VerityClient, type ProjectRecord } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockParams: { projectId?: string } = {};
const mockFocusCallbacks = new Set<() => void>();
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    push: (...args: unknown[]) => mockPush(...args),
  },
  useFocusEffect: (callback: () => void) => {
    require('react').useEffect(() => {
      mockFocusCallbacks.add(callback);
      callback();
      return () => mockFocusCallbacks.delete(callback);
    }, [callback]);
  },
  useLocalSearchParams: () => mockParams,
  Stack: Object.assign(() => null, { Screen: () => null }),
}));
const mockCreateClient = jest.fn<VerityClient | null, []>();
const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => Promise.resolve(mockStorage.get(key) ?? null),
  setItem: (key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  },
}));
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateClient(),
  getVerityBaseUrl: () => 'http://192.168.1.20:8082',
}));
import NewProjectScreen from '../app/new-project';

const project = {
  id: 'project-1',
  kind: 'github',
  owner: 'acme',
  repo: 'website',
  state: 'absent',
} as ProjectRecord;
function client(overrides: Partial<VerityClient> = {}): VerityClient {
  return {
    listAvailableRepositories: jest.fn().mockResolvedValue([project]),
    createProject: jest.fn().mockResolvedValue(project),
    setProjectSetupStatus: jest.fn().mockResolvedValue({ ...project, setupStatus: 'complete' }),
    repairProject: jest.fn().mockResolvedValue({ ...project, state: 'container_starting' }),
    ...overrides,
  } as unknown as VerityClient;
}
beforeEach(() => {
  mockStorage.clear();
  mockParams = {};
  mockReplace.mockReset();
  mockPush.mockReset();
  mockFocusCallbacks.clear();
  mockCreateClient.mockReset();
  jest.restoreAllMocks();
});

/** Chooses `acme/website` in the Add repository sheet. */
async function addWebsite() {
  await waitFor(() => expect(screen.getByText('Add repository')).toBeEnabled());
  fireEvent.press(screen.getByText('Add repository'));
  fireEvent.press(await screen.findByLabelText('Add acme/website'));
  await screen.findByLabelText('Remove acme/website');
}

/** Creates a project from `acme/website`, named after it. */
async function createFromRepository() {
  render(<NewProjectScreen />);
  await addWebsite();
  fireEvent.press(screen.getByLabelText('Create project'));
}

describe('new project', () => {
  it('launches a session in the created project without requiring optional setup', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    await createFromRepository();
    await waitFor(() =>
      expect(fake.setProjectSetupStatus).toHaveBeenCalledWith('project-1', 'complete'),
    );
    expect(fake.createProject).toHaveBeenCalledWith({ repo: 'acme/website', name: 'website' });
    expect(await screen.findByText('What does this project need?')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Open project'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/new',
      params: { projectId: 'project-1' },
    });
    await waitFor(() =>
      expect(fake.repairProject).toHaveBeenCalledWith('project-1', { confirmWarnings: false }),
    );
  });

  it('offers only connected services and opens scope selection without granting access', async () => {
    const fake = client({
      getGoogleDriveConnection: jest.fn().mockResolvedValue({ connected: true }),
      getProjectGoogleConnection: jest.fn().mockResolvedValue({ connected: false }),
      listIntegrations: jest.fn().mockResolvedValue({ accounts: [], sources: [] }),
      listHttpMcpConnections: jest.fn().mockResolvedValue([]),
      getVeritySettings: jest.fn().mockResolvedValue(null),
    });
    mockCreateClient.mockReturnValue(fake);
    await createFromRepository();
    fireEvent.press(await screen.findByText('Google Drive folder'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings/services',
      params: { id: 'project-1', section: 'drive' },
    });
    expect(screen.queryByText('Matrix rooms')).toBeNull();
  });

  it('asks for a name when GitHub is unavailable', async () => {
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest
          .fn()
          .mockRejectedValue(new VerityApiError(400, 'GitHub not connected')),
      }),
    );
    render(<NewProjectScreen />);
    expect(await screen.findByLabelText('Project name')).toBeOnTheScreen();
    expect(screen.queryByText('GitHub not connected')).toBeNull();
  });

  it('launches a session in an older pending project when resuming setup', () => {
    mockParams = { projectId: 'project-1' };
    mockCreateClient.mockReturnValue(client());
    render(<NewProjectScreen />);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/new',
      params: { projectId: 'project-1' },
    });
  });

  it('creates a project from its name alone, without a repository', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    await screen.findByLabelText('Project name');
    // Nothing to create without a name.
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText('Project name'), '  Kundenportal  ');
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({ kind: 'local', name: 'Kundenportal' }),
    );
    await act(async () => {});
  });

  it('keeps a typed name when a repository is chosen afterwards', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    fireEvent.changeText(await screen.findByLabelText('Project name'), 'Verity Plattform');
    await addWebsite();
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({
        repo: 'acme/website',
        name: 'Verity Plattform',
      }),
    );
    await act(async () => {});
  });

  it('connects every further repository to the project the first one created', async () => {
    const fake = client({
      listAvailableRepositories: jest
        .fn()
        .mockResolvedValue([project, { ...project, id: 'p2', repo: 'docs' }]),
      addProjectRepository: jest.fn().mockResolvedValue(undefined),
    });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    await addWebsite();
    fireEvent.press(screen.getByText('Add repository'));
    // A repository already chosen is not offered again.
    await screen.findByLabelText('Add acme/docs');
    expect(screen.queryByLabelText('Add acme/website')).toBeNull();
    fireEvent.press(screen.getByLabelText('Add acme/docs'));
    await screen.findByLabelText('Remove acme/docs');
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.addProjectRepository).toHaveBeenCalledWith('project-1', {
        name: 'docs',
        kind: 'github',
        owner: 'acme',
        repo: 'docs',
      }),
    );
    expect(fake.createProject).toHaveBeenCalledWith({ repo: 'acme/website', name: 'website' });
    await screen.findByText('What does this project need?');
  });

  it('creates the project without a repository once the chosen one is removed', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    await addWebsite();
    fireEvent.press(screen.getByLabelText('Remove acme/website'));
    fireEvent.press(screen.getByLabelText('Create project'));
    // The suggested name stays; only the repository is gone.
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({ kind: 'local', name: 'website' }),
    );
    await act(async () => {});
  });

  it('shows a provisioning failure after opening the project', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockCreateClient.mockReturnValue(
      client({
        repairProject: jest.fn().mockRejectedValue(new VerityApiError(500, 'Build failed')),
      }),
    );
    await createFromRepository();
    await screen.findByText('What does this project need?');
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith('Could not prepare project', 'Build failed'),
    );
  });

  it('lets you confirm a provisioning warning from the project page', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const repairProject = jest
      .fn()
      .mockRejectedValueOnce(
        new VerityApiError(409, 'Review required', {
          requiresConfirmation: true,
          warnings: ['Build command runs scripts'],
        }),
      )
      .mockResolvedValue({ ...project, state: 'container_starting' });
    mockCreateClient.mockReturnValue(client({ repairProject }));
    await createFromRepository();
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        'Review project warning',
        'Build command runs scripts',
        expect.any(Array),
      ),
    );
    const actions = alert.mock.calls[0]?.[2];
    actions?.find((action) => action.text === 'Continue')?.onPress?.();
    await waitFor(() =>
      expect(repairProject).toHaveBeenCalledWith('project-1', { confirmWarnings: true }),
    );
  });
});

it('refreshes available choices after connecting a service and returning', async () => {
  const drive = jest.fn().mockResolvedValue({ connected: false });
  mockCreateClient.mockReturnValue(client({ getGoogleDriveConnection: drive }));
  await createFromRepository();
  await waitFor(() => expect(drive).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Google Drive folder')).toBeNull();
  fireEvent.press(screen.getByText('Discover more connections'));
  drive.mockResolvedValue({ connected: true });
  await act(async () => {
    for (const callback of mockFocusCallbacks) callback();
  });
  expect(await screen.findByText('Google Drive folder')).toBeOnTheScreen();
});

describe('new project — code hosts', () => {
  const forgejo = {
    connections: [
      {
        id: 'forgejo-1',
        provider: 'forgejo',
        baseUrl: 'https://git.example.org',
        label: 'Forgejo',
      },
    ],
    forgejoProjectsAvailable: true,
  };
  const forgejoRepositories = jest.fn().mockResolvedValue([
    { owner: 'team', repo: 'legacy', archived: true },
    { owner: 'team', repo: 'website', archived: false },
  ]);

  // Each setup must offer exactly the connected hosts: a host that is offered
  // but not connected fails only after the user commits.
  it.each([
    ['GitHub only', [project], null, 'GitHub'],
    ['Forgejo only', [], forgejo, 'Forgejo'],
    ['both', [project], forgejo, 'GitHub or Forgejo'],
    ['none', [], null, null],
  ] as const)('%s', async (_name, repositories, connections, offered) => {
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest.fn().mockResolvedValue(repositories),
        listConnections: jest.fn().mockResolvedValue(connections),
        listConnectionRepositories: forgejoRepositories,
      }),
    );
    render(<NewProjectScreen />);
    expect(await screen.findByLabelText('Project name')).toBeOnTheScreen();
    if (offered === null) {
      expect(screen.queryByText('Add repository')).toBeNull();
      fireEvent.press(screen.getByText('Connect a code host'));
      expect(mockPush).toHaveBeenCalledWith('/settings/services');
      return;
    }
    expect(screen.getByText(offered)).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Add repository'));
    for (const name of ['GitHub', 'Forgejo']) {
      const option = screen.queryByRole('radio', { name: new RegExp(`^${name},`) });
      // The sheet asks for the host only when there is a choice.
      if (offered === 'GitHub or Forgejo') expect(option).toBeOnTheScreen();
      else expect(option).toBeNull();
    }
  });

  it('reloads code hosts after returning from connection setup', async () => {
    const connections = jest.fn().mockResolvedValue(null);
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest.fn().mockResolvedValue([]),
        listConnections: connections,
        listConnectionRepositories: forgejoRepositories,
      }),
    );
    render(<NewProjectScreen />);
    fireEvent.press(await screen.findByText('Connect a code host'));
    connections.mockResolvedValue(forgejo);
    act(() => {
      for (const callback of mockFocusCallbacks) callback();
    });
    expect(await screen.findByText('Add repository')).toBeOnTheScreen();
    expect(screen.getByText('Forgejo')).toBeOnTheScreen();
  });

  it('creates a Forgejo project with its connection and skips archived repositories', async () => {
    const fake = client({
      listAvailableRepositories: jest.fn().mockResolvedValue([project]),
      listConnections: jest.fn().mockResolvedValue(forgejo),
      listConnectionRepositories: forgejoRepositories,
    });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeEnabled());
    fireEvent.press(screen.getByText('Add repository'));
    fireEvent.press(await screen.findByRole('radio', { name: /^Forgejo,/ }));
    fireEvent.press(await screen.findByLabelText('Add team/website'));
    expect(screen.queryByLabelText('Add team/legacy')).toBeNull();
    await screen.findByLabelText('Remove team/website');
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({
        repo: 'team/website',
        kind: 'forgejo',
        connectionId: 'forgejo-1',
        name: 'website',
      }),
    );
    expect(mockStorage.get('verity.newProject.codeHost')).toBe('forgejo-1');
  });

  it('asks for a name when code hosts cannot load', async () => {
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest.fn().mockRejectedValue(new Error('offline')),
        listConnections: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    );
    render(<NewProjectScreen />);
    expect(await screen.findByLabelText('Project name')).toBeOnTheScreen();
  });

  it('offers the code host used last time first', async () => {
    mockStorage.set('verity.newProject.codeHost', 'forgejo-1');
    mockCreateClient.mockReturnValue(
      client({
        listConnections: jest.fn().mockResolvedValue(forgejo),
        listConnectionRepositories: forgejoRepositories,
      }),
    );
    render(<NewProjectScreen />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeEnabled());
    fireEvent.press(screen.getByText('Add repository'));
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Forgejo,/ })).toBeChecked());
  });

  it('hides Forgejo when the server cannot run Forgejo projects', async () => {
    mockCreateClient.mockReturnValue(
      client({
        listConnections: jest
          .fn()
          .mockResolvedValue({ ...forgejo, forgejoProjectsAvailable: false }),
      }),
    );
    render(<NewProjectScreen />);
    expect(await screen.findByText('Add repository')).toBeOnTheScreen();
    expect(screen.getByText('GitHub')).toBeOnTheScreen();
    expect(screen.queryByText('GitHub or Forgejo')).toBeNull();
  });

  it('filters repositories by search', async () => {
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest
          .fn()
          .mockResolvedValue([project, { ...project, id: 'p2', repo: 'docs' }]),
      }),
    );
    render(<NewProjectScreen />);
    await waitFor(() => expect(screen.getByText('Add repository')).toBeEnabled());
    fireEvent.press(screen.getByText('Add repository'));
    expect(await screen.findByText('acme/docs')).toBeOnTheScreen();
    fireEvent.changeText(screen.getByPlaceholderText('Search GitHub repositories'), 'web');
    expect(screen.queryByText('acme/docs')).toBeNull();
    expect(screen.getByText('acme/website')).toBeOnTheScreen();
  });
});
