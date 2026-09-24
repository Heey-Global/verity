import { VerityApiError, type VerityClient, type ProjectRecord } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockReplace = jest.fn();
let mockParams: { projectId?: string } = {};
jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args) },
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
    expect(mockReplace).toHaveBeenCalledWith('/project/project-1');
    await waitFor(() =>
      expect(fake.repairProject).toHaveBeenCalledWith('project-1', { confirmWarnings: false }),
    );
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
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/project/project-1'));
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
