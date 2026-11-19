import { beforeEach, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '@verity/store';
import { createEmbeddedDocker } from './embedded-docker.js';

const { createClient, inspect, cleanup } = vi.hoisted(() => ({
  inspect: vi.fn(),
  createClient: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('./docker.js', () => ({ createDockerClient: createClient }));
vi.mock('./retired-session-sandboxes.js', () => ({ removeRetiredSessionSandboxes: cleanup }));
beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockImplementation(() => ({ inspectContainer: inspect }));
  cleanup.mockResolvedValue({ containers: 0, volumes: 0, failed: 0 });
});
const project = { containerName: 'project-sandbox' } as ProjectRecord;

it('shares the project client with runtime operations and starts cleanup without waiting', () => {
  cleanup.mockReturnValue(new Promise(() => {}));
  const runtime = createEmbeddedDocker({
    dockerBaseUrl: 'http://docker',
    hostCloneRoot: '/clones',
  });
  expect(runtime.projectDocker).toBe(runtime.runtimeDocker);
  expect(createClient).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledWith(runtime.projectDocker);
});

it('creates a runtime-only client without project provisioning or retired cleanup', async () => {
  const runtime = createEmbeddedDocker({ dockerBaseUrl: 'http://docker' });
  expect(runtime.projectDocker).toBeUndefined();
  expect(runtime.runtimeDocker).toBeDefined();
  expect(cleanup).not.toHaveBeenCalled();
  await expect(runtime.resolvePreviewUser(project)).resolves.toBeUndefined();
});

it('requires numeric agent identity for runner sandboxes', async () => {
  const runtime = createEmbeddedDocker({
    dockerBaseUrl: 'http://docker',
    hostCloneRoot: '/clones',
  });
  inspect.mockResolvedValue({
    env: ['VERITY_RUNNER_RUNTIME=1', 'VERITY_AGENT_UID=1000', 'VERITY_AGENT_GID=1001'],
  });
  await expect(runtime.resolvePreviewUser(project)).resolves.toBe('1000:1001');
  inspect.mockResolvedValue({ env: ['VERITY_RUNNER_RUNTIME=1', 'VERITY_AGENT_UID=root'] });
  await expect(runtime.resolvePreviewUser(project)).rejects.toThrow(
    'sandbox agent identity is unavailable',
  );
});

it('retains the configured user for legacy sandboxes', async () => {
  const runtime = createEmbeddedDocker({
    dockerBaseUrl: 'http://docker',
    hostCloneRoot: '/clones',
  });
  inspect.mockResolvedValue({ user: 'legacy-user', env: [] });
  await expect(runtime.resolvePreviewUser(project)).resolves.toBe('legacy-user');
});
