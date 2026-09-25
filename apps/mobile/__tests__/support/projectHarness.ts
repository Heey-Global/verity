// Fixtures for the project settings route suites.
//
// The routes under `app/project/[id]/settings/` each load the same project
// record through `useProjectDetail`, so they share one idea of what a project
// looks like — a fixture that drifts per file is how a screen ends up green
// against a project no server would send. The module mocks (expo-router,
// `lib/client`) come from `settingsHarness`; this file only adds the project.
import type { ProjectDetail, VerityClient } from '@verity/mobile';

/** A neutral project-detail payload. The project is `absent` (paused) so the
 *  Environment screen makes no lifecycle calls on mount. */
export function makeDetail(
  overrides: {
    dopplerProject?: string | null;
    dopplerConfig?: string | null;
    defaultModel?: string | null;
    kind?: 'github' | 'local';
  } = {},
): ProjectDetail {
  return {
    project: {
      id: 'p/1',
      kind: overrides.kind ?? 'github',
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
      defaultModel: overrides.defaultModel ?? null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    sessions: [],
  };
}

/** A current server: reports that it honours `forceRebuild` on recreate-container. */
export const healthWithRebuild = (): jest.Mock =>
  jest
    .fn()
    .mockResolvedValue({ status: 'ok', publicPreviewsEnabled: false, imageRebuildSupported: true });

export type ProjectClientOverrides = {
  detail?: ProjectDetail;
  getHealth?: jest.Mock;
  setProjectSetupStatus?: jest.Mock;
  updateProjectSettings?: jest.Mock;
  listDopplerProjects?: jest.Mock;
  listDopplerConfigs?: jest.Mock;
  deleteProject?: jest.Mock;
  deprovisionProject?: jest.Mock;
  repairProject?: jest.Mock;
  recreateProjectContainer?: jest.Mock;
  listModels?: jest.Mock;
  listAvailableRepositories?: jest.Mock;
  linkProjectToGitHub?: jest.Mock;
  listHttpMcpConnections?: jest.Mock;
  listProjectMcpBindings?: jest.Mock;
  setProjectMcpBinding?: jest.Mock;
};

/**
 * Build a fake client. Only the methods the settings routes call on mount and on
 * the action under test are implemented; the rest throw if touched so an
 * unexpected call surfaces loudly instead of silently no-op'ing.
 */
export function makeClient(opts: ProjectClientOverrides = {}): VerityClient {
  const notImplemented = (name: string) => () => {
    throw new Error(`unexpected client.${name} call`);
  };
  const detail = opts.detail ?? makeDetail();
  return {
    // The default health answer deliberately omits `imageRebuildSupported`, so
    // every test that wants the Rebuild button has to say so via
    // `healthWithRebuild()` — the capability gate is opt-in, like the server's.
    getHealth:
      opts.getHealth ?? jest.fn().mockResolvedValue({ status: 'ok', publicPreviewsEnabled: false }),
    getProject: jest.fn().mockResolvedValue(detail),
    setProjectSetupStatus:
      opts.setProjectSetupStatus ??
      jest.fn().mockResolvedValue({ ...detail.project, setupStatus: 'complete' }),
    updateProjectSettings:
      opts.updateProjectSettings ??
      jest
        .fn()
        .mockImplementation((_id: string, patch: object) =>
          Promise.resolve({ ...detail.settings, ...patch }),
        ),
    listDopplerProjects: opts.listDopplerProjects ?? jest.fn(notImplemented('listDopplerProjects')),
    listDopplerConfigs: opts.listDopplerConfigs ?? jest.fn(notImplemented('listDopplerConfigs')),
    deleteProject: opts.deleteProject ?? jest.fn(notImplemented('deleteProject')),
    deprovisionProject: opts.deprovisionProject ?? jest.fn(notImplemented('deprovisionProject')),
    repairProject: opts.repairProject ?? jest.fn(notImplemented('repairProject')),
    recreateProjectContainer:
      opts.recreateProjectContainer ?? jest.fn(notImplemented('recreateProjectContainer')),
    listModels:
      opts.listModels ??
      jest.fn().mockResolvedValue({
        models: ['claude-sonnet-4-6', 'codex/default', 'deepinfra/zai-org/GLM-5.2'],
        moreModels: ['deepinfra/zai-org/GLM-5.2'],
        default: 'claude-sonnet-4-6',
      }),
    listAvailableRepositories:
      opts.listAvailableRepositories ?? jest.fn(notImplemented('listAvailableRepositories')),
    linkProjectToGitHub: opts.linkProjectToGitHub ?? jest.fn(notImplemented('linkProjectToGitHub')),
    listHttpMcpConnections: opts.listHttpMcpConnections ?? jest.fn().mockResolvedValue([]),
    listProjectMcpBindings: opts.listProjectMcpBindings ?? jest.fn().mockResolvedValue([]),
    setProjectMcpBinding:
      opts.setProjectMcpBinding ?? jest.fn(notImplemented('setProjectMcpBinding')),
    disconnectProjectGoogleDriveFolder: jest.fn(
      notImplemented('disconnectProjectGoogleDriveFolder'),
    ),
  } as unknown as VerityClient;
}
