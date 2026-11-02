import { request } from 'node:http';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { DockerClient } from '../docker.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import type { RestoreJob } from './restore-job.js';
import { readBounded, writeDurable } from './repository.js';
import { BackupDeviceReview } from './device-review.js';

function health(socketPath: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { socketPath, path: '/health', timeout: 1000, ...(signal ? { signal } : {}) },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode === 200));
        response.once('error', () => resolve(false));
      },
    );
    req.once('error', () => resolve(false));
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** A trial receives only device-review state and its isolated DB URL, never the CA or Docker socket. */
export class InstallerRestoreTrial {
  constructor(private readonly options: { docker: DockerClient; root: string; network: string }) {}
  async start(
    job: RestoreJob,
    signal?: AbortSignal,
    target: 'staging' | 'canonical' = 'staging',
  ): Promise<void> {
    const { docker } = this.options;
    if (!job.verified || !docker.listContainers)
      throw new Error('Verified restore and Docker ownership inspection required');
    signal?.throwIfAborted();
    const resources = restoreDatabaseResources(job);
    const name = resources.prefix + '-trial';
    const root = join(this.options.root, job.id);
    const trial = join(root, 'trial');
    if (target === 'canonical') {
      if (!['promoting', 'promoted', 'accepting'].includes(job.phase))
        throw new Error('Canonical trial requires promotion authority');
      z.object({ jobId: z.literal(job.id), manifestHash: z.literal(job.verified.manifestHash) })
        .strict()
        .parse(
          JSON.parse((await readBounded(join(root, 'database-canonicalized'), 4096)).toString()),
        );
    }
    const credentials = z
      .object({
        jobId: z.literal(job.id),
        container: z.literal(resources.container),
        database: z.literal(resources.database),
        password: z.string().regex(/^[0-9a-f]{64}$/),
        network: z.literal(this.options.network),
      })
      .parse(JSON.parse((await readBounded(join(root, 'database'), 16384)).toString()));
    const previous = (await docker.listContainers()).filter((container) =>
      container.names?.includes(name),
    );
    if (previous.some((container) => container.labels?.['verity.restore-job'] !== job.id))
      throw new Error('Restore trial ownership mismatch');
    for (const container of previous) await docker.removeContainer(container.id);
    await mkdir(trial, { recursive: true, mode: 0o700 });
    const socket = join(trial, 'trial.sock');
    try {
      const info = await lstat(socket);
      if (!info.isSocket() || info.uid !== process.getuid?.())
        throw new Error('Invalid recovery trial socket');
      await rm(socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeDurable(
      join(trial, 'devices'),
      await readBounded(join(root, 'devices'), 8 * 1024 * 1024),
      false,
    );
    await writeDurable(
      join(trial, 'authority'),
      Buffer.from(
        JSON.stringify({
          id: job.id,
          installationId: job.installationId,
          manifestHash: job.verified.manifestHash,
          target,
        }),
      ),
      false,
    );
    signal?.throwIfAborted();
    const container = await docker.createContainer({
      name,
      image: job.verified.image,
      platform: `linux/${job.verified.architecture}`,
      labels: resources.labels,
      command: ['backup-restore-trial'],
      user: '0:0',
      network: this.options.network,
      binds: [`${trial}:/restore:rw`],
      env: [
        'VERITY_RESTORE_STATE=/restore',
        `VERITY_RESTORE_DATABASE_URL=postgres://${target === 'canonical' ? 'verity' : 'restore'}:${credentials.password}@${resources.container}:5432/${target === 'canonical' ? 'verity' : resources.database}`,
      ],
      readOnlyRootfs: true,
      tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m' },
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      restartPolicy: 'no',
      pidsLimit: 64,
      cpuShares: 2,
    });
    await docker.startContainer(container.id);
    const deadline = Date.now() + 30000;
    while (!(await health(socket, signal))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('Recovery trial did not become ready');
      await delay(250, undefined, signal ? { signal } : {});
    }
    signal?.throwIfAborted();
  }
  async reviewed(job: RestoreJob): Promise<void> {
    const state = await new BackupDeviceReview(join(this.options.root, job.id, 'trial')).load();
    if (state?.status !== 'complete') throw new Error('Explicit device review is required');
    if (job.selection.newIdentity && state.keptIds.length)
      throw new Error('New identity cannot retain previous devices');
  }
}
