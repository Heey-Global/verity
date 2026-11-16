import type { EventStore, ProjectRecord, PublicPreviewShareRecord } from '@verity/store';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
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
    expiresAt: new Date('2030-01-01'),
    targetKind: 'static-folder',
    staticPath: 'dist',
  } as PublicPreviewShareRecord;
  const manager = new PreviewShareManager({
    store: {
      getProject: async () => project,
      getSession: async () => ({ projectId: 'p', worktree }),
    } as unknown as EventStore,
    docker: { inspectContainer: async () => ({ running: true }) } as unknown as DockerClient,
    hostCloneRoot: root,
  } as ConstructorParameters<typeof PreviewShareManager>[0]);
  try {
    await mkdir(publish, { recursive: true });
    expect(await manager.hasLiveTarget(share)).toBe(true);
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
