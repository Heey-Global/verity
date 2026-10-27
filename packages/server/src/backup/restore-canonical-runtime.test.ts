import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import {
  startCanonicalRestoreDatabase,
  stopRestoreTrialRuntime,
  withCanonicalRestoreClient,
} from './restore-canonical-runtime.js';

it('refuses an unrelated canonical database before connecting or replacing any container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-runtime-'));
  const job = { id: randomUUID(), verified: { image: 'pinned' } } as RestoreJob;
  const resources = restoreDatabaseResources(job);
  await mkdir(join(root, job.id));
  await writeFile(
    join(root, job.id, 'database'),
    JSON.stringify({
      jobId: job.id,
      container: resources.container,
      volume: resources.volume,
      database: resources.database,
      network: resources.prefix,
      password: 'a'.repeat(64),
      image: 'postgres',
    }),
  );
  const removeContainer = vi.fn();
  const createContainer = vi.fn();
  const docker = {
    inspectContainer: async () => ({
      running: true,
      labels: { 'verity.restore-job': randomUUID() },
      networks: { [resources.prefix]: { ipAddress: '127.0.0.1' } },
      mounts: [
        { type: 'volume', name: 'verity-db', destination: '/var/lib/postgresql', readWrite: true },
      ],
    }),
    listContainers: async () => [],
    listVolumes: async () => [],
    removeContainer,
    createContainer,
  } as unknown as DockerClient;
  try {
    await expect(
      withCanonicalRestoreClient({ root, job, docker, network: resources.prefix }, async () => {}),
    ).rejects.toThrow('ownership mismatch');
    await expect(
      startCanonicalRestoreDatabase({ root, job, docker, network: resources.prefix }),
    ).rejects.toThrow('volume is missing');
    expect(removeContainer).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preflights both trial and database ownership before stopping either', async () => {
  const job = { id: randomUUID() } as RestoreJob;
  const resources = restoreDatabaseResources(job);
  const stopContainer = vi.fn();
  const containers = [
    { id: 'trial', names: [resources.prefix + '-trial'], labels: resources.labels },
    { id: 'database', names: [resources.container], labels: {} },
  ];
  const docker = {
    listContainers: async () => containers,
    inspectContainer: async () => ({ running: true }),
    stopContainer,
  } as unknown as DockerClient;
  await expect(stopRestoreTrialRuntime({ job, docker })).rejects.toThrow('ownership mismatch');
  expect(stopContainer).not.toHaveBeenCalled();
  containers[1]!.labels = resources.labels;
  await stopRestoreTrialRuntime({ job, docker });
  expect(stopContainer.mock.calls).toEqual([['trial'], ['database']]);
});
