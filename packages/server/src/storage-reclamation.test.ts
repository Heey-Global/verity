import Fastify from 'fastify';
import type { EventStore } from '@verity/store';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageReclamation } from './storage-reclamation.js';
import { registerStorageReclamationRoutes } from './storage-reclamation-routes.js';
import type { DockerGcReport } from './docker-gc.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const report: DockerGcReport = {
  observedAt: new Date().toISOString(),
  containersRemoved: ['old'],
  imagesRemoved: ['image'],
  stoppedContainerPins: { images: 1, containers: 1, estimatedBytes: 100 },
  keptImageReasons: [{ imageId: 'kept', containers: ['recent'] }],
  retainedContainers: [{ name: 'recent', reason: 'Stopped-container grace period (1 days)' }],
  estimatedImageBytes: 1e12,
  volumesRemoved: 0,
  builderVolumesRemoved: 0,
  relaysRemoved: [],
  buildCacheBytes: 0,
  lowDisk: false,
  errors: [],
};
it('coalesces requests and separates pending host work from estimated image sizes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-action-'));
  roots.push(directory);
  mkdirSync(join(directory, 'reclamation-evidence'));
  let finish!: (report: DockerGcReport) => void;
  const collect = vi.fn(
    () =>
      new Promise<DockerGcReport>((resolve) => {
        finish = resolve;
      }),
  );
  const service = new StorageReclamation({
    directory,
    collect,
    worktrees: () => undefined,
    dataRoot: directory,
  });
  await Promise.all([service.start(), service.start()]);
  await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
  expect((await service.status()).state).toBe('running');
  finish(report);
  await vi.waitFor(async () => expect((await service.status()).state).toBe('completed'));
  const state = await service.status();
  expect(state.nativePending).toBe(true);
  expect(state.result?.imagesRemoved).toBe(1);
  expect(state.result?.filesystemFreeBytesChange).not.toBe(report.estimatedImageBytes);
  expect(state.result?.retainedPins[0]?.reason).toContain('Stopped-container grace');
  writeFileSync(
    join(directory, 'native-retirement.json'),
    JSON.stringify({
      version: 1,
      observedAt: new Date().toISOString(),
      path: '/var/lib/verity-buildkit/runc-native',
      dryRun: false,
      eligible: false,
      state: 'deferred',
      allocatedBytes: null,
      overlayAllocatedBytes: null,
      reclaimableBytes: null,
      blockers: ['unresolved-runtime-leases'],
    }),
  );
  expect((await service.status()).nativePending).toBe(false);
  expect((await service.status()).nativeBuildkit?.blockers).toEqual(['unresolved-runtime-leases']);
});
it('rejects non-administrators and request parameters before starting maintenance', async () => {
  const service = new StorageReclamation({
    collect: vi.fn(async () => report),
    worktrees: () => undefined,
  });
  const start = vi.spyOn(service, 'start');
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.localUserId = (request.headers['x-test-user'] as string | undefined) ?? null;
  });
  registerStorageReclamationRoutes(
    app,
    { isActiveAdministrator: async (id: string) => id === 'admin' } as EventStore,
    service,
  );
  try {
    for (const user of [undefined, 'member']) {
      const res = await app.inject({
        method: 'POST',
        url: '/settings/storage/reclamation',
        headers: user ? { 'x-test-user': user } : {},
      });
      expect(res.statusCode).toBe(403);
    }
    expect(start).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/settings/storage/reclamation',
          headers: { 'x-test-user': 'admin' },
          payload: { path: '/' },
        })
      ).statusCode,
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/settings/storage/reclamation',
          headers: { 'x-test-user': 'admin' },
        })
      ).statusCode,
    ).toBe(202);
    expect(start).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
it('reports failure without leaking command output', async () => {
  const service = new StorageReclamation({
    collect: async () => {
      throw new Error('private detail');
    },
    worktrees: () => undefined,
  });
  await service.start();
  await vi.waitFor(async () => expect((await service.status()).state).toBe('failed'));
  expect((await service.status()).error).not.toContain('private detail');
});

it('allows another independent pass when the host never acknowledges a request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-action-'));
  roots.push(directory);
  mkdirSync(join(directory, 'reclamation-evidence'));
  const collect = vi.fn(async () => report);
  const service = new StorageReclamation({ directory, collect, worktrees: () => undefined });
  await service.start();
  await vi.waitFor(async () => expect((await service.status()).state).toBe('completed'));
  expect((await service.status()).nativePending).toBe(true);
  await service.start();
  await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
  await vi.waitFor(async () => expect((await service.status()).state).toBe('completed'));
  expect((await service.status()).nativePending).toBe(true);
});

it('uses the actual native request time when joining an earlier scheduled pass', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-action-'));
  roots.push(directory);
  const requestedAt = new Date(Date.now() - 2000).toISOString();
  writeFileSync(
    join(directory, 'native-retirement.json'),
    JSON.stringify({
      version: 1,
      observedAt: new Date(Date.now() - 1000).toISOString(),
      path: '/var/lib/verity-buildkit/runc-native',
      dryRun: false,
      eligible: true,
      state: 'completed',
      allocatedBytes: 4096,
      overlayAllocatedBytes: null,
      reclaimableBytes: null,
      blockers: [],
    }),
  );
  const service = new StorageReclamation({
    directory,
    collect: async () => ({ ...report, nativeRequestedAt: requestedAt }),
    worktrees: () => undefined,
  });
  await service.start();
  await vi.waitFor(async () => expect((await service.status()).state).toBe('completed'));
  expect((await service.status()).nativePending).toBe(false);
});
