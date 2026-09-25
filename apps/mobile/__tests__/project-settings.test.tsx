// Smoke tests for the project-detail screen (app/project/[id]/index.tsx): the
// Dev Server / Automations tabs, the runtime status panel, and the gear that
// opens the project settings routes. The settings screens themselves are
// covered in `project-settings-routes.test.tsx`.
//
// The @verity/mobile client is never real: `../../lib/client` is mocked so
// `createVerityClient()` returns an in-memory fake whose methods we control. The
// project is `absent` (inactive) so the Runtime section short-circuits without any
// dev-server calls.
import { type VerityClient, type ProjectDetail } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, AppState } from 'react-native';

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();

// expo-router surfaces the route param + navigation sinks. `Stack.Screen` and
// `Link` render nothing; `useLocalSearchParams` returns a fixed project id.
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  Link: ({ children }: { children?: unknown }) => children ?? null,
  router: { replace: jest.fn(), push: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: () => ({ id: 'p/1' }),
  // The Knowledge tab re-reads the Knowledge model on focus; under test the
  // screen is focused exactly once, on mount.
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    jest.requireActual<typeof import('react')>('react').useEffect(effect, [effect]);
  },
}));

// The screen imports `../../lib/client` (from app/project/[id].tsx); jest.mock
// resolves the specifier relative to THIS test file, where the module is `../lib/client`.
jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

import ProjectDetailScreen from '../app/project/[id]';

const mockRouter = router as unknown as {
  replace: jest.Mock;
  push: jest.Mock;
  dismissTo: jest.Mock;
};

// A neutral project-detail payload. The project is `absent` so the Runtime section
// makes no client calls.
function makeDetail(
  overrides: {
    dopplerProject?: string | null;
    dopplerConfig?: string | null;
  } = {},
): ProjectDetail {
  return {
    project: {
      id: 'p/1',
      kind: 'github',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      imageRef: null,
      state: 'absent',
      provisionError: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      projectId: 'p/1',
      dopplerProject: overrides.dopplerProject ?? null,
      dopplerConfig: overrides.dopplerConfig ?? null,
      defaultBranch: 'main',
      defaultModel: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    sessions: [],
  };
}

// Build a fake client. Only the methods the screen calls for an `absent` project on
// mount + save are implemented; the rest throw if touched so an unexpected call
// surfaces loudly instead of silently no-op'ing.
function makeClient(
  opts: {
    detail?: ProjectDetail;
    setProjectSetupStatus?: jest.Mock;
    updateProjectSettings?: jest.Mock;
    listDopplerProjects?: jest.Mock;
    listDopplerConfigs?: jest.Mock;
    listAgentLoops?: jest.Mock;
    getHealth?: jest.Mock;
    createAgentLoop?: jest.Mock;
    ensureAgentLoopSession?: jest.Mock;
    listDevServers?: jest.Mock;
    detectDevServers?: jest.Mock;
    getDevServerDetection?: jest.Mock;
    setupDetectedDevServers?: jest.Mock;
    createDevServer?: jest.Mock;
    updateDevServer?: jest.Mock;
    deleteDevServer?: jest.Mock;
    startDevServer?: jest.Mock;
    getDevServerStatus?: jest.Mock;
    stopDevServer?: jest.Mock;
    getDevServerLogs?: jest.Mock;
    getDevServerHealth?: jest.Mock;
    listPublicPreviewShares?: jest.Mock;
    createPublicPreviewShare?: jest.Mock;
    stopPublicPreviewShare?: jest.Mock;
    deprovisionProject?: jest.Mock;
    repairProject?: jest.Mock;
    recreateProjectContainer?: jest.Mock;
    deleteProject?: jest.Mock;
  } = {},
): VerityClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`unexpected client.${name} call`);
  };
  // The default health answer below deliberately omits `imageRebuildSupported`;
  // the Rebuild capability gate is exercised in `project-settings-routes.test.tsx`.
  return {
    getHealth:
      opts.getHealth ?? jest.fn().mockResolvedValue({ status: 'ok', publicPreviewsEnabled: false }),
    getProject: jest.fn().mockResolvedValue(opts.detail ?? makeDetail()),
    listProjectIntegrations: jest.fn().mockResolvedValue([]),
    setProjectSetupStatus:
      opts.setProjectSetupStatus ??
      jest.fn().mockImplementation(async () => ({
        ...(opts.detail ?? makeDetail()).project,
        setupStatus: 'complete',
      })),
    updateProjectSettings:
      opts.updateProjectSettings ??
      jest
        .fn()
        .mockImplementation((_id: string, patch) =>
          Promise.resolve({ ...(opts.detail ?? makeDetail()).settings, ...toSaved(patch) }),
        ),
    listDopplerProjects: opts.listDopplerProjects ?? jest.fn(notImplemented('listDopplerProjects')),
    listDopplerConfigs: opts.listDopplerConfigs ?? jest.fn(notImplemented('listDopplerConfigs')),
    listAgentLoops: opts.listAgentLoops ?? jest.fn().mockResolvedValue([]),
    createAgentLoop:
      opts.createAgentLoop ??
      jest.fn().mockResolvedValue({
        id: 'loop-1',
        projectId: 'p/1',
        name: 'New Agent Loop',
        status: 'draft',
        schedule: null,
        script: null,
        reactionPrompt: null,
        reactionModel: null,
        sessionId: 'loop-session-1',
        testedScriptFingerprint: null,
        consecutiveErrorCount: 0,
        lastOutcome: null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ensureAgentLoopSession:
      opts.ensureAgentLoopSession ?? jest.fn(notImplemented('ensureAgentLoopSession')),
    listDevServers: opts.listDevServers ?? jest.fn().mockResolvedValue([]),
    detectDevServers: opts.detectDevServers ?? jest.fn(notImplemented('detectDevServers')),
    getDevServerDetection:
      opts.getDevServerDetection ??
      jest.fn().mockResolvedValue({
        fingerprint: null,
        detectedAt: null,
        reviewedFingerprint: null,
        reviewedAt: null,
        suggestions: [],
      }),
    setupDetectedDevServers:
      opts.setupDetectedDevServers ?? jest.fn(notImplemented('setupDetectedDevServers')),
    createDevServer: opts.createDevServer ?? jest.fn(notImplemented('createDevServer')),
    updateDevServer: opts.updateDevServer ?? jest.fn(notImplemented('updateDevServer')),
    deleteDevServer: opts.deleteDevServer ?? jest.fn(notImplemented('deleteDevServer')),
    startDevServer: opts.startDevServer ?? jest.fn(notImplemented('startDevServer')),
    getDevServerStatus: opts.getDevServerStatus ?? jest.fn(notImplemented('getDevServerStatus')),
    stopDevServer: opts.stopDevServer ?? jest.fn(notImplemented('stopDevServer')),
    getDevServerLogs: opts.getDevServerLogs ?? jest.fn(notImplemented('getDevServerLogs')),
    getDevServerHealth: opts.getDevServerHealth ?? jest.fn(notImplemented('getDevServerHealth')),
    listPublicPreviewShares: opts.listPublicPreviewShares ?? jest.fn().mockResolvedValue([]),
    createPublicPreviewShare:
      opts.createPublicPreviewShare ?? jest.fn(notImplemented('createPublicPreviewShare')),
    stopPublicPreviewShare:
      opts.stopPublicPreviewShare ?? jest.fn(notImplemented('stopPublicPreviewShare')),
    deleteProject: opts.deleteProject ?? jest.fn(notImplemented('deleteProject')),
    deprovisionProject: opts.deprovisionProject ?? jest.fn(notImplemented('deprovisionProject')),
    repairProject: opts.repairProject ?? jest.fn(notImplemented('repairProject')),
    recreateProjectContainer:
      opts.recreateProjectContainer ?? jest.fn(notImplemented('recreateProjectContainer')),
    refreshProjectToken: jest.fn(notImplemented('refreshProjectToken')),
    listModels: jest.fn().mockResolvedValue({
      models: ['claude-sonnet-4-6', 'codex/default', 'deepinfra/zai-org/GLM-5.2'],
      default: 'codex/default',
    }),
  } as unknown as VerityClient;
}

// Reflect a saved PATCH back into a public-settings shape (the token flag flips on
// once a non-empty token is written; the value itself is never echoed back).
function toSaved(patch: { dopplerProject?: string | null; dopplerConfig?: string | null }): {
  dopplerProject?: string | null;
  dopplerConfig?: string | null;
} {
  const saved: {
    dopplerProject?: string | null;
    dopplerConfig?: string | null;
  } = {};
  if (patch.dopplerProject !== undefined) saved.dopplerProject = patch.dopplerProject;
  if (patch.dopplerConfig !== undefined) saved.dopplerConfig = patch.dopplerConfig;
  return saved;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockCreateVerityClient.mockReset();
  mockRouter.replace.mockClear();
  mockRouter.push.mockClear();
  mockRouter.dismissTo.mockClear();
});

describe('ProjectDetailScreen — project settings', () => {
  it('keeps project settings available while setup is pending', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'container_starting', setupStatus: 'pending' },
    };
    const setProjectSetupStatus = jest
      .fn()
      .mockResolvedValue({ ...detail.project, setupStatus: 'complete' });
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, setProjectSetupStatus }));
    render(<ProjectDetailScreen />);

    // The gear is a destination, not a tab: settings live on their own route
    // stack, so a project still provisioning can be configured all the same.
    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/project/[id]/settings',
      params: { id: 'p/1' },
    });
    expect(screen.getByText('Dev Servers')).toBeOnTheScreen();
    await waitFor(() => expect(setProjectSetupStatus).toHaveBeenCalledWith('p/1', 'complete'));
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('renders project tabs after provisioning completes', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'active', setupStatus: 'complete' },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('Dev Servers')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/new-project' }),
    );
  });

  it('keeps Knowledge and legacy Memory out of project settings', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail() }));
    render(<ProjectDetailScreen />);

    // Dev Server is the landing tab and starts with the collection empty.
    expect(await screen.findByText('Dev Servers')).toBeOnTheScreen();
    expect(await screen.findByText('No Dev Server found')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Manual Dev Server setup')).toBeOnTheScreen();
    expect(screen.queryByText('Agent Loops')).toBeNull();
    expect(screen.queryByLabelText('Memory')).toBeNull();

    expect(screen.queryByText('Knowledge')).toBeNull();
    expect(screen.queryByLabelText('Show preserved legacy notes')).toBeNull();

    fireEvent.press(screen.getByText('Automations'));
    expect(await screen.findByText('Agent Loops')).toBeOnTheScreen();
    expect(screen.getByLabelText('Create Agent Loop')).toBeOnTheScreen();
    expect(
      await screen.findByText(
        'No Agent Loops yet. Create one and the setup agent will guide you in its session.',
      ),
    ).toBeOnTheScreen();
  });

  it('creates a Dev Server while the environment is paused and shows its managed port', async () => {
    const created = {
      id: 'ds-1',
      projectId: 'p/1',
      name: 'Web',
      command: 'npm run dev',
      url: 'http://localhost:3000',
      workdir: null,
      hostPort: '3000',
      containerPort: '3000',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const createDevServer = jest.fn().mockResolvedValue(created);
    mockCreateVerityClient.mockReturnValue(makeClient({ createDevServer }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Manual Dev Server setup'));
    fireEvent.changeText(screen.getByLabelText('Name'), 'Web');
    fireEvent.changeText(screen.getByLabelText('Command'), 'npm run dev');
    fireEvent.changeText(screen.getByLabelText('Container port'), '3000');
    fireEvent.press(screen.getByLabelText('Save Dev Server'));

    await waitFor(() =>
      expect(createDevServer).toHaveBeenCalledWith('p/1', {
        name: 'Web',
        command: 'npm run dev',
        url: null,
        workdir: null,
        containerPort: '3000',
        autoStart: true,
      }),
    );
    fireEvent.press(await screen.findByText('Details'));
    expect(await screen.findByText('3000:3000')).toBeOnTheScreen();
  });

  it('opens manual setup without pausing a running environment', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'active' },
    };
    const deprovisionProject = jest.fn();
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, deprovisionProject }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Manual Dev Server setup'));
    expect(await screen.findByLabelText('Save Dev Server')).toBeOnTheScreen();
    expect(screen.getByLabelText('Name')).toBeOnTheScreen();
    expect(deprovisionProject).not.toHaveBeenCalled();
  });

  it('starts a single automatically detected Dev Server with one action', async () => {
    const detail = makeDetail();
    const suggestion = {
      key: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      workdir: null,
      containerPort: '3000',
      confidence: 'high' as const,
      evidence: 'package.json dev script',
      status: 'new' as const,
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    };
    const getDevServerDetection = jest.fn().mockResolvedValue({
      fingerprint: 'detected-1',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: null,
      reviewedAt: null,
      suggestions: [suggestion],
    });
    const setupDetectedDevServers = jest.fn().mockResolvedValue({
      ...detail.project,
      state: 'cloning',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail, getDevServerDetection, setupDetectedDevServers }),
    );
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('Dev Server found')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Start'));
    await waitFor(() =>
      expect(setupDetectedDevServers).toHaveBeenCalledWith('p/1', {
        fingerprint: 'detected-1',
        confirmWarnings: false,
        devServers: [
          {
            sourceKey: '.:dev',
            name: 'Web',
            command: 'npm run dev',
            workdir: null,
            containerPort: '3000',
          },
        ],
      }),
    );
  });

  it('lets you choose which automatically detected Dev Servers to start', async () => {
    const web = {
      key: 'apps/web:dev',
      name: 'Web',
      command: 'pnpm run dev',
      workdir: 'apps/web',
      containerPort: '5173',
      confidence: 'medium' as const,
      evidence: 'Vite dev script',
      status: 'new' as const,
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    };
    const docs = {
      ...web,
      key: 'apps/docs:dev',
      name: 'Docs',
      command: 'pnpm run docs',
      workdir: 'apps/docs',
      containerPort: '3000',
      status: 'changed' as const,
      alreadyConfigured: true,
      existingDevServerId: 'ds-docs',
      existingConfig: {
        name: 'Docs',
        command: 'pnpm run docs:old',
        workdir: 'apps/docs',
        containerPort: '3000',
      },
    };
    const detection = {
      fingerprint: 'detected-1',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: null,
      reviewedAt: null,
      suggestions: [web, docs],
    };
    const getDevServerDetection = jest.fn().mockResolvedValue(detection);
    const setupDetectedDevServers = jest.fn().mockResolvedValue(makeDetail().project);
    mockCreateVerityClient.mockReturnValue(
      makeClient({ getDevServerDetection, setupDetectedDevServers }),
    );
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('2 Dev Servers found')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Choose'));
    expect(await screen.findByText('Detected Dev Servers')).toBeOnTheScreen();
    fireEvent.press(screen.getByLabelText('Select detected Dev Server Web'));
    fireEvent.press(screen.getByLabelText('Create selected Dev Servers'));

    await waitFor(() =>
      expect(setupDetectedDevServers).toHaveBeenCalledWith('p/1', {
        fingerprint: 'detected-1',
        confirmWarnings: false,
        devServers: [
          {
            sourceKey: 'apps/docs:dev',
            name: 'Docs',
            command: 'pnpm run docs',
            workdir: 'apps/docs',
            containerPort: '3000',
          },
        ],
      }),
    );
  });

  it('suppresses the automatic Review count for an already reviewed fingerprint', async () => {
    const getDevServerDetection = jest.fn().mockResolvedValue({
      fingerprint: 'same',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: 'same',
      reviewedAt: '2026-07-15T12:01:00.000Z',
      suggestions: [
        {
          key: '.:dev',
          name: 'Web',
          command: 'npm run dev',
          workdir: null,
          containerPort: '5173',
          confidence: 'medium',
          evidence: 'Vite',
          status: 'new',
          alreadyConfigured: false,
          existingDevServerId: null,
          existingConfig: null,
        },
      ],
    });
    mockCreateVerityClient.mockReturnValue(makeClient({ getDevServerDetection }));
    render(<ProjectDetailScreen />);

    await waitFor(() => expect(getDevServerDetection).toHaveBeenCalledWith('p/1'));
    expect(screen.getByText('No Dev Server found')).toBeOnTheScreen();
    expect(screen.queryByText('Detected Dev Servers')).not.toBeOnTheScreen();
  });

  it('ignores an older automatic detection response after the app becomes active', async () => {
    let resolveFirst!: (value: ReturnTypePayload) => void;
    let resolveSecond!: (value: ReturnTypePayload) => void;
    type ReturnTypePayload = Awaited<ReturnType<VerityClient['getDevServerDetection']>>;
    const first = new Promise<ReturnTypePayload>((resolve) => (resolveFirst = resolve));
    const second = new Promise<ReturnTypePayload>((resolve) => (resolveSecond = resolve));
    const getDevServerDetection = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    let onAppStateChange: ((state: string) => void) | undefined;
    const appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        onAppStateChange = listener as (state: string) => void;
        return { remove: jest.fn() };
      });
    mockCreateVerityClient.mockReturnValue(makeClient({ getDevServerDetection }));
    render(<ProjectDetailScreen />);

    await waitFor(() => expect(getDevServerDetection).toHaveBeenCalledTimes(1));
    act(() => onAppStateChange?.('active'));
    const changed = {
      key: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      workdir: null,
      containerPort: '5173',
      confidence: 'medium' as const,
      evidence: 'Vite',
      status: 'new' as const,
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    };
    await act(async () =>
      resolveSecond({
        fingerprint: 'newer',
        detectedAt: '2026-07-15T12:01:00.000Z',
        reviewedFingerprint: null,
        reviewedAt: null,
        suggestions: [changed],
      }),
    );
    expect(await screen.findByText('Dev Server found')).toBeOnTheScreen();
    await act(async () =>
      resolveFirst({
        fingerprint: 'older',
        detectedAt: '2026-07-15T12:00:00.000Z',
        reviewedFingerprint: 'older',
        reviewedAt: '2026-07-15T12:00:00.000Z',
        suggestions: [],
      }),
    );
    expect(screen.getByText('Dev Server found')).toBeOnTheScreen();
    appStateSpy.mockRestore();
  });

  it('does not let an AppState refresh cancel an explicit review', async () => {
    const suggestion = {
      key: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      workdir: null,
      containerPort: '5173',
      confidence: 'medium' as const,
      evidence: 'Vite',
      status: 'new' as const,
      alreadyConfigured: false,
      existingDevServerId: null,
      existingConfig: null,
    };
    const result = {
      fingerprint: 'automatic',
      detectedAt: '2026-07-15T12:00:00.000Z',
      reviewedFingerprint: null,
      reviewedAt: null,
      suggestions: [suggestion, { ...suggestion, key: 'docs:dev', name: 'Docs' }],
    };
    let resolveManual!: (value: typeof result) => void;
    const manual = new Promise<typeof result>((resolve) => (resolveManual = resolve));
    const getDevServerDetection = jest
      .fn()
      .mockResolvedValueOnce(result)
      .mockReturnValueOnce(manual);
    let onAppStateChange: ((state: string) => void) | undefined;
    const appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        onAppStateChange = listener as (state: string) => void;
        return { remove: jest.fn() };
      });
    mockCreateVerityClient.mockReturnValue(makeClient({ getDevServerDetection }));
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('2 Dev Servers found')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Choose'));
    await waitFor(() => expect(getDevServerDetection).toHaveBeenCalledTimes(2));
    act(() => onAppStateChange?.('active'));
    expect(getDevServerDetection).toHaveBeenCalledTimes(2);
    await act(async () => resolveManual(result));
    expect(await screen.findByText('Detected Dev Servers')).toBeOnTheScreen();
    appStateSpy.mockRestore();
  });

  it('controls each active Dev Server through its ID-scoped runtime API', async () => {
    const base = makeDetail();
    const detail = { ...base, project: { ...base.project, state: 'active' as const } };
    const server = {
      id: 'ds-web',
      projectId: 'p/1',
      name: 'Web',
      command: 'npm run dev',
      url: null,
      workdir: null,
      hostPort: '3000',
      containerPort: '3000',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const getDevServerStatus = jest.fn().mockResolvedValue({
      projectId: 'p/1',
      url: null,
      running: false,
      pid: null,
    });
    const startDevServer = jest.fn().mockResolvedValue({
      projectId: 'p/1',
      url: null,
      running: true,
      pid: '123',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail,
        listDevServers: jest.fn().mockResolvedValue([server]),
        getDevServerStatus,
        startDevServer,
      }),
    );
    render(<ProjectDetailScreen />);

    const start = await screen.findByLabelText('Start Web');
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.press(start);

    await waitFor(() => expect(startDevServer).toHaveBeenCalledWith('ds-web'));
    fireEvent.press(screen.getByText('Details'));
    const edit = screen.getByLabelText('Advanced settings for Web');
    expect(edit).not.toBeDisabled();
    expect(screen.getByText('Advanced')).toBeOnTheScreen();
    expect(screen.getByLabelText('Manual Dev Server setup')).not.toBeDisabled();

    fireEvent.press(edit);
    expect(await screen.findByText('Edit Dev Server')).toBeOnTheScreen();
    expect(screen.getByLabelText('Name')).toHaveProp('value', 'Web');
  });

  it('names the inherited project permissions beside external sharing', async () => {
    const base = makeDetail();
    const detail = { ...base, project: { ...base.project, state: 'active' as const } };
    const server = {
      id: 'ds-web',
      projectId: 'p/1',
      name: 'Web',
      command: 'npm run dev',
      url: null,
      workdir: null,
      hostPort: '3000',
      containerPort: '3000',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail,
        getHealth: jest.fn().mockResolvedValue({ status: 'ok', publicPreviewsEnabled: true }),
        listDevServers: jest.fn().mockResolvedValue([server]),
        getDevServerStatus: jest.fn().mockResolvedValue({
          projectId: 'p/1',
          url: null,
          running: true,
          pid: '123',
        }),
      }),
    );
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('External sharing')).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Public traffic reaches this project sandbox. A compromised dev server can use the sandbox's project-scoped broker and gateway permissions.",
      ),
    ).toBeOnTheScreen();
  });

  it('blocks deletion while a runtime mutation is in flight', async () => {
    const base = makeDetail();
    const detail = { ...base, project: { ...base.project, state: 'active' as const } };
    const server = {
      id: 'ds-race',
      projectId: 'p/1',
      name: 'Web',
      command: 'npm run dev',
      url: null,
      workdir: null,
      hostPort: '3000',
      containerPort: '3000',
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    let finishStart!: (value: {
      projectId: string;
      url: null;
      running: boolean;
      pid: string;
    }) => void;
    const startDevServer = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        finishStart = resolve;
      }),
    );
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail,
        listDevServers: jest.fn().mockResolvedValue([server]),
        getDevServerStatus: jest.fn().mockResolvedValue({
          projectId: 'p/1',
          url: null,
          running: false,
          pid: null,
        }),
        startDevServer,
      }),
    );
    render(<ProjectDetailScreen />);

    const start = await screen.findByLabelText('Start Web');
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.press(start);
    await waitFor(() => expect(startDevServer).toHaveBeenCalledWith('ds-race'));
    fireEvent.press(screen.getByText('Details'));
    expect(screen.getByLabelText('Delete Web')).toBeDisabled();

    await act(async () => finishStart({ projectId: 'p/1', url: null, running: true, pid: '123' }));
    await waitFor(() => expect(screen.getByLabelText('Delete Web')).not.toBeDisabled());
  });

  it('does not show a stale provision error while the environment is starting', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'container_starting',
        setupStatus: 'complete',
        provisionError: 'A previous provisioning attempt failed.',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    expect(await screen.findByText('Starting secure workspace…')).toBeOnTheScreen();
    expect(screen.queryByText('A previous provisioning attempt failed.')).toBeNull();
    expect(screen.getByText(/continues in the background/)).toBeOnTheScreen();
  });

  it('shows persisted Agent Loops in the Automations tab', async () => {
    const listAgentLoops = jest.fn().mockResolvedValue([
      {
        id: 'loop-1',
        projectId: 'p/1',
        name: 'Dependency audit',
        status: 'draft',
        schedule: { kind: 'interval', everyMinutes: 30 },
        script: 'exit 0',
        reactionPrompt: null,
        reactionModel: null,
        sessionId: 'loop-session-1',
        testedScriptFingerprint: null,
        consecutiveErrorCount: 0,
        lastOutcome: null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail(), listAgentLoops }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Automations'));
    expect(await screen.findByText('Dependency audit')).toBeOnTheScreen();
    expect(screen.getByText('Every 30 minutes')).toBeOnTheScreen();
    expect(screen.getByText('Setup')).toBeOnTheScreen();
  });

  it('recreates a deleted Agent Loop session before opening it', async () => {
    const loop = {
      id: 'loop-1',
      projectId: 'p/1',
      name: 'Dependency audit',
      status: 'paused',
      schedule: { kind: 'interval', everyMinutes: 30 },
      script: 'exit 0',
      reactionPrompt: null,
      reactionModel: null,
      sessionId: null,
      testedScriptFingerprint: null,
      consecutiveErrorCount: 0,
      lastOutcome: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const ensureAgentLoopSession = jest
      .fn()
      .mockResolvedValue({ ...loop, sessionId: 'replacement-session' });
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail: makeDetail(),
        listAgentLoops: jest.fn().mockResolvedValue([loop]),
        ensureAgentLoopSession,
      }),
    );
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Automations'));
    fireEvent.press(await screen.findByLabelText('Open Agent Loop Dependency audit'));

    await waitFor(() => expect(ensureAgentLoopSession).toHaveBeenCalledWith('loop-1'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/session/[id]',
      params: { id: 'replacement-session' },
    });
  });

  it('creates an Agent Loop and opens its dedicated setup session', async () => {
    const createAgentLoop = jest.fn().mockResolvedValue({ sessionId: 'loop-session-1' });
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail(), createAgentLoop }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Agent Loop')?.onPress?.();
    });
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Automations'));
    fireEvent.press(await screen.findByLabelText('Create Agent Loop'));

    await waitFor(() =>
      expect(createAgentLoop).toHaveBeenCalledWith('p/1', { name: 'New Agent Loop' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/session/[id]',
      params: { id: 'loop-session-1' },
    });
    alert.mockRestore();
  });
});
