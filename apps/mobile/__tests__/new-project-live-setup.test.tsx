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

describe('new project', () => {
  it('launches a session in the created project without requiring optional setup', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    await screen.findByText('acme/website');
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.setProjectSetupStatus).toHaveBeenCalledWith('project-1', 'complete'),
    );
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
    render(<NewProjectScreen />);
    await screen.findByText('acme/website');
    fireEvent.press(screen.getByLabelText('Create project'));
    fireEvent.press(await screen.findByText('Google Drive folder'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings/services',
      params: { id: 'project-1', section: 'drive' },
    });
    expect(screen.queryByText('Matrix rooms')).toBeNull();
  });

  it('starts with a local project when GitHub is unavailable', async () => {
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

  it('creates a local project without repository access', async () => {
    const fake = client({ listAvailableRepositories: jest.fn().mockResolvedValue([]) });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    fireEvent.press(await screen.findByLabelText(/^Local project/));
    fireEvent.changeText(screen.getByLabelText('Project name'), 'notes');
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({ kind: 'local', name: 'notes' }),
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
    render(<NewProjectScreen />);
    await screen.findByText('acme/website');
    fireEvent.press(screen.getByLabelText('Create project'));
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
    render(<NewProjectScreen />);
    await screen.findByText('acme/website');
    fireEvent.press(screen.getByLabelText('Create project'));
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
  render(<NewProjectScreen />);
  await screen.findByText('acme/website');
  fireEvent.press(screen.getByLabelText('Create project'));
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

  // Each setup must offer exactly the connected hosts plus a local project:
  // a host that is offered but not connected fails only after the user commits.
  it.each([
    ['GitHub only', [project], null, ['GitHub']],
    ['Forgejo only', [], forgejo, ['Forgejo']],
    ['both', [project], forgejo, ['GitHub', 'Forgejo']],
    ['none', [], null, []],
  ] as const)('%s', async (_name, repositories, connections, offered) => {
    mockCreateClient.mockReturnValue(
      client({
        listAvailableRepositories: jest.fn().mockResolvedValue(repositories),
        listConnections: jest.fn().mockResolvedValue(connections),
        listConnectionRepositories: forgejoRepositories,
      }),
    );
    render(<NewProjectScreen />);
    expect(await screen.findByLabelText(/^Local project/)).toBeOnTheScreen();
    for (const name of ['GitHub', 'Forgejo']) {
      const option = screen.queryByRole('radio', { name: new RegExp(`^${name},`) });
      if (offered.includes(name as never)) expect(option).toBeOnTheScreen();
      else expect(option).toBeNull();
    }
    if (offered.length === 0) {
      expect(screen.getByLabelText('Project name')).toBeOnTheScreen();
      fireEvent.press(screen.getByText('Connect a code host'));
      expect(mockPush).toHaveBeenCalledWith('/settings/services');
    }
  });

  it('creates a Forgejo project with its connection and skips archived repositories', async () => {
    const fake = client({
      listAvailableRepositories: jest.fn().mockResolvedValue([project]),
      listConnections: jest.fn().mockResolvedValue(forgejo),
      listConnectionRepositories: forgejoRepositories,
    });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    fireEvent.press(await screen.findByRole('radio', { name: /^Forgejo,/ }));
    expect(await screen.findByText('team/website')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.createProject).toHaveBeenCalledWith({
        repo: 'team/website',
        kind: 'forgejo',
        connectionId: 'forgejo-1',
      }),
    );
    expect(mockStorage.get('verity.newProject.codeHost')).toBe('forgejo-1');
  });

  it('preselects the code host used last time', async () => {
    mockStorage.set('verity.newProject.codeHost', 'forgejo-1');
    mockCreateClient.mockReturnValue(
      client({
        listConnections: jest.fn().mockResolvedValue(forgejo),
        listConnectionRepositories: forgejoRepositories,
      }),
    );
    render(<NewProjectScreen />);
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
    expect(await screen.findByRole('radio', { name: /^GitHub,/ })).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: /^Forgejo,/ })).toBeNull();
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
    expect(await screen.findByText('acme/docs')).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText('Search repositories'), 'web');
    expect(screen.queryByText('acme/docs')).toBeNull();
    expect(screen.getByText('acme/website')).toBeOnTheScreen();
  });
});
