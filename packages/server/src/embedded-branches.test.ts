import { expect, it, vi } from 'vitest';
import { createEmbeddedBranches } from './embedded-branches.js';
import { createDockerClient, type DockerClient } from './docker.js';

it('defers runtime reads until a branch operation and observes later initialization', async () => {
  const runtime: { docker?: DockerClient } = {};
  const readDocker = vi.fn(() => runtime.docker);
  const listSessions = vi.fn(async () => []);
  const branches = createEmbeddedBranches(
    { hostCloneRoot: '/clones', dockerBaseUrl: 'http://docker.test' },
    {
      listSessions,
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
  expect(listSessions).not.toHaveBeenCalled();

  runtime.docker = createDockerClient({ baseUrl: 'http://docker.test' });
  await expect(branches!.worktreeFingerprint!('/clones/session')).rejects.toThrow(
    'Git requires persistent session context',
  );
  expect(listSessions).toHaveBeenCalledOnce();
});
