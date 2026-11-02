import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { createRestorePreparation } from './restore-preparation.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
const fake = vi.hoisted(() => ({ snapshot: vi.fn(), release: vi.fn() }));
vi.mock('./repository.js', async (original) => ({
  ...(await original<typeof import('./repository.js')>()),
  readSnapshot: fake.snapshot,
}));
vi.mock('./probe-release.js', () => ({ createProbeReleaseCheck: () => fake.release }));

it('refuses unsupported pinned releases before staging and cleans only this job staging after an abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-preparation-'));
  const job: RestoreJob = {
    format: 1,
    id: randomUUID(),
    installationId: randomUUID(),
    selection: {
      source: '/backup',
      repository: randomUUID() + '-r1',
      sequence: 1,
      kind: 'manual',
      newIdentity: false,
    },
    verified: null,
    phase: 'verifying',
    startedAt: 1,
    updatedAt: 1,
  };
  const resources = restoreDatabaseResources(job);
  const pullImage = vi.fn(async () => {});
  const ensureNetwork = vi.fn(async () => {});
  const removeContainer = vi.fn(async () => {});
  const removeVolume = vi.fn(async () => {});
  const docker = {
    imageExists: async () => false,
    pullImage,
    ensureNetwork,
    inspectImageLabels: async () => ({}),
    listContainers: async () => [
      { id: 'load', names: [resources.prefix + '-load'], labels: resources.labels },
      { id: 'previous', names: [resources.prefix + '-previous-0'], labels: {} },
    ],
    listVolumes: async () => [
      { name: resources.prefix + '-data', labels: resources.labels },
      { name: resources.prefix + '-previous-data', labels: resources.labels },
      { name: 'verity-data', labels: {} },
    ],
    removeContainer,
    removeVolume,
  } as unknown as DockerClient;
  const preparation = createRestorePreparation({
    docker,
    root,
    liveRoot: '/srv/verity',
    tufCachePath: join(root, 'tuf'),
    host: { root, addresses: [] },
  });
  fake.snapshot.mockResolvedValue({
    schema: 'schema',
    capture: { architecture: process.arch === 'arm64' ? 'arm64' : 'amd64', image: 'pinned-digest' },
  });
  fake.release.mockRejectedValueOnce(new Error('invalid signed release'));
  try {
    await expect(preparation.verify(job, 'key')).rejects.toThrow('invalid signed release');
    expect(pullImage).not.toHaveBeenCalled();
    await expect(preparation.verify(job, 'key')).rejects.toThrow(
      'does not support restricted recovery',
    );
    expect(pullImage).toHaveBeenCalledWith('pinned-digest', {});
    expect(ensureNetwork).not.toHaveBeenCalled();
    await mkdir(join(root, job.id));
    for (const name of ['host-keys', 'database', 'devices'])
      await writeFile(join(root, job.id, name), 'private');
    await mkdir(join(root, job.id, '.verity-restore-interrupted'));
    await mkdir(join(root, job.id, 'previous-host'));
    await writeFile(join(root, job.id, 'previous-host', 'saved'), 'original');
    await preparation.cleanup({ ...job, phase: 'aborting' });
    expect(removeContainer.mock.calls).toEqual([['load']]);
    expect(removeVolume.mock.calls).toEqual([[resources.prefix + '-data']]);
    await expect(readFile(join(root, job.id, 'host-keys'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(root, job.id, 'previous-host', 'saved'), 'utf8')).toBe('original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
