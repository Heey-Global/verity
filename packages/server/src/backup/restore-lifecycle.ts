import { restoreComposeDatabaseVolume } from './restore-compose-volume.js';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DockerClient } from '../docker.js';
import { readUpdateJournal, withUpdateJournalLease } from '../self-update/update-journal.js';
import type { RestoreJob, RestoreJobAdapters } from './restore-job.js';
import { createRestorePreparation } from './restore-preparation.js';
import {
  InstallerRestorePromotion,
  parseRestorePreviousInstallation,
} from './restore-promotion.js';
import { RestorePreviousRuntime } from './restore-previous-runtime.js';
import { RestorePromotionStorage } from './restore-promotion-storage.js';
import { readBounded, writeDurable } from './repository.js';
import { canonicalizeRestoreDatabase } from './restore-canonical-database.js';
import {
  startCanonicalRestoreDatabase,
  stopRestoreTrialRuntime,
  withCanonicalRestoreClient,
} from './restore-canonical-runtime.js';
import { InstallerRestoreTrial } from './restore-trial-runtime.js';
import { removeRestoreDatabase, restoreDatabaseResources } from './restore-database-runtime.js';
import { recheckRestoreDevices } from './restore-final-review.js';

/** One invocation owns secrets in memory; durable records carry only authority and intent. */
export function createRestoreLifecycle(
  options: Parameters<typeof createRestorePreparation>[0] & {
    docker: DockerClient;
    hostRoot: string;
    previousComposeProject: string;
    /** Existing managed volume, mounted only when present; never create it merely to verify a backup. */
    previousManagedRoot?: string;
    recoveryKey: string;
    masterPassword: string;
    initialize: RestoreJobAdapters['initialize'];
  },
): RestoreJobAdapters {
  const preparation = createRestorePreparation(options);
  const previousRuntime = async (job: RestoreJob) =>
    new RestorePreviousRuntime({
      docker: options.docker,
      job,
      composeProject: options.previousComposeProject,
      databaseVolume: await restoreComposeDatabaseVolume(options.root, job),
    });
  const frozenPrevious = async (job: RestoreJob) => {
    const path = join(options.root, job.id, 'previous-runtime');
    try {
      const saved: unknown = JSON.parse((await readBounded(path, 2 * 1024 * 1024)).toString());
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('jobId' in saved) ||
        saved.jobId !== job.id ||
        !('previous' in saved)
      )
        throw new Error('Previous installation checkpoint mismatch');
      return parseRestorePreviousInstallation(saved.previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let hostConfiguration = false;
      try {
        await lstat(join(options.hostRoot, 'deployment-id'));
        hostConfiguration = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const previous = await (await previousRuntime(job)).inspect(hostConfiguration);
      await mkdir(join(options.root, job.id), { recursive: true, mode: 0o700 });
      await writeDurable(path, Buffer.from(JSON.stringify({ jobId: job.id, previous })), true);
      return previous;
    }
  };
  const fencePrevious = async (job: RestoreJob, signal?: AbortSignal) => {
    const run = async () => {
      if (options.previousManagedRoot) {
        const update = await readUpdateJournal(options.previousManagedRoot);
        if (update && !['completed', 'rolled-back', 'failed'].includes(update.phase))
          throw new Error('Finish or recover the active update before restoring');
      }
      const previous = await frozenPrevious(job);
      await (await previousRuntime(job)).stop(previous, signal);
    };
    if (options.previousManagedRoot) await withUpdateJournalLease(options.previousManagedRoot, run);
    else await run();
  };
  const composition = (job: RestoreJob) => {
    const root = join(options.root, job.id);
    const network = restoreDatabaseResources(job).prefix;
    const runtime = { docker: options.docker, root: options.root, network, job };
    const trial = new InstallerRestoreTrial({
      docker: options.docker,
      root: options.root,
      network,
    });
    const storage = new RestorePromotionStorage({
      docker: options.docker,
      root: options.root,
      hostRoot: options.hostRoot,
      job,
    });
    const promotion = new InstallerRestorePromotion(root, {
      inspect: () => frozenPrevious(job),
      stop: async (previous, signal) => {
        await (await previousRuntime(job)).stop(previous, signal);
        await stopRestoreTrialRuntime(runtime);
      },
      save: (previous, signal) => storage.save(previous, signal),
      publish: async (signal) => storage.publish(await frozenPrevious(job), signal),
      start: async (signal) => {
        await startCanonicalRestoreDatabase({ ...runtime, ...(signal ? { signal } : {}) });
        await trial.start(job, signal, 'canonical');
      },
      healthy: async (signal) => {
        await withCanonicalRestoreClient(
          { ...runtime, ...(signal ? { signal } : {}) },
          async () => {},
        );
        await trial.reviewed(job);
      },
      rollback: async (previous, from, signal) => {
        // A prior attempt may have resumed these writers before its completion was checkpointed.
        await (await previousRuntime(job)).stop(previous, signal);
        await stopRestoreTrialRuntime(runtime);
        await removeRestoreDatabase(options.docker, job);
        if (
          ['publishing', 'published', 'starting', 'started', 'checking', 'healthy'].includes(from)
        )
          await storage.rollback(previous, signal);
        await (await previousRuntime(job)).resume(previous, signal);
      },
    });
    return { runtime, trial, promotion };
  };
  return {
    verify: preparation.verify,
    stage: preparation.stage,
    trial: async (job, signal) => {
      await fencePrevious(job, signal);
      await preparation.trial(job, signal);
    },
    review: preparation.review,
    promote: async (job, signal) => {
      const { promotion, runtime } = composition(job);
      if ((await promotion.status(job)) === null)
        await canonicalizeRestoreDatabase({
          ...runtime,
          recoveryKey: options.recoveryKey,
          masterPassword: options.masterPassword,
          ...(signal ? { signal } : {}),
        });
      await promotion.run(job, signal);
    },
    accept: async (job, signal) => {
      const { runtime, trial, promotion } = composition(job);
      if ((await promotion.status(job)) !== 'healthy')
        throw new Error('Healthy promoted trial required');
      await trial.reviewed(job);
      await withCanonicalRestoreClient(
        { ...runtime, ...(signal ? { signal } : {}) },
        async (client) => {
          await recheckRestoreDevices({
            root: options.root,
            job,
            client,
            recoveryKey: options.recoveryKey,
            masterPassword: options.masterPassword,
            target: 'canonical',
            ...(signal ? { signal } : {}),
          });
        },
      );
    },
    initialize: options.initialize,
    abort: async (job, signal) => {
      const { promotion, runtime } = composition(job);
      if ((await promotion.status(job)) !== null) await promotion.rollback(job, signal);
      else {
        await stopRestoreTrialRuntime(runtime);
        // No publication occurred; all original canonical volumes and host files are still intact.
        try {
          await readBounded(join(options.root, job.id, 'previous-runtime'), 2 * 1024 * 1024);
          await (await previousRuntime(job)).resume(await frozenPrevious(job), signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await preparation.cleanup(job, signal);
    },
  };
}
