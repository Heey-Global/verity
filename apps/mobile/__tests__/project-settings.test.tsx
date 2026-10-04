// Project tool screens for Dev Servers and Automations. The settings screens are
// covered in `project-settings-routes.test.tsx`.
//
// The client is an in-memory fake whose methods each test controls.
import { type VerityClient, type ProjectDetail } from '@verity/mobile';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, AppState } from 'react-native';

const mockCreateVerityClient = jest.fn<VerityClient | null, []>();

// Expo Router exposes a fixed project id and records navigation destinations.
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: unknown }) => {
    jest.requireMock<typeof import('expo-router')>('expo-router').router.replace(href as never);
    return null;
  },
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

jest.mock('../lib/client', () => ({
  createVerityClient: () => mockCreateVerityClient(),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

import ProjectEntry from '../app/project/[id]';
import ProjectAutomationsScreen from '../app/project/[id]/automations';

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

it('opens project settings directly from the project entry route', () => {
  render(<ProjectEntry />);
  expect(mockRouter.replace).toHaveBeenCalledWith({
    pathname: '/project/[id]/settings',
    params: { id: 'p/1' },
  });
});

describe('Project tools', () => {
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
    render(<ProjectAutomationsScreen />);
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
    render(<ProjectAutomationsScreen />);
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
    render(<ProjectAutomationsScreen />);
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
