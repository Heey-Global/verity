import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { DockerError, type DockerClient } from '../docker.js';
import { createProbeExecution, newestProbeSnapshot, probeResourcePrefix } from './probe-runtime.js';
import type { ProbeJob } from './probe-jobs.js';
import type { BackupProbeOptions } from './probe.js';
const fake = vi.hoisted(() => ({ probe: vi.fn(), release: vi.fn(), database: vi.fn() }));
vi.mock('./probe.js', () => ({ probeSnapshot: fake.probe }));
vi.mock('./probe-release.js', () => ({ createProbeReleaseCheck: () => fake.release }));
vi.mock('./probe-database.js', () => ({ createProbeDatabase: fake.database }));
beforeEach(() => vi.resetAllMocks());
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'probe-runtime-'));
  const installationId = randomUUID();
  const repository = installationId + '-r1';
  await mkdir(join(root, 'repositories', repository, 'snapshots'), { recursive: true });
  await writeFile(join(root, 'repositories', repository, 'snapshots', '2-scheduled'), 'sealed');
  const job: ProbeJob = {
    format: 1,
    installationId,
    id: randomUUID(),
    status: 'running',
    phase: 'selecting',
    startedAt: 1,
    finishedAt: null,
    snapshot: null,
    error: null,
  };
  const docker = {
    removeContainer: vi.fn(async () => undefined),
    imageExists: vi.fn(async () => false),
    pullImage: vi.fn(async () => undefined),
  };
  const execution = createProbeExecution(
    {
      docker: docker as unknown as DockerClient,
      network: 'verity-net',
      tufCachePath: join(root, 'tuf'),
    },
    join(root, 'state'),
    async () => root,
    'amd64',
  );
  return {
    root,
    repository,
    job,
    docker,
    execution,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
it('selects by repository number then sequence, ignoring timestamps and foreign installations', async () => {
  const f = await fixture();
  try {
    const newer = f.job.installationId + '-r2';
    for (const repo of [newer, randomUUID() + '-r999']) {
      await mkdir(join(f.root, 'repositories', repo, 'snapshots'), { recursive: true });
      await writeFile(join(f.root, 'repositories', repo, 'snapshots', '1-manual'), 'sealed');
    }
    await writeFile(
      join(f.root, 'repositories', f.repository, 'snapshots', '99-scheduled'),
      'sealed',
    );
    expect(await newestProbeSnapshot(f.root, f.job.installationId)).toEqual({
      repository: newer,
      sequence: 1,
      kind: 'manual',
    });
    await expect(
      newestProbeSnapshot(f.root, f.job.installationId, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await f.remove();
  }
});
it('refuses duplicate sequences and symlink candidates instead of silently falling back', async () => {
  const f = await fixture();
  try {
    const snapshots = join(f.root, 'repositories', f.repository, 'snapshots');
    await writeFile(join(snapshots, '2-manual'), 'sealed');
    await expect(newestProbeSnapshot(f.root, f.job.installationId)).rejects.toThrow('Duplicate');
    await rm(join(snapshots, '2-manual'));
    await symlink('/etc/passwd', join(snapshots, '3-manual'));
    await expect(newestProbeSnapshot(f.root, f.job.installationId)).rejects.toThrow('Invalid');
  } finally {
    await f.remove();
  }
});
it('composes the production probe, verifies release before pulling and passes job-scoped resources', async () => {
  const f = await fixture();
  try {
    const selected = vi.fn();
    const phase = vi.fn();
    const signal = new AbortController().signal;
    await f.execution.execute(f.job, 'private-key', signal, phase, selected);
    expect(selected).toHaveBeenCalledWith(f.repository, 2);
    const options = fake.probe.mock.calls[0]![0] as BackupProbeOptions;
    expect(options).toMatchObject({
      repository: f.repository,
      sequence: 2,
      kind: 'scheduled',
      architecture: 'amd64',
      signal,
      recoveryKey: 'private-key',
    });
    expect(fake.database).toHaveBeenCalledWith(
      expect.objectContaining({
        resourcePrefix: probeResourcePrefix(f.job),
        signal,
        network: 'verity-net',
      }),
    );
    const manifest = { capture: { image: 'official-digest' } } as unknown as Parameters<
      BackupProbeOptions['checkRelease']
    >[0];
    fake.release.mockRejectedValueOnce(new Error('bad signature'));
    await expect(options.checkRelease(manifest, 'amd64')).rejects.toThrow('bad signature');
    expect(f.docker.pullImage).not.toHaveBeenCalled();
    await options.checkRelease(manifest, 'amd64');
    expect(f.docker.pullImage).toHaveBeenCalledWith(manifest.capture!.image, { signal });
  } finally {
    await f.remove();
  }
});
it('cleanup removes only validated job resources and attempts every resource even after Docker failure', async () => {
  const f = await fixture();
  try {
    const own = join(f.root, 'state', 'probes', f.job.id);
    const other = join(f.root, 'state', 'probes', randomUUID());
    for (const path of [own, other]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'data'), 'keep');
    }
    f.docker.removeContainer.mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(f.execution.cleanup(f.job)).rejects.toThrow('could not be removed');
    expect(f.docker.removeContainer.mock.calls).toEqual(
      ['space', 'migrate', 'postgres'].map((kind) => [probeResourcePrefix(f.job) + '-' + kind]),
    );
    await expect(readFile(join(own, 'data'))).rejects.toThrow();
    expect(await readFile(join(other, 'data'), 'utf8')).toBe('keep');
    await expect(f.execution.cleanup({ ...f.job, id: '../other' })).rejects.toThrow();
    expect(f.docker.removeContainer).toHaveBeenCalledTimes(3);
  } finally {
    await f.remove();
  }
});

it('treats already-removed Docker resources as clean during restart and final cleanup', async () => {
  const f = await fixture();
  try {
    f.docker.removeContainer.mockRejectedValue(
      new DockerError({ kind: 'container_not_found', id: 'already-gone' }),
    );
    await expect(f.execution.cleanup(f.job)).resolves.toBeUndefined();
    expect(f.docker.removeContainer).toHaveBeenCalledTimes(3);
  } finally {
    await f.remove();
  }
});
