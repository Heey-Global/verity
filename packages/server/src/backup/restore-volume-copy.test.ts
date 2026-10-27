import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { copyRestoreVolume } from './restore-volume-copy.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import type { RestoreJob } from './restore-job.js';
const exec = promisify(execFile);
it('uses the actual cold-copy command to preserve symlinks, modes and original data while replacing the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-volume-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(source);
  await mkdir(destination);
  await writeFile(join(source, 'retained'), 'original', { mode: 0o640 });
  await symlink('/outside/private', join(source, 'link'));
  await writeFile(join(destination, 'old'), 'discard');
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
    phase: 'promoting',
    startedAt: 1,
    updatedAt: 1,
  };
  const resources = restoreDatabaseResources(job);
  let spec: ContainerSpec | undefined;
  const createContainer = vi.fn(async (value: ContainerSpec) => {
    spec = value;
    return { id: 'copy' };
  });
  const removeContainer = vi.fn(async () => {});
  const docker = {
    listVolumes: async () => [
      { name: 'verity-data', labels: {} },
      { name: resources.prefix + '-previous-data', labels: resources.labels },
    ],
    listContainers: async () => [],
    createContainer,
    removeContainer,
    startContainer: async () => {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const script = spec!
        .command![0]!.replaceAll('/from', quote(source))
        .replaceAll('/to', quote(destination));
      await exec('sh', ['-c', script]);
    },
    waitContainer: async () => 0,
  } as unknown as DockerClient;
  try {
    await mkdir(join(root, job.id, 'host'), { recursive: true });
    await writeFile(join(root, job.id, 'host/compose-project'), 'verity');
    const options = {
      root,
      docker,
      job,
      source: 'verity-data',
      destination: resources.prefix + '-previous-data',
    };
    await copyRestoreVolume(options);
    expect(await readFile(join(source, 'retained'), 'utf8')).toBe('original');
    expect(await readFile(join(destination, 'retained'), 'utf8')).toBe('original');
    expect(await readlink(join(destination, 'link'))).toBe('/outside/private');
    expect((await stat(join(destination, 'retained'))).mode & 0o777).toBe(
      (await stat(join(source, 'retained'))).mode & 0o777,
    );
    await expect(stat(join(destination, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spec).toMatchObject({
      network: 'none',
      readOnlyRootfs: true,
      volumeMounts: [
        { volume: 'verity-data', target: '/from', readOnly: true },
        { volume: resources.prefix + '-previous-data', target: '/to' },
      ],
    });
    expect(removeContainer).toHaveBeenCalledWith('copy');
    createContainer.mockClear();
    await expect(copyRestoreVolume({ ...options, destination: 'verity-db' })).rejects.toThrow(
      'Invalid restore volume copy',
    );
    expect(createContainer).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
