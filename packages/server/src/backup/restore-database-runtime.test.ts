import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupManifest } from './format.js';
import type { RestoreJob } from './restore-job.js';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import {
  createRestoreDatabase,
  removeRestoreDatabase,
  restoreDatabaseResources,
} from './restore-database-runtime.js';

it('removes only job-owned containers and volumes, including interrupted migration workers', async () => {
  const job = { id: randomUUID() };
  const resources = restoreDatabaseResources(job);
  const removeContainer = vi.fn(async () => {});
  const removeVolume = vi.fn(async () => {});
  const docker = {
    listContainers: async () => [
      { id: 'database', names: [resources.container], labels: resources.labels },
      { id: 'migration', names: [resources.prefix + '-migrate'], labels: resources.labels },
      { id: 'live', names: ['verity-postgres'], labels: {} },
      { id: 'unrelated', names: ['other'], labels: resources.labels },
    ],
    listVolumes: async () => [
      { name: resources.volume, labels: resources.labels },
      { name: 'verity-db', labels: {} },
    ],
    removeContainer,
    removeVolume,
  } as unknown as DockerClient;
  await removeRestoreDatabase(docker, job);
  expect(removeContainer.mock.calls).toEqual([['database'], ['migration']]);
  expect(removeVolume.mock.calls).toEqual([[resources.volume]]);
});
it('validates all ownership before any deletion and fails closed on a colliding unlabelled resource', async () => {
  const job = { id: randomUUID() };
  const resources = restoreDatabaseResources(job);
  const removeContainer = vi.fn();
  const removeVolume = vi.fn();
  const docker = {
    listContainers: async () => [
      { id: 'owned', names: [resources.container], labels: resources.labels },
    ],
    listVolumes: async () => [{ name: resources.volume, labels: {} }],
    removeContainer,
    removeVolume,
  } as unknown as DockerClient;
  await expect(removeRestoreDatabase(docker, job)).rejects.toThrow('ownership mismatch');
  expect(removeContainer).not.toHaveBeenCalled();
  expect(removeVolume).not.toHaveBeenCalled();
  expect(() => restoreDatabaseResources({ id: '../../live' })).toThrow('Invalid restore');
});

const fake = vi.hoisted(() => ({
  migrate: vi.fn(),
  space: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  release: vi.fn(),
}));
vi.mock('./probe-space.js', () => ({ checkProbeDatabaseSpace: fake.space }));
vi.mock('./probe-worker.js', () => ({ runPinnedProbeMigration: fake.migrate }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = fake.query;
      connect = fake.connect;
      end = fake.end;
      on() {}
    },
  },
}));
it('imports into a persistent owned database volume and leaves it running for the isolated trial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-database-'));
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: {
      source: '/copied/backup',
      repository: randomUUID() + '-r1',
      sequence: 1,
      kind: 'manual',
      newIdentity: false,
    },
    verified: {
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'deployment',
      sourceInstallationId: randomUUID(),
    },
    phase: 'staging',
    startedAt: 1,
    updatedAt: 1,
  };
  const resources = restoreDatabaseResources(job);
  let created = false;
  const createContainer = vi.fn(async () => ({ id: 'staged-database' }));
  const removeContainer = vi.fn();
  const removeVolume = vi.fn();
  const docker = {
    inspectImageLabels: async () => ({
      'org.verity.postgres-image': 'postgres:18-alpine@sha256:' + 'c'.repeat(64),
    }),
    imageExists: async () => true,
    pullImage: vi.fn(),
    ensureVolume: vi.fn(async () => {
      created = true;
      return { mountpoint: undefined };
    }),
    listVolumes: async () =>
      created ? [{ name: resources.volume, labels: resources.labels }] : [],
    listContainers: async () => [],
    removeContainer,
    removeVolume,
    createContainer,
    startContainer: vi.fn(),
  } as unknown as DockerClient;
  fake.query.mockResolvedValue({ rows: [] });
  fake.connect.mockResolvedValue({ release: fake.release });
  const run = vi.fn(async () => {});
  try {
    await createRestoreDatabase({ docker, root, network: resources.prefix })(
      job,
      {} as BackupManifest,
      1024n,
      run,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: resources.container,
        labels: resources.labels,
        volumeMounts: [{ volume: resources.volume, target: '/var/lib/postgresql' }],
        restartPolicy: 'no',
      }),
    );
    expect(removeContainer).not.toHaveBeenCalled();
    expect(removeVolume).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
    const credentials: unknown = JSON.parse(await readFile(join(root, job.id, 'database'), 'utf8'));
    expect(credentials).toMatchObject({
      jobId: job.id,
      database: resources.database,
      volume: resources.volume,
    });
    expect(fake.migrate).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLabels: resources.labels,
        resourcePrefix: resources.prefix,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
