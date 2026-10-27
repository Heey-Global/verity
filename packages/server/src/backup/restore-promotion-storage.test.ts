import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ContainerSpec, DockerClient } from '../docker.js';
import type { RestoreJob } from './restore-job.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import { RestorePromotionStorage } from './restore-promotion-storage.js';

const host = vi.hoisted(() => ({ save: vi.fn(), publish: vi.fn() }));
vi.mock('./restore-host-state.js', () => ({
  saveRestoreHostState: host.save,
  publishRestoreHostState: host.publish,
}));
const exec = promisify(execFile);

it('retains all previous volume contents across publication retries and restores the old managed journal on rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-storage-'));
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
    verified: {
      image: 'ghcr.io/heey-global/verity/verity-server@sha256:' + 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      schema: 'schema',
      architecture: 'amd64',
      deploymentId: 'deployment',
      sourceInstallationId: randomUUID(),
    },
    phase: 'promoting',
    startedAt: 1,
    updatedAt: 1,
  };
  const resources = restoreDatabaseResources(job);
  const volumes = new Map<string, { name: string; labels: Record<string, string> }>();
  const ensure = async (name: string, options?: { labels?: Record<string, string> }) => {
    if (!volumes.has(name)) {
      await mkdir(join(root, name));
      volumes.set(name, { name, labels: options?.labels ?? {} });
    }
    return { mountpoint: undefined };
  };
  let worker: ContainerSpec;
  const createContainer = vi.fn(async (spec: ContainerSpec) => {
    worker = spec;
    return { id: 'copy' };
  });
  const docker = {
    ensureVolume: ensure,
    listVolumes: async () => [...volumes.values()],
    listContainers: async () => [],
    createContainer,
    removeContainer: async () => {},
    startContainer: async () => {
      const source = worker.volumeMounts!.find((mount) => mount.target === '/from')!.volume;
      const destination = worker.volumeMounts!.find((mount) => mount.target === '/to')!.volume;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      await exec('sh', [
        '-c',
        worker
          .command![0]!.replaceAll('/from', quote(join(root, source)))
          .replaceAll('/to', quote(join(root, destination))),
      ]);
    },
    waitContainer: async () => 0,
    removeVolume: async (name: string) => {
      await rm(join(root, name), { recursive: true });
      volumes.delete(name);
    },
  } as unknown as DockerClient;
  const previous = {
    containers: [],
    dataVolume: true,
    databaseVolume: true,
    managedVolume: true,
    hostConfiguration: true,
  };
  const live = ['verity-data', 'recovered_verity-db', 'verity-managed-deployment'];
  try {
    await mkdir(join(root, job.id, 'host'), { recursive: true });
    await writeFile(join(root, job.id, 'host/compose-project'), 'recovered');
    for (const name of live) {
      await ensure(name);
      await writeFile(join(root, name, 'original'), name);
    }
    for (const name of [resources.prefix + '-data', resources.volume]) {
      await ensure(name, { labels: resources.labels });
      await writeFile(join(root, name, 'recovered'), name);
    }
    const storage = new RestorePromotionStorage({ docker, root, hostRoot: '/host', job });
    await storage.save(previous);
    await storage.publish(previous);
    await storage.publish(previous);
    for (const name of live)
      await expect(readFile(join(root, name, 'original'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    await storage.rollback(previous);
    await storage.rollback(previous);
    for (const name of live)
      expect(await readFile(join(root, name, 'original'), 'utf8')).toBe(name);
    expect(host.publish).toHaveBeenLastCalledWith(
      join(root, job.id, 'previous-host'),
      '/host',
      job.id,
    );
    // A different installation's database must survive fresh-target retries and abort.
    await ensure('other_verity-db');
    await writeFile(join(root, 'other_verity-db', 'original'), 'unrelated database');
    await docker.removeVolume!('recovered_verity-db');
    const fresh = { ...previous, databaseVolume: false };
    await storage.save(fresh);
    await storage.publish(fresh);
    await storage.publish(fresh);
    expect(await readFile(join(root, 'recovered_verity-db', 'recovered'), 'utf8')).toBe(
      resources.volume,
    );
    await storage.rollback(fresh);
    await storage.rollback(fresh);
    expect(volumes.has('recovered_verity-db')).toBe(false);
    expect(await readFile(join(root, 'other_verity-db', 'original'), 'utf8')).toBe(
      'unrelated database',
    );
    // A colliding checkpoint must fail before any other canonical volume is rewritten.
    volumes.get(resources.prefix + '-previous-managed')!.labels = {};
    createContainer.mockClear();
    await expect(storage.rollback(previous)).rejects.toThrow('ownership mismatch');
    expect(createContainer).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
