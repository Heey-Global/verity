import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { ContainerSpec, DockerClient } from '../docker.js';
import { createRestoreDataVolume } from './restore-data-volume.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import type { RestoreJob } from './restore-job.js';
const exec = promisify(execFile);
it('loads only captured data scopes with the actual worker command and refuses unrelated staging volumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-data-'));
  const tree = join(root, 'tree');
  const data = join(root, 'data');
  await mkdir(tree);
  await mkdir(data);
  for (const scope of ['workspaces', 'sessions', 'knowledge', 'database', 'identity']) {
    await mkdir(join(tree, scope));
    await writeFile(join(tree, scope, 'file'), scope);
  }
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
  await writeFile(join(tree, '.verity-recovery-pending'), job.id);
  const resources = restoreDatabaseResources(job);
  let labels: Record<string, string> | undefined;
  let spec: ContainerSpec | undefined;
  const createContainer = vi.fn(async (value: ContainerSpec) => {
    spec = value;
    return { id: 'load' };
  });
  const removeVolume = vi.fn(async () => {});
  const docker = {
    listContainers: async () => [],
    listVolumes: async () => (labels ? [{ name: resources.prefix + '-data', labels }] : []),
    ensureVolume: async (_name: string, options: { labels: Record<string, string> }) => {
      labels = options.labels;
      return {};
    },
    removeVolume,
    createContainer,
    removeContainer: vi.fn(),
    startContainer: async () => {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const command = spec!.command!;
      await exec('sh', [
        '-c',
        command[0]!.replaceAll('/from', quote(tree)).replaceAll('/to', quote(data)),
        ...command.slice(1),
      ]);
    },
    waitContainer: async () => 0,
  } as unknown as DockerClient;
  const load = createRestoreDataVolume({
    docker,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  });
  try {
    await load(job, tree);
    for (const scope of ['workspaces', 'sessions', 'knowledge'])
      expect(await readFile(join(data, scope, 'file'), 'utf8')).toBe(scope);
    for (const scope of ['database', 'identity'])
      await expect(stat(join(data, scope))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(data, '.verity-recovery-pending'), 'utf8')).toBe(job.id);
    expect(spec).toMatchObject({
      network: 'none',
      binds: [`${tree}:/from:ro`],
      volumeMounts: [{ volume: resources.prefix + '-data', target: '/to' }],
    });
    labels = {};
    createContainer.mockClear();
    await expect(load(job, tree)).rejects.toThrow('ownership mismatch');
    expect(createContainer).not.toHaveBeenCalled();
    expect(removeVolume).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
