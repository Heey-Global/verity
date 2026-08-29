import {
  VerityApiError,
  type VerityClient,
  type DevServerDetection,
  type ProjectRecord,
} from '@verity/mobile';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
let mockParams: { projectId?: string } = {};
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    dismissTo: (...args: unknown[]) => mockDismissTo(...args),
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

function project(state: ProjectRecord['state']): ProjectRecord {
  return {
    id: 'project-1',
    kind: 'github',
    owner: 'acme',
    repo: 'website',
    containerName: 'verity-acme--website',
    imageRef: null,
    state,
    provisionError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ProjectRecord;
}

const detection = {
  fingerprint: 'detected',
  detectedAt: '2026-01-01T00:00:00.000Z',
  reviewedFingerprint: null,
  reviewedAt: null,
  suggestions: [
    {
      key: '.:dev',
      name: 'Website',
      command: 'npm run dev',
      workdir: null,
      containerPort: '3000',
      confidence: 'high',
      evidence: 'Next.js dev script',
      status: 'new',
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    },
  ],
} satisfies DevServerDetection;

const reviewedDetection = {
  ...detection,
  reviewedFingerprint: detection.fingerprint,
};

const unboundSettings = {
  projectId: 'project-1',
  dopplerProject: null,
  dopplerConfig: null,
  defaultBranch: 'main',
  defaultModel: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function client(overrides: Partial<VerityClient> = {}): VerityClient {
  return {
    listAvailableRepositories: jest.fn().mockResolvedValue([project('absent')]),
    createProject: jest.fn().mockResolvedValue(project('absent')),
    repairProject: jest.fn().mockResolvedValue(project('active')),
    deprovisionProject: jest.fn().mockResolvedValue(project('absent')),
    listDevServers: jest.fn().mockResolvedValue([]),
    createDevServer: jest.fn().mockResolvedValue({ id: 'dev-1' }),
    reviewDevServerDetection: jest.fn().mockResolvedValue({}),
    setupDetectedDevServers: jest.fn().mockResolvedValue(project('cloning')),
    setProjectSetupStatus: jest
      .fn()
      .mockImplementation((_id, status) =>
        Promise.resolve({ ...project('active'), setupStatus: status }),
      ),
    getProject: jest
      .fn()
      .mockResolvedValue({ project: project('active'), settings: unboundSettings, sessions: [] }),
    getDevServerDetection: jest.fn().mockResolvedValue(detection),
    ...overrides,
  } as unknown as VerityClient;
}

beforeEach(() => {
  mockParams = {};
  mockReplace.mockReset();
  mockCreateClient.mockReset();
});

describe('new project live setup', () => {
  it('starts provisioning and automatically analyzes the active project', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));

    await waitFor(() =>
      expect(fake.repairProject).toHaveBeenCalledWith('project-1', { confirmWarnings: false }),
    );
    await waitFor(() => expect(fake.getDevServerDetection).toHaveBeenCalledWith('project-1'));
    expect(await screen.findByText('1 Dev Server found')).toBeOnTheScreen();
    expect(screen.getByLabelText('Set up detected Dev Servers')).toBeOnTheScreen();
  });

  it('resumes a pending project at its missing secrets step', async () => {
    mockParams = { projectId: 'project-1' };
    const fake = client({
      listAvailableRepositories: jest.fn(),
      getProject: jest.fn().mockResolvedValue({
        project: { ...project('active'), setupStatus: 'pending' },
        settings: unboundSettings,
        sessions: [],
      }),
      getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection),
    });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);

    expect(await screen.findByLabelText('Choose Doppler secrets')).toBeOnTheScreen();
    expect(fake.listAvailableRepositories).not.toHaveBeenCalled();
    expect(fake.createProject).not.toHaveBeenCalled();
  });

  it('continues provisioning when creation was interrupted before setup started', async () => {
    mockParams = { projectId: 'project-1' };
    const repairProject = jest.fn().mockResolvedValue(project('cloning'));
    mockCreateClient.mockReturnValue(
      client({
        getProject: jest.fn().mockResolvedValue({
          project: { ...project('absent'), setupStatus: 'pending' },
          settings: unboundSettings,
          sessions: [],
        }),
        repairProject,
      }),
    );
    render(<NewProjectScreen />);

    await waitFor(() =>
      expect(repairProject).toHaveBeenCalledWith('project-1', { confirmWarnings: false }),
    );
    expect(await screen.findByText('Preparing repository…')).toBeOnTheScreen();
  });

  it('shows durable friendly progress and allows returning to the overview', async () => {
    mockCreateClient.mockReturnValue(
      client({ repairProject: jest.fn().mockResolvedValue(project('cloning')) }),
    );
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));

    expect(await screen.findByText('Preparing repository…')).toBeOnTheScreen();
    expect(screen.getByText(/continues in the background/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Project setup progress')).toHaveProp('accessibilityValue', {
      min: 0,
      max: 5,
      now: 1,
      text: 'Preparing repository…',
    });
    fireEvent.press(screen.getByLabelText('Return to overview'));
    // Pops to the home this wizard was opened from. `replace` would leave that
    // home below a second one, and the overview would come back with a back
    // button pointing at itself.
    expect(mockDismissTo).toHaveBeenCalledWith('/');
    expect(mockReplace).not.toHaveBeenCalledWith('/');
  });

  it('retries project analysis after a transient failure', async () => {
    const getDevServerDetection = jest
      .fn()
      .mockRejectedValueOnce(new Error('scanner unavailable'))
      .mockResolvedValue(detection);
    mockCreateClient.mockReturnValue(client({ getDevServerDetection }));
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));

    fireEvent.press(await screen.findByLabelText('Retry project analysis'));
    await waitFor(() => expect(getDevServerDetection).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1 Dev Server found')).toBeOnTheScreen();
  });

  it('applies detected servers through the durable setup operation', async () => {
    const fake = client();
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Set up detected Dev Servers'));

    await waitFor(() =>
      expect(fake.setupDetectedDevServers).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({
          confirmWarnings: false,
          fingerprint: 'detected',
          devServers: [
            expect.objectContaining({
              sourceKey: '.:dev',
              command: 'npm run dev',
              containerPort: '3000',
            }),
          ],
        }),
      ),
    );
    expect(fake.repairProject).toHaveBeenCalledTimes(1);
  });

  it('requires explicit confirmation before continuing past project warnings', async () => {
    const repairProject = jest
      .fn()
      .mockRejectedValueOnce(
        new VerityApiError(409, 'Confirmation required', {
          requiresConfirmation: true,
          warnings: ['The project requests an additional capability.'],
        }),
      )
      .mockResolvedValue(project('active'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockCreateClient.mockReturnValue(client({ repairProject }));
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    await waitFor(() => expect(alert).toHaveBeenCalled(), { timeout: 5_000 });
    expect(repairProject).toHaveBeenNthCalledWith(1, 'project-1', { confirmWarnings: false });

    const continueAction = alert.mock.calls[0]?.[2]?.find(({ text }) => text === 'Continue');
    continueAction?.onPress?.();
    await waitFor(() =>
      expect(repairProject).toHaveBeenNthCalledWith(2, 'project-1', { confirmWarnings: true }),
    );
  });

  it('binds Doppler secrets and rebuilds the project before completing setup', async () => {
    const boundSettings = {
      ...unboundSettings,
      dopplerProject: 'website',
      dopplerConfig: 'development',
    };
    const fake = client({
      getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection),
      listDopplerProjects: jest.fn().mockResolvedValue({
        projects: [{ slug: 'website', name: 'Website' }],
      }),
      listDopplerConfigs: jest.fn().mockResolvedValue({
        configs: [{ name: 'development', environment: 'Development', root: '/' }],
      }),
      updateProjectSettings: jest.fn().mockResolvedValue(boundSettings),
      recreateProjectContainer: jest.fn().mockResolvedValue(project('active')),
      getProject: jest
        .fn()
        .mockResolvedValueOnce({
          project: project('active'),
          settings: unboundSettings,
          sessions: [],
        })
        .mockResolvedValue({
          project: project('active'),
          settings: boundSettings,
          sessions: [],
        }),
    });
    mockCreateClient.mockReturnValue(fake);
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Choose Doppler secrets'));
    fireEvent.press(
      await screen.findByLabelText('Doppler project Website', {}, { timeout: 2_000 }),
    );
    fireEvent.press(
      await screen.findByLabelText('Doppler config development', {}, { timeout: 2_000 }),
    );

    await waitFor(() =>
      expect(fake.updateProjectSettings).toHaveBeenCalledWith('project-1', {
        dopplerProject: 'website',
        dopplerConfig: 'development',
      }),
    );
    expect(fake.recreateProjectContainer).toHaveBeenCalledWith('project-1', {
      confirmWarnings: false,
    });
    expect(await screen.findByLabelText('Project setup complete')).toBeOnTheScreen();
    expect(screen.getByLabelText('Project setup progress')).toHaveProp('accessibilityValue', {
      min: 0,
      max: 5,
      now: 5,
      text: 'Project ready',
    });
    fireEvent.press(screen.getByLabelText('Open project'));
    expect(mockReplace).toHaveBeenCalledWith('/project/project-1');
  });

  it('allows finishing setup without project secrets', async () => {
    mockCreateClient.mockReturnValue(
      client({ getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection) }),
    );
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Skip project secrets'));

    expect(await screen.findByLabelText('Project setup complete')).toBeOnTheScreen();
    expect(screen.getByText('Secrets: not connected')).toBeOnTheScreen();
  });

  it('does not finish when saving the skipped-secrets choice fails', async () => {
    mockCreateClient.mockReturnValue(
      client({
        getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection),
        setProjectSetupStatus: jest.fn().mockRejectedValue(new Error('offline')),
      }),
    );
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Skip project secrets'));

    expect(await screen.findByLabelText('Retry saving setup progress')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Project setup complete')).toBeNull();
  });

  it('reports completion when the broker mapping is persisted', async () => {
    const boundSettings = {
      ...unboundSettings,
      dopplerProject: 'website',
      dopplerConfig: 'development',
    };
    mockCreateClient.mockReturnValue(
      client({
        getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection),
        listDopplerProjects: jest.fn().mockResolvedValue({
          projects: [{ slug: 'website', name: 'Website' }],
        }),
        listDopplerConfigs: jest.fn().mockResolvedValue({
          configs: [{ name: 'development', environment: 'Development', root: true }],
        }),
        updateProjectSettings: jest.fn().mockResolvedValue(boundSettings),
        recreateProjectContainer: jest.fn().mockResolvedValue(project('active')),
        getProject: jest
          .fn()
          .mockResolvedValueOnce({
            project: project('active'),
            settings: unboundSettings,
            sessions: [],
          })
          .mockResolvedValue({
            project: project('active'),
            settings: boundSettings,
            sessions: [],
          }),
      }),
    );
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Choose Doppler secrets'));
    fireEvent.press(await screen.findByLabelText('Doppler project Website'));
    fireEvent.press(await screen.findByLabelText('Doppler config development'));

    expect(await screen.findByLabelText('Project setup complete')).toBeOnTheScreen();
  });

  it('offers a retry when broker mapping verification fails', async () => {
    const boundSettings = {
      ...unboundSettings,
      dopplerProject: 'website',
      dopplerConfig: 'development',
    };
    mockCreateClient.mockReturnValue(
      client({
        getDevServerDetection: jest.fn().mockResolvedValue(reviewedDetection),
        listDopplerProjects: jest.fn().mockResolvedValue({
          projects: [{ slug: 'website', name: 'Website' }],
        }),
        listDopplerConfigs: jest.fn().mockResolvedValue({
          configs: [{ name: 'development', environment: 'Development', root: true }],
        }),
        updateProjectSettings: jest.fn().mockResolvedValue(boundSettings),
        recreateProjectContainer: jest.fn().mockResolvedValue(project('active')),
        getProject: jest
          .fn()
          .mockResolvedValueOnce({
            project: project('active'),
            settings: unboundSettings,
            sessions: [],
          })
          .mockRejectedValue(new Error('temporary read failure')),
      }),
    );
    render(<NewProjectScreen />);

    fireEvent.press(await screen.findByLabelText('Create project'));
    fireEvent.press(await screen.findByLabelText('Choose Doppler secrets'));
    fireEvent.press(await screen.findByLabelText('Doppler project Website'));
    fireEvent.press(await screen.findByLabelText('Doppler config development'));

    expect(await screen.findByLabelText('Project secrets need attention')).toBeOnTheScreen();
    expect(screen.getByLabelText('Retry project secrets')).toBeOnTheScreen();
  });
});
