import { describe, expect, it, vi } from 'vitest';
import type { DockerContainerSummary, DockerVolumeSummary } from './docker.js';
import {
  RETIRED_SESSION_SANDBOX_LABEL,
  removeRetiredSessionSandboxes,
} from './retired-session-sandboxes.js';

function fakeDocker(containers: DockerContainerSummary[], volumes: DockerVolumeSummary[]) {
  return {
    listContainers: vi.fn(async () => containers),
    removeContainer: vi.fn(async (...args: [string]) => {
      void args;
    }),
    listVolumes: vi.fn(async () => volumes),
    removeVolume: vi.fn(async (...args: [string]) => {
      void args;
    }),
  };
}

describe('removeRetiredSessionSandboxes', () => {
  it('removes only per-session sandboxes and their dependency volumes', async () => {
    // A retired sandbox nobody owns keeps running with its mounts through project
    // sleep and deletion. The project sandbox, its relay and the shared volumes
    // carry other labels and names and must survive.
    const docker = fakeDocker(
      [
        { id: 'session', imageId: 'sha256:a', labels: { [RETIRED_SESSION_SANDBOX_LABEL]: 's1' } },
        { id: 'project', imageId: 'sha256:a', labels: { 'verity.project-id': 'p1' } },
        { id: 'unlabelled', imageId: 'sha256:b' },
      ],
      [
        { name: `verity-session-${'0'.repeat(24)}-node-modules`, labels: {} },
        { name: 'verity-node-modules-f740228d-8371-4f0c-b002-d76664a79e8e', labels: {} },
        { name: 'verity-data', labels: {} },
      ],
    );

    await expect(removeRetiredSessionSandboxes(docker)).resolves.toEqual({
      containers: 1,
      volumes: 1,
      failed: 0,
    });
    expect(docker.removeContainer.mock.calls).toEqual([['session']]);
    expect(docker.removeVolume.mock.calls).toEqual([
      [`verity-session-${'0'.repeat(24)}-node-modules`],
    ]);
  });

  it('keeps going past a container the daemon refuses', async () => {
    const docker = fakeDocker(
      [
        { id: 'stuck', imageId: 'sha256:a', labels: { [RETIRED_SESSION_SANDBOX_LABEL]: 's1' } },
        { id: 'next', imageId: 'sha256:a', labels: { [RETIRED_SESSION_SANDBOX_LABEL]: 's2' } },
      ],
      [],
    );
    docker.removeContainer.mockRejectedValueOnce(new Error('conflict'));

    await expect(removeRetiredSessionSandboxes(docker)).resolves.toEqual({
      containers: 1,
      volumes: 0,
      failed: 1,
    });
    expect(docker.removeContainer).toHaveBeenCalledWith('next');
  });
});
