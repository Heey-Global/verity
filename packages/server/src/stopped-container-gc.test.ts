import { describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import type { DockerClient, DockerContainerSummary, DockerImageSummary } from './docker.js';
import {
  retireCompletedUpdateContainers,
  retireStoppedContainers,
} from './stopped-container-gc.js';

const now = Date.parse('2026-10-30T12:00:00Z');
const project = {
  id: 'p',
  containerName: 'verity-p',
  state: 'sleeping',
  imageOverrideRef: null,
} as ProjectRecord;
function fixture() {
  const sandbox: DockerContainerSummary = {
    id: 'sandbox',
    names: ['verity-p'],
    imageId: 'old',
    state: 'exited',
    created: 1,
    labels: { 'verity.project-id': 'p', 'verity.container-generation': 'g' },
  };
  const images = [
    {
      id: 'old',
      repoTags: ['ghcr.io/heey-global/verity/verity-sandbox:old'],
      repoDigests: [],
      created: 1,
      labels: {},
      size: 1,
    },
    {
      id: 'new',
      repoTags: ['ghcr.io/heey-global/verity/verity-sandbox:new'],
      repoDigests: [],
      created: 2,
      labels: {},
      size: 1,
    },
  ] as DockerImageSummary[];
  const containers = [sandbox];
  const docker = {
    listContainers: vi.fn(async () => containers),
    listImages: vi.fn(async () => images),
    inspectContainer: vi.fn(async (id: string) => ({
      id,
      running: false,
      status: 'exited',
      imageId: 'old',
      finishedAt: new Date(now - 2 * 86400000).toISOString(),
      exitCode: 0,
    })),
    removeStoppedContainer: vi.fn(async () => {}),
    removeContainer: vi.fn(),
  };
  const input = {
    docker: docker as unknown as DockerClient,
    listProjects: async () => [project],
    withProjectMutation: vi.fn(async (_: string, run: () => Promise<void>) => run()),
    now,
  };
  return { docker, containers, sandbox, input };
}
describe('stopped container retirement', () => {
  it('retires outdated stopped sandboxes under the lifecycle gate without force or volumes', async () => {
    const f = fixture();
    expect((await retireStoppedContainers(f.input)).removed).toEqual(['verity-p']);
    expect(f.input.withProjectMutation).toHaveBeenCalledOnce();
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledWith('sandbox');
    expect(f.docker.removeContainer).not.toHaveBeenCalled();
  });
  it.each(['running', 'created', 'unknown'])(
    'protects a recently stopped or uncertain %s container',
    async (state) => {
      const f = fixture();
      f.sandbox.state = state;
      expect((await retireStoppedContainers(f.input)).removed).toEqual([]);
    },
  );
  it('rechecks lifecycle state after taking the mutation barrier', async () => {
    const f = fixture();
    f.input.withProjectMutation.mockImplementation(async (_, run) => {
      f.sandbox.state = 'running';
      await run();
    });
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('protects current images, overrides, active projects and unreadable inventory', async () => {
    const f = fixture();
    f.docker.listImages.mockResolvedValue([]);
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    await retireStoppedContainers({
      ...f.input,
      listProjects: async () => [{ ...project, state: 'active' }],
    });
    await expect(
      retireStoppedContainers({
        ...f.input,
        listProjects: async () => {
          throw new Error('DB offline');
        },
      }),
    ).rejects.toThrow('DB offline');
  });
  it('preserves unrelated containers and dry-run candidates', async () => {
    const f = fixture();
    await retireStoppedContainers({ ...f.input, dryRun: true });
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.sandbox.labels = {};
    await retireStoppedContainers(f.input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
  it('requires seven days and identity labels for an abandoned project', async () => {
    const f = fixture();
    const input = { ...f.input, listProjects: async () => [] };
    await retireStoppedContainers(input);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    await retireStoppedContainers({ ...input, now: now + 7 * 86400000 });
    expect(f.docker.removeStoppedContainer).toHaveBeenCalledOnce();
  });
});
describe('completed update bootstrap jobs', () => {
  it('removes successful old jobs only after a matching deployment server is running', async () => {
    const f = fixture();
    f.sandbox.labels = {
      'com.docker.compose.service': 'verity-agent-seed',
      'com.docker.compose.project': 'deploy',
    };
    await retireCompletedUpdateContainers(f.input.docker);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.containers.push({
      id: 'server',
      created: 2,
      imageId: 'new',
      state: 'running',
      labels: {
        'com.docker.compose.service': 'verity-server',
        'com.docker.compose.project': 'deploy',
      },
    });
    f.containers[1]!.created = 0;
    expect(await retireCompletedUpdateContainers(f.input.docker)).toEqual([]);
    f.containers[1]!.created = 2;
    expect(await retireCompletedUpdateContainers(f.input.docker)).toEqual(['verity-p']);
  });
  it('retains failures and unrelated deployment jobs', async () => {
    const f = fixture();
    f.sandbox.labels = {
      'com.docker.compose.service': 'verity-managed-data-init',
      'com.docker.compose.project': 'other',
    };
    await retireCompletedUpdateContainers(f.input.docker, { composeProject: 'deploy' });
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
    f.docker.inspectContainer.mockResolvedValue({
      id: 'sandbox',
      imageId: 'old',
      running: false,
      status: 'exited',
      exitCode: 1,
      finishedAt: new Date(now).toISOString(),
    });
    await retireCompletedUpdateContainers(f.input.docker);
    expect(f.docker.removeStoppedContainer).not.toHaveBeenCalled();
  });
});
