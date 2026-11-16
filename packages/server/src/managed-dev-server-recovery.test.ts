import type { EventStore, ProjectRecord } from '@verity/store';
import { expect, it, vi } from 'vitest';
import type { ManagedDevServerRuntime } from './managed-dev-server-manager.js';
import { verifyRecoveryInstances } from './managed-dev-server-recovery.js';

it('requires a fresh tagged listener on the replacement sandbox and exact port', async () => {
  const project = { id: 'p', containerName: 'old' } as ProjectRecord;
  const listListeningProcesses = vi
    .fn()
    .mockRejectedValueOnce(new Error('discovery failed'))
    .mockResolvedValueOnce([{ instanceId: 'i', port: 41001 }])
    .mockResolvedValueOnce([{ instanceId: 'other', port: 41000 }])
    .mockResolvedValueOnce([{ instanceId: 'i', port: 41000 }]);
  const options = {
    store: {
      getProject: async () => project,
      managedDevServers: {
        getInstance: async () => ({
          id: 'i',
          projectId: 'p',
          desired: 'running',
          state: 'running',
          lastRunUserId: 'u',
          sandboxPort: 41000,
        }),
      },
    } as unknown as EventStore,
    runtime: { listListeningProcesses } as unknown as ManagedDevServerRuntime,
  };
  const inSandbox = vi.fn(async () => ({ ...project, containerName: 'replacement' }));
  const probe = () => verifyRecoveryInstances(options, inSandbox, ['i']);
  await expect(probe()).rejects.toThrow('discovery failed');
  expect(await probe()).toEqual(new Set());
  expect(await probe()).toEqual(new Set());
  expect(await probe()).toEqual(new Set(['i']));
  expect(listListeningProcesses).toHaveBeenCalledWith(
    expect.objectContaining({ containerName: 'replacement' }),
    { fresh: true },
  );
  expect(inSandbox).toHaveBeenCalledWith(project, 'u');
});
