// Behaviour tests for the real onboarding FIRST-PROJECT step screen. The step now
// lists repositories already visible through the GitHub connection, lets the operator
// select one, and prepares that exact project before completing onboarding.
import { VerityApiError, type VerityClient, type ProjectRecord } from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn<void, [string]>();
jest.mock('expo-router', () => ({
  router: { replace: (href: string) => mockReplace(href) },
  useSegments: () => [] as string[],
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
  getVerityBaseUrl: () => 'http://verity.example:8082',
}));

import OnboardingFirstProject from '../app/onboarding/first-project';

function fakeClient(overrides: Partial<VerityClient>): VerityClient {
  return overrides as unknown as VerityClient;
}

function project(overrides: Partial<ProjectRecord>): ProjectRecord {
  return {
    id: 'proj_1',
    kind: 'github',
    repo: 'repo',
    owner: 'owner',
    state: 'absent',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    containerName: null,
    imageRef: null,
    latestRelease: null,
    provisionError: null,
    containerStatus: null,
    sandbox: null,
    lifecycle: null,
    settings: null,
    ...overrides,
  } as ProjectRecord;
}

const defaultProjects = [
  project({ id: 'proj_1', owner: 'heey-global', repo: 'verity', state: 'absent' }),
  project({ id: 'proj_2', owner: 'example-org', repo: 'sample-app', state: 'absent' }),
];

const baseClient = (overrides: Partial<VerityClient>): VerityClient =>
  fakeClient({
    listAvailableRepositories: jest.fn().mockResolvedValue(defaultProjects),
    createProject: jest.fn().mockImplementation(({ repo }: { repo: string }) => {
      const found = defaultProjects.find(
        (candidate) => `${candidate.owner}/${candidate.repo}` === repo,
      );
      return Promise.resolve(found ?? project({ id: 'created-project' }));
    }),
    repairProject: jest.fn().mockResolvedValue(project({ id: 'proj_1', state: 'active' })),
    getProject: jest
      .fn()
      .mockResolvedValue({ project: project({ id: 'proj_1', state: 'active' }) }),
    ...overrides,
  });

beforeEach(() => {
  mockReplace.mockReset();
  mockCreateVerityClient.mockReset();
});

describe('onboarding first-project step (required)', () => {
  it('loads repositories and renders selectable repo rows', async () => {
    mockCreateVerityClient.mockReturnValue(baseClient({}));
    render(<OnboardingFirstProject />);

    expect(screen.getByText('Add your first project')).toBeOnTheScreen();
    expect(await screen.findByLabelText('heey-global/verity')).toBeOnTheScreen();
    expect(screen.getByLabelText('example-org/sample-app')).toBeOnTheScreen();
    expect(screen.getByLabelText('Prepare selected project')).toBeOnTheScreen();
  });

  it('prepares the selected repository project and advances to /onboarding/done', async () => {
    const createProject = jest
      .fn()
      .mockResolvedValue(project({ id: 'created-proj-2', state: 'absent' }));
    const repairProject = jest.fn().mockResolvedValue(project({ id: 'proj_2', state: 'active' }));
    mockCreateVerityClient.mockReturnValue(baseClient({ createProject, repairProject }));
    render(<OnboardingFirstProject />);

    fireEvent.press(await screen.findByLabelText('example-org/sample-app'));
    fireEvent.press(screen.getByLabelText('Prepare selected project'));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ repo: 'example-org/sample-app' }),
    );
    await waitFor(() =>
      expect(repairProject).toHaveBeenCalledWith('created-proj-2', { confirmWarnings: false }),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/done'));
  });

  it('shows provisioning progress while preparing the selected project', async () => {
    let resolveRepair!: (value: ProjectRecord) => void;
    const repairProject = jest.fn().mockReturnValue(
      new Promise<ProjectRecord>((resolve) => {
        resolveRepair = resolve;
      }),
    );
    mockCreateVerityClient.mockReturnValue(baseClient({ repairProject }));
    render(<OnboardingFirstProject />);

    const prepare = await screen.findByLabelText('Prepare selected project');
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.press(prepare);

    expect(await screen.findByText('Starting project container...')).toBeOnTheScreen();
    resolveRepair(project({ id: 'proj_1', state: 'active' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/done'));
  });

  it('shows the error and does NOT advance when provisioning rejects', async () => {
    const repairProject = jest.fn().mockRejectedValue(new Error('Docker network missing'));
    mockCreateVerityClient.mockReturnValue(baseClient({ repairProject }));
    render(<OnboardingFirstProject />);

    fireEvent.press(await screen.findByLabelText('Prepare selected project'));

    expect(await screen.findByText('Docker network missing')).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('keeps Prepare inert and offers reload when no repositories are available', async () => {
    const repairProject = jest.fn();
    const listAvailableRepositories = jest.fn().mockResolvedValue([]);
    mockCreateVerityClient.mockReturnValue(
      baseClient({ listAvailableRepositories, repairProject }),
    );
    render(<OnboardingFirstProject />);

    expect(await screen.findByText(/No repositories are available/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Reload repositories')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Prepare selected project'));

    expect(repairProject).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('routes to device unlock when repository loading is unauthorized', async () => {
    mockCreateVerityClient.mockReturnValue(
      baseClient({
        listAvailableRepositories: jest
          .fn()
          .mockRejectedValue(new VerityApiError(401, 'unauthorized')),
      }),
    );
    render(<OnboardingFirstProject />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/unlock-device?returnTo=%2Fonboarding%2Ffirst-project',
      ),
    );
  });

  it('routes to device unlock when project provisioning finds sealed secrets', async () => {
    const repairProject = jest
      .fn()
      .mockRejectedValue(new VerityApiError(503, 'secret store is sealed'));
    mockCreateVerityClient.mockReturnValue(baseClient({ repairProject }));
    render(<OnboardingFirstProject />);

    fireEvent.press(await screen.findByLabelText('Prepare selected project'));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/unlock-device?returnTo=%2Fonboarding%2Ffirst-project',
      ),
    );
  });

  it('shows a guard note and attempts no provisioning when no server is configured', () => {
    mockCreateVerityClient.mockReturnValue(null);
    render(<OnboardingFirstProject />);

    expect(screen.getByText(/set the Verity server address first/)).toBeOnTheScreen();
    expect(screen.queryByLabelText('Prepare selected project')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
