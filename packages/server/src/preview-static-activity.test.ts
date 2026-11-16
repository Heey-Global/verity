import type { EventStore, ProjectRecord, PublicPreviewShareRecord } from '@verity/store';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { DockerError } from './docker.js';
import { createSandboxUpdateRecovery } from './sandbox-update-recovery.js';
import type { DockerClient } from './docker.js';
import { PreviewShareManager } from './preview-share-manager.js';

it('treats deleted static checkout, worktree and publish roots as offline through the real manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'static-activity-'));
  const checkout = join(root, 'repo');
  const worktree = join(checkout, 'sessions', 's');
  const publish = join(worktree, 'dist');
  const project = {
    id: 'p',
    cloneDir: 'repo',
    state: 'active',
    containerName: 'sandbox',
  } as ProjectRecord;
  const share = {
    projectId: 'p',
    sessionId: 's',
    managedInstanceId: null,
    state: 'active',
    connectorContainerId: 'connector',
    expiresAt: new Date('2030-01-01'),
    targetKind: 'static-folder',
    staticPath: 'dist',
  } as PublicPreviewShareRecord;
  const inspectContainer = vi
    .fn<(id: string) => Promise<{ running: boolean }>>()
    .mockResolvedValue({ running: true });
  const store = {
    getProject: async () => project,
    getSession: async () => ({ projectId: 'p', worktree }),
    managedDevServers: { listInstances: async () => [] },
    listPublicPreviewShares: async () => [share],
  } as unknown as EventStore;
  const manager = new PreviewShareManager({
    store,
    docker: { inspectContainer } as unknown as DockerClient,
    hostCloneRoot: root,
  } as ConstructorParameters<typeof PreviewShareManager>[0]);
  try {
    await mkdir(publish, { recursive: true });
    expect(await manager.hasLiveTarget(share)).toBe(true);
    const capture = () =>
      createSandboxUpdateRecovery({
        store,
        devServers: () => undefined,
        local: () => undefined,
        public: () => manager,
      }).capture('p');
    inspectContainer.mockImplementation(async (id?: string) => {
      if (id === 'connector') throw new Error('connector inspection unavailable');
      return { running: true };
    });
    await expect(capture()).rejects.toThrow('connector inspection unavailable');
    inspectContainer.mockImplementation(async (id?: string) => {
      if (id === 'connector') throw new DockerError({ kind: 'container_not_found', id });
      return { running: true };
    });
    expect(await manager.isOnline(share)).toBe(false);
    expect(await (await capture())()).toMatchObject({ state: 'ready' });

    inspectContainer.mockRejectedValue(
      new DockerError({ kind: 'container_not_found', id: 'sandbox' }),
    );
    expect(await manager.hasLiveTarget(share)).toBe(false);
    const check = await createSandboxUpdateRecovery({
      store,
      devServers: () => undefined,
      local: () => undefined,
      public: () => manager,
    }).capture('p');
    expect(await check()).toMatchObject({ state: 'ready' });
    inspectContainer.mockRejectedValue(new Error('Docker unavailable'));
    await expect(manager.hasLiveTarget(share)).rejects.toThrow('Docker unavailable');
    inspectContainer.mockResolvedValue({ running: true });
    await rm(publish, { recursive: true });
    expect(await manager.hasLiveTarget(share)).toBe(false);
    await rm(worktree, { recursive: true });
    expect(await manager.hasLiveTarget(share)).toBe(false);
    await symlink(root, worktree);
    expect(await manager.hasLiveTarget(share)).toBe(false);
    await rm(checkout, { recursive: true });
    expect(await manager.hasLiveTarget(share)).toBe(false);
    expect(share.state).toBe('active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
