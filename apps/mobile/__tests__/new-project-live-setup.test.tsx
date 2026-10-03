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
  mockParams = {};
  mockReplace.mockReset();
  mockPush.mockReset();
  mockFocusCallbacks.clear();
  mockCreateClient.mockReset();
  jest.restoreAllMocks();
});

describe('new project', () => {
  it('opens the project directly and starts provisioning without requiring optional setup', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    fireEvent.press(await screen.findByLabelText('Create project'));
    await waitFor(() =>
      expect(fake.setProjectSetupStatus).toHaveBeenCalledWith('project-1', 'complete'),
    );
    expect(await screen.findByText('What does this project need?')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Open project'));
    expect(mockReplace).toHaveBeenCalledWith('/project/project-1');
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
    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByText('Google Drive folder'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings/services',
      params: { id: 'project-1', section: 'drive' },
    });
    expect(screen.queryByText('Matrix rooms')).toBeNull();
  });

  it('starts with an empty project when GitHub is unavailable', async () => {
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

  it('opens an older pending project directly on its project page', () => {
    mockParams = { projectId: 'project-1' };
    mockCreateClient.mockReturnValue(client());
    render(<NewProjectScreen />);
    expect(mockReplace).toHaveBeenCalledWith('/project/project-1');
  });

  it('creates a local project without repository access', async () => {
    const fake = client({ listAvailableRepositories: jest.fn().mockResolvedValue([]) });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);
    fireEvent.press(screen.getByLabelText('Empty project'));
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
    fireEvent.press(await screen.findByLabelText('Create project'));
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
    fireEvent.press(await screen.findByLabelText('Create project'));
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
  fireEvent.press(await screen.findByLabelText('Create project'));
  await waitFor(() => expect(drive).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Google Drive folder')).toBeNull();
  fireEvent.press(screen.getByText('Discover more connections'));
  drive.mockResolvedValue({ connected: true });
  await act(async () => {
    for (const callback of mockFocusCallbacks) callback();
  });
  expect(await screen.findByText('Google Drive folder')).toBeOnTheScreen();
});
