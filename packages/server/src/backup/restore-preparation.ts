import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DockerClient } from '../docker.js';
import type { RestoreJobAdapters } from './restore-job.js';
import { createProbeReleaseCheck, type ProbeReleaseOptions } from './probe-release.js';
import {
  createRestoreDatabase,
  removeRestoreDatabase,
  restoreDatabaseResources,
} from './restore-database-runtime.js';
import { createRestoreDataVolume } from './restore-data-volume.js';
import { createRestoreHost } from './restore-host.js';
import { InstallerRestoreStaging } from './restore-staging.js';
import { InstallerRestoreTrial } from './restore-trial-runtime.js';

/** Installer-only composition. No normal server or background lifecycle is imported. */
export function createRestorePreparation(options: {
  docker: DockerClient;
  root: string;
  liveRoot: string;
  hostRoot?: string;
  tufCachePath: string;
  release?: ProbeReleaseOptions;
  hostNetworking?: boolean;
  host: Parameters<typeof createRestoreHost>[0];
}): Pick<RestoreJobAdapters, 'verify' | 'stage' | 'trial' | 'review'> & {
  cleanup: RestoreJobAdapters['abort'];
} {
  const setup = async (job: Parameters<RestoreJobAdapters['stage']>[0], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const resources = restoreDatabaseResources(job);
    if (!options.docker.ensureNetwork) throw new Error('Restore network creation unavailable');
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // Network creation is deferred to staging; verification only pulls authenticated image digests.
    const staging = new InstallerRestoreStaging({
      root: options.root,
      liveRoot: options.liveRoot,
      ...(options.hostRoot ? { identityHistoryRoot: options.hostRoot } : {}),
      checkRelease: createProbeReleaseCheck({
        ...(options.release ?? { verification: { tufCachePath: options.tufCachePath } }),
        ...(signal ? { signal } : {}),
      }),
      supportsRecovery: async (image) => {
        const docker = options.docker;
        if (!docker.imageExists || !docker.pullImage || !docker.inspectImageLabels)
          throw new Error('Restore image verification unavailable');
        if (!(await docker.imageExists(image)))
          await docker.pullImage(image, signal ? { signal } : {});
        signal?.throwIfAborted();
        return (await docker.inspectImageLabels(image))?.['org.verity.recovery'] === '1';
      },
      withFreshDatabase: createRestoreDatabase({
        docker: options.docker,
        root: options.root,
        network: resources.prefix,
        ...(options.hostNetworking ? { hostNetworking: true } : {}),
      }),
      stageData: createRestoreDataVolume({
        docker: options.docker,
        ...(options.host.serverUid !== undefined ? { uid: options.host.serverUid } : {}),
        ...(options.host.serverGid !== undefined ? { gid: options.host.serverGid } : {}),
      }),
      // Compose must not reconcile and remove the retained previous project's containers.
      stageHost: createRestoreHost({
        ...options.host,
        root: options.root,
        project: 'verity-restored-' + job.id.replaceAll('-', ''),
      }),
    });
    const trial = new InstallerRestoreTrial({
      docker: options.docker,
      root: options.root,
      network: resources.prefix,
    });
    return { resources, staging, trial };
  };
  return {
    verify: async (job, key, signal) => (await setup(job, signal)).staging.verify(job, key, signal),
    stage: async (job, key, signal) => {
      const { resources, staging } = await setup(job, signal);
      await options.docker.ensureNetwork!(resources.prefix, { labels: resources.labels });
      await staging.stage(job, key, signal);
    },
    trial: async (job, signal) => (await setup(job, signal)).trial.start(job, signal),
    review: async (job, signal) => {
      signal?.throwIfAborted();
      await (await setup(job, signal)).trial.reviewed(job);
    },
    cleanup: async (job, signal) => {
      signal?.throwIfAborted();
      restoreDatabaseResources(job);
      await removeRestoreDatabase(options.docker, job, 'staging');
      signal?.throwIfAborted();
      // Previous-volume and host checkpoints are deliberately outside these disposable paths.
      await rm(join(options.root, job.id, 'tree'), { recursive: true, force: true });
      await rm(join(options.root, job.id, 'host'), { recursive: true, force: true });
      await rm(join(options.root, job.id, 'trial'), { recursive: true, force: true });
      await rm(join(options.root, job.id, 'verification'), { recursive: true, force: true });
      for (const name of ['database', 'host-keys', 'devices', 'database-canonicalized'])
        await rm(join(options.root, job.id, name), { force: true });
      try {
        for (const name of await readdir(join(options.root, job.id))) {
          signal?.throwIfAborted();
          if (name.startsWith('.verity-restore-'))
            await rm(join(options.root, job.id, name), { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
