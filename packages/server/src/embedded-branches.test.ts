import { expect, it, vi } from 'vitest';
import { createEmbeddedBranches } from './embedded-branches.js';
import { createDockerClient, type DockerClient } from './docker.js';
import { QuerySandboxDeclined, withoutQuerySandbox } from './query-sandbox-policy.js';

it('defers runtime reads until a branch operation and observes later initialization', async () => {
  const runtime: { docker?: DockerClient } = {};
  const readDocker = vi.fn(() => runtime.docker);
  const getSessionByWorktree = vi.fn(async () => undefined);
  const branches = createEmbeddedBranches(
    { hostCloneRoot: '/clones', dockerBaseUrl: 'http://docker.test' },
    {
      getSessionByWorktree,
      getSession: async () => undefined,
      getProject: async () => undefined,
      sessionRepositoryWorkspaceSessionId: async () => undefined,
    },
    {
      get projectDocker() {
        return readDocker();
      },
      get defaultProjectImage(): string {
        throw new Error('image is not initialized');
      },
      get dataVolumeRoot(): string | undefined {
        throw new Error('volume is not initialized');
      },
    },
  );

  // Bootstrap constructs this service before Docker, image and volume bindings exist.
  expect(readDocker).not.toHaveBeenCalled();
  await expect(branches!.worktreeFingerprint!('/clones/session')).rejects.toThrow(
    'Project Docker runtime is unavailable',
  );
  expect(getSessionByWorktree).not.toHaveBeenCalled();

  runtime.docker = createDockerClient({ baseUrl: 'http://docker.test' });
  await expect(branches!.worktreeFingerprint!('/clones/session')).rejects.toThrow(
    'Git requires persistent session context',
  );
  expect(getSessionByWorktree).toHaveBeenCalledWith('/clones/session');
});

// Each declined read used to create, start and remove one throwaway container.
it('declines a background read against a sleeping sandbox before creating a container', async () => {
  const createContainer = vi.fn();
  const docker = {
    inspectContainer: vi.fn(async () => ({ running: false, image: 'sandbox' })),
    createContainer,
  } as unknown as DockerClient;
  const branches = createEmbeddedBranches(
    { hostCloneRoot: '/clones', dockerBaseUrl: 'http://docker.test' },
    {
      getSessionByWorktree: async () => ({ sessionId: 's', projectId: 'p' }) as never,
      getSession: async () => undefined,
      getProject: async () =>
        ({ id: 'p', kind: 'github', containerName: 'sandbox-p', owner: 'o', repo: 'r' }) as never,
      sessionRepositoryWorkspaceSessionId: async () => undefined,
    },
    { projectDocker: docker, defaultProjectImage: 'image', dataVolumeRoot: undefined },
  );

  await expect(
    withoutQuerySandbox(() => branches!.current('/clones/p/session')),
  ).rejects.toBeInstanceOf(QuerySandboxDeclined);
  expect(createContainer).not.toHaveBeenCalled();
});
