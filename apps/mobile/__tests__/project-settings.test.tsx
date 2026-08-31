// Smoke tests for the per-project Settings tab on the project-detail screen
// (app/project/[id].tsx): the tab layout (Dev Server / Memory / Automations /
// Settings), the shared-form autosave behaviour, and the Doppler binding. The
// per-project manual Doppler token entry was removed — resolution is brokered centrally — so a
// normal save must never emit a `dopplerToken` key. The pure draft→patch rules are
// unit-tested in packages/mobile (vitest); here we only assert the screen wires
// them into the rendered tree.
//
// The @verity/mobile client is never real: `../../lib/client` is mocked so
// `createVerityClient()` returns an in-memory fake whose methods we control. The
// project is `absent` (inactive) so the Runtime section short-circuits without any
// dev-server calls.
import { type VerityClient, type ProjectDetail, type ProjectSettings } from '@verity/mobile';
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

// A current server: reports that it honours `forceRebuild` on recreate-container.
const healthWithRebuild = (): jest.Mock =>
  jest
    .fn()
    .mockResolvedValue({ status: 'ok', publicPreviewsEnabled: false, imageRebuildSupported: true });

// Build a fake client. Only the methods the screen calls for an `absent` project on
// mount + save are implemented; the rest throw if touched so an unexpected call
// surfaces loudly instead of silently no-op'ing.
function makeClient(
  opts: {
    detail?: ProjectDetail;
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
  // The default health answer below deliberately omits `imageRebuildSupported`,
  // so every test that wants the Rebuild button has to say so via
  // `healthWithRebuild()` — the capability gate is opt-in, like the server's.
  return {
    getHealth:
      opts.getHealth ?? jest.fn().mockResolvedValue({ status: 'ok', publicPreviewsEnabled: false }),
    getProject: jest.fn().mockResolvedValue(opts.detail ?? makeDetail()),
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
  it('routes pending projects into the unified setup flow without rendering controls', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'container_starting', setupStatus: 'pending' },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    expect(await screen.findByLabelText('Opening project setup')).toBeOnTheScreen();
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/new-project',
      params: { projectId: 'p/1' },
    });
    expect(screen.queryByText('Dev Servers')).toBeNull();
    expect(screen.queryByLabelText('Project settings')).toBeNull();
  });

  it('renders normal project tabs after guided setup is complete', async () => {
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

  it('separates dev server, memory, automations, and settings', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail() }));
    render(<ProjectDetailScreen />);

    // Dev Server is the landing tab and starts with the collection empty.
    expect(await screen.findByText('Dev Servers')).toBeOnTheScreen();
    expect(await screen.findByText('No Dev Server found')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Manual Dev Server setup')).toBeOnTheScreen();
    expect(screen.queryByText('Agent Loops')).toBeNull();
    expect(screen.queryByLabelText('Memory')).toBeNull();

    fireEvent.press(await screen.findByText('Memory'));
    expect(await screen.findByLabelText('Memory')).toBeOnTheScreen();

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

  it('shows a running environment with a Pause action and an update affordance', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        sandboxUpdate: {
          state: 'available',
          kind: 'normal',
          category: 'software',
          reason: null,
          current: null,
          target: null,
          currentVersion: '1.22.1',
          currentRevision: null,
          targetVersion: '2.9.2',
          targetRevision: null,
          selfRepair: 'converging',
        },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByText('Project setup')).toBeOnTheScreen();
    expect(screen.getByText('Environment')).toBeOnTheScreen();
    expect(screen.getByText('Secrets')).toBeOnTheScreen();
    expect(screen.getByText('Project information')).toBeOnTheScreen();
    expect(screen.queryByText('Container')).toBeNull();
    expect(await screen.findByLabelText('Running')).toBeOnTheScreen();
    expect(screen.getByLabelText('Pause project')).toBeOnTheScreen();
    // The slim update row appears only because an update is available.
    expect(screen.getByLabelText('Update project environment')).toBeOnTheScreen();
    // Reads as reassurance, not as a fault: while Verity is still rebuilding the
    // sandbox the row says so, and the manual Update stays available anyway.
    expect(
      screen.getByText('Update pending — Verity is rebuilding this sandbox'),
    ).toBeOnTheScreen();
  });

  // The Environment panel is where Start/Repair/Update live, so the finding and
  // the action that answers it are on the same surface. `ProjectFields` at the
  // bottom keeps its own copy as the detail view.
  it('explains toolkit drift next to the environment actions', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'drifted', carrier: 'devcontainer' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(
      await screen.findByText(/attestation verdict no longer holds and needs re-checking/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/rebuilds and re-attests it/)).toBeOnTheScreen();
  });

  // A base-image project must not be told to repair its way out of this: only a
  // rebuilt base image changes what that image contains.
  it('does not promise a rebuild for a base-image project', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'drifted', carrier: 'base-image' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByText(/only a rebuilt base image fixes it/)).toBeOnTheScreen();
  });

  it('stays silent when the recorded toolkit matches', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        toolkitDrift: { verdict: 'matches', carrier: 'devcontainer' },
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByText('Project setup')).toBeOnTheScreen();
    expect(screen.queryByText(/needs re-checking/)).toBeNull();
  });

  // Moved out of the "Project information" facts list and up into the Environment
  // panel: the warning now sits beside Start/Repair/Update instead of below the
  // fold, and appears exactly once on the screen.
  it('surfaces a project provision warning beside the environment actions', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        provisionWarning: 'Runner supervisor is disabled after boundary attestation failed.',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(
      await screen.findByText('Runner supervisor is disabled after boundary attestation failed.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Provision warning')).toBeNull();
  });

  it('shows a rebuilding status instead of Running during an image rebuild', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        provisionWarning: 'Project image rebuild is in progress.',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Rebuilding…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Running')).toBeNull();
  });

  // The pill reads from the shared `projectBadge`, so it names the container state
  // the same way the overview dot does — and never falls back to the raw state id
  // (it used to render a literal "container_starting" at the operator).
  it('offers Start for a paused environment and hides the update row', async () => {
    // The default fixture is `absent` (paused) with no sandbox update.
    mockCreateVerityClient.mockReturnValue(makeClient({ detail: makeDetail() }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Paused')).toBeOnTheScreen();
    expect(screen.getByLabelText('Start project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Update project environment')).toBeNull();
  });

  it('offers Repair for a failed environment', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = { ...base, project: { ...base.project, state: 'failed' } };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Needs repair')).toBeOnTheScreen();
    expect(screen.getByLabelText('Repair project')).toBeOnTheScreen();
  });

  it('offers Repair while an environment is starting', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: { ...base.project, state: 'container_starting', setupStatus: 'complete' },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Starting…')).toBeOnTheScreen();
    expect(screen.queryByLabelText('container_starting')).toBeNull();
    expect(screen.getByLabelText('Repair project')).toBeOnTheScreen();
  });

  // The escape hatch for a devcontainer change the image cache cannot see:
  // Update and Repair both reuse the content-hash-cached tag, so only this
  // action rebuilds. It has to reach the server as an explicit `forceRebuild`,
  // otherwise it is just another Repair.
  it('rebuilds the image without the build cache when asked to', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    const recreateProjectContainer = jest.fn().mockResolvedValue(detail.project);
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail, recreateProjectContainer, getHealth: healthWithRebuild() }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Rebuild')?.onPress?.();
    });
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    fireEvent.press(await screen.findByLabelText('Rebuild project image'));

    await waitFor(() =>
      expect(recreateProjectContainer).toHaveBeenCalledWith('p/1', {
        confirmWarnings: true,
        forceRebuild: true,
      }),
    );
    expect(alert.mock.calls[0][0]).toBe('Rebuild image?');
    alert.mockRestore();
  });

  // The canonical reason to want a cacheless rebuild: the project built once and
  // now fails. `imageRef` names the last SUCCESSFUL provision and survives a
  // failed one, so the action has to still be there in that state.
  it('offers the rebuild action for a failed project that built once', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'failed',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, getHealth: healthWithRebuild() }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Repair project')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Rebuild project image')).toBeOnTheScreen();
  });

  // A project running the pulled sandbox image has no build of its own to redo,
  // and a paused one has no container the server would accept a recreate for.
  it('hides the rebuild action for a base-image project and while paused', async () => {
    const base = makeDetail();
    const pulled: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'ghcr.io/heey-global/verity-sandbox@sha256:abc',
      },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: pulled, getHealth: healthWithRebuild() }),
    );
    const view = render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Pause project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
    view.unmount();

    const paused: ProjectDetail = {
      ...base,
      project: { ...base.project, imageRef: 'verity-devc-heey-global-verity:0123456789ab' },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({ detail: paused, getHealth: healthWithRebuild() }),
    );
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Start project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
  });

  // The app ships on its own release train, and the server's recreate body schema
  // is non-strict: an older server would STRIP `forceRebuild` and recreate from
  // the cached image, so the operator would wait out a rebuild that rebuilt
  // nothing. Hide the action until the server says it honours the flag.
  it('hides the rebuild action from a server that does not report the capability', async () => {
    const base = makeDetail();
    const detail: ProjectDetail = {
      ...base,
      project: {
        ...base.project,
        state: 'active',
        imageRef: 'verity-devc-heey-global-verity:0123456789ab',
      },
    };
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail,
        // An older server: liveness only, no capability keys at all.
        getHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
      }),
    );
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByLabelText('Pause project')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Rebuild project image')).toBeNull();
  });

  it('saves Memory without writing legacy Dev Server settings', async () => {
    // Regression: the shared form is lifted above the loading gate, so its draft
    // must repopulate from settings once they load. If it stayed on its empty
    // initial seed, configured fields would render blank AND a save of one field
    // would PATCH every other field to null.
    const base = makeDetail();
    if (base.settings === null) throw new Error('expected project settings fixture');
    const detail: ProjectDetail = {
      ...base,
      settings: { ...base.settings, memory: 'Remember the docs' },
    };
    const updateProjectSettings = jest.fn().mockResolvedValue(detail.settings);
    mockCreateVerityClient.mockReturnValue(makeClient({ detail, updateProjectSettings }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Memory'));
    expect(await screen.findByDisplayValue('Remember the docs')).toBeOnTheScreen();

    fireEvent.changeText(screen.getByLabelText('Memory'), 'Updated note');
    fireEvent(screen.getByLabelText('Memory'), 'blur');
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    const [, patch] = updateProjectSettings.mock.calls[0];
    expect(patch.memory).toBe('Updated note');
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

  // `replace` here swapped this screen for `/` while the home it was opened from
  // stayed below it, so the overview came back carrying a back button to itself —
  // the "‹ Verity" on the top left of the project list. Popping to the existing
  // home is the whole fix, so the assertion is on which router verb runs.
  it('pops back to the existing overview after deleting a project', async () => {
    const deleteProject = jest.fn().mockResolvedValue({ projectId: 'p/1' });
    mockCreateVerityClient.mockReturnValue(makeClient({ deleteProject }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    fireEvent.press(await screen.findByLabelText('Delete project'));

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('p/1'));
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/'));
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/');
    alert.mockRestore();
  });

  // The server deletes a project's sessions along with it, so the confirmation
  // must not promise the operator that they survive somewhere in the list.
  it('warns that the project sessions go with the project', async () => {
    mockCreateVerityClient.mockReturnValue(makeClient({}));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    fireEvent.press(await screen.findByLabelText('Delete project'));

    const [title, message] = alert.mock.calls[0];
    expect(title).toBe('Delete project?');
    expect(message).toContain('sessions and their history');
    expect(message).not.toContain('stay in the list');
    alert.mockRestore();
  });

  it('saves an edited field without ever emitting a Doppler token key', async () => {
    // The per-project manual Doppler token entry was removed (resolution is brokered centrally),
    // so a normal settings save must never carry a `dopplerToken` key.
    const updateProjectSettings = jest.fn().mockResolvedValue(makeDetail().settings);
    mockCreateVerityClient.mockReturnValue(makeClient({ updateProjectSettings }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Memory'));
    fireEvent.changeText(await screen.findByLabelText('Memory'), 'Keep docs current');
    fireEvent(screen.getByLabelText('Memory'), 'blur');

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    // Await the post-save re-render (onSaved → setDetail → reseed draft) so the
    // trailing state update lands inside act rather than after the assertions.
    expect(await screen.findByText(/All changes saved/)).toBeOnTheScreen();
    const [, patch] = updateProjectSettings.mock.calls[0];
    expect(patch).not.toHaveProperty('dopplerToken');
    expect(patch.memory).toBe('Keep docs current');
  });

  it('preserves edits made while an earlier auto-save is in flight', async () => {
    let resolveFirst: (settings: ProjectSettings) => void = () => undefined;
    const firstSave = new Promise<ProjectSettings>((resolve) => {
      resolveFirst = resolve;
    });
    const initial = makeDetail().settings;
    if (initial === null) throw new Error('expected project settings fixture');
    const updateProjectSettings = jest
      .fn()
      .mockReturnValueOnce(firstSave)
      .mockResolvedValueOnce({ ...initial, memory: 'Keep docs current' });
    mockCreateVerityClient.mockReturnValue(makeClient({ updateProjectSettings }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByText('Memory'));
    const box = await screen.findByLabelText('Memory');
    fireEvent.changeText(box, 'Draft one');
    fireEvent(box, 'blur');
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));

    // Type a newer value while the first save is still airborne, then let the
    // stale first response land. The in-flight merge must keep the newer text.
    fireEvent.changeText(box, 'Keep docs current');
    fireEvent(box, 'blur');
    await act(async () => resolveFirst({ ...initial, memory: 'Draft one' }));

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(2));
    expect(updateProjectSettings.mock.calls[1]?.[1]).toMatchObject({
      memory: 'Keep docs current',
    });
    expect(screen.getByDisplayValue('Keep docs current')).toBeOnTheScreen();
  });
});

describe('ProjectDetailScreen — Doppler binding picker (#320)', () => {
  it('lists projects, then configs, then PATCHes { dopplerProject, dopplerConfig }', async () => {
    const listDopplerProjects = jest
      .fn()
      .mockResolvedValue({ projects: [{ slug: 'acme-app', name: 'Acme App' }] });
    const listDopplerConfigs = jest
      .fn()
      .mockResolvedValue({ configs: [{ name: 'dev', environment: 'dev', root: true }] });
    const updateProjectSettings = jest.fn().mockResolvedValue({
      ...makeDetail().settings,
      dopplerProject: 'acme-app',
      dopplerConfig: 'dev',
    });
    mockCreateVerityClient.mockReturnValue(
      makeClient({ listDopplerProjects, listDopplerConfigs, updateProjectSettings }),
    );
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    // Open the picker → project list loads.
    fireEvent.press(await screen.findByLabelText('Choose Doppler binding'));
    fireEvent.press(await screen.findByLabelText('Doppler project Acme App'));
    await waitFor(() => expect(listDopplerConfigs).toHaveBeenCalledWith('acme-app'));

    // Pick a config → PATCH lands with the binding.
    fireEvent.press(await screen.findByLabelText('Doppler config dev'));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    const [, patch] = updateProjectSettings.mock.calls[0];
    expect(patch).toEqual({ dopplerProject: 'acme-app', dopplerConfig: 'dev' });
  });

  it('shows the account-token hint when the list is not configured', async () => {
    const listDopplerProjects = jest.fn().mockResolvedValue({ error: 'not configured' });
    mockCreateVerityClient.mockReturnValue(makeClient({ listDopplerProjects }));
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    fireEvent.press(await screen.findByLabelText('Choose Doppler binding'));
    expect(
      await screen.findByText(/Set the Doppler account token in onboarding/),
    ).toBeOnTheScreen();
  });

  it('renders the current binding and a "Change" control when already bound', async () => {
    mockCreateVerityClient.mockReturnValue(
      makeClient({
        detail: makeDetail({
          dopplerProject: 'acme-app',
          dopplerConfig: 'dev',
        }),
      }),
    );
    render(<ProjectDetailScreen />);

    fireEvent.press(await screen.findByLabelText('Project settings'));
    expect(await screen.findByText('acme-app / dev')).toBeOnTheScreen();
    expect(screen.getByLabelText('Change Doppler binding')).toBeOnTheScreen();
    expect(screen.getByText('Mapped')).toBeOnTheScreen();
  });
});
