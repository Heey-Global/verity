import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, mkdir, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDockerClient } from '../docker.js';
import { readInstallerRestoreRequest } from './restore-installer-protocol.js';
import { InstallerRestoreJob, type RestoreJob } from './restore-job.js';
import { createRestoreLifecycle } from './restore-lifecycle.js';
import { readBounded, writeDurable } from './repository.js';
import { BackupDestination } from './destination.js';
import { initializeRestoredBackup } from './restore-backup.js';
import { reviewRestoreDevices } from './restore-review-client.js';
import { restoreDatabaseResources } from './restore-database-runtime.js';
import {
  startCanonicalRestoreDatabase,
  stopRestoreTrialRuntime,
  withCanonicalRestoreClient,
} from './restore-canonical-runtime.js';

async function ownTree(root: string, signal: AbortSignal): Promise<void> {
  let count = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (++count > 100000 || depth > 64)
      throw new Error('Restore ownership inventory limit exceeded');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if ((!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1))
        throw new Error('Unexpected restored backup state file');
      if (info.isDirectory()) {
        const pinned = `/proc/self/fd/${file.fd}/.`;
        for await (const entry of await opendir(pinned))
          await visit(join(pinned, entry.name), depth + 1);
      }
      await file.chown(1000, 1000);
    } finally {
      await file.close();
    }
  };
  await visit(root, 0);
}

export function createInstallerRestoreInitializer(
  config: Awaited<ReturnType<typeof readInstallerRestoreRequest>>['configuration'],
  docker: import('../docker.js').DockerClient,
  signal: AbortSignal,
) {
  return async (job: RestoreJob, recoveryKey: string) => {
    const live = '/restore-live';
    if (job.phase !== 'accepted') throw new Error('Durable acceptance required');
    // This mount is supplied only for an already promoted/accepted job, never during verification.
    const marker = join(live, '.verity-recovery-pending');
    try {
      if ((await readBounded(marker, 128)).toString() !== job.id)
        throw new Error('Canonical data belongs to another restore');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (
        (await readBounded(join(config.root, job.id, 'data-accepted'), 128)).toString() !== job.id
      )
        throw new Error('Canonical data acceptance checkpoint missing', { cause: error });
    }
    const targetMarker = join(config.backupDirectory, '.verity-backup-target');
    await mkdir(config.backupDirectory, { recursive: true, mode: 0o700 });
    let targetId: string;
    try {
      targetId = (await readBounded(targetMarker, 128)).toString().trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      targetId = randomUUID();
      await writeDurable(targetMarker, Buffer.from(targetId + '\n'), true);
      await chmod(targetMarker, 0o644);
    }
    const destination = await BackupDestination.open(config.backupDirectory, targetId);
    const caPrivateKey = await readBounded(join(config.hostRoot, 'tls-ca-key.pem'), 1024 * 1024);
    const certificate = await readBounded(join(config.hostRoot, 'tls-ca-cert.pem'), 1024 * 1024);
    const runtime = {
      docker,
      root: config.root,
      network: restoreDatabaseResources(job).prefix,
      job,
      signal,
    };
    try {
      // Initialization can resume after a successful prior attempt stopped the restricted database.
      await startCanonicalRestoreDatabase(runtime);
      const state = await initializeRestoredBackup({
        job,
        recoveryKey,
        stateRoot: join(live, 'backup-state'),
        destination,
        caPrivateKey,
        certificate,
        signal,
        enable: async () => {
          await withCanonicalRestoreClient(runtime, async (client) => {
            const updated = await client.query(
              'UPDATE backup_policy SET journal_enabled = true WHERE id = 1 RETURNING id',
            );
            if (updated.rows.length !== 1) throw new Error('Restore journal policy is missing');
          });
        },
      });
      await ownTree(join(live, 'backup-state'), signal);
      await ownTree(
        join(
          config.backupDirectory,
          'repositories',
          `${job.installationId}-r${state.repositoryNumber}`,
        ),
        signal,
      );
      await chown(config.backupDirectory, 1000, 1000);
      await chown(join(config.backupDirectory, 'repositories'), 1000, 1000);
      await chmod(join(config.backupDirectory, 'identity'), 0o755);
      await chmod(
        join(
          config.backupDirectory,
          'identity',
          `${job.installationId}-ca-key-k${state.keyGeneration}`,
        ),
        0o644,
      );
      signal.throwIfAborted();
      await stopRestoreTrialRuntime(runtime);
      await writeDurable(join(config.root, job.id, 'data-accepted'), Buffer.from(job.id), false);
      await rm(marker, { force: true });
      const directory = await open(live, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      caPrivateKey.fill(0);
      await destination.close();
    }
  };
}

/** Privileged, bounded stdin protocol; no normal server modules or background work are loaded. */
export async function runInstallerRestore(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('Installer restore requires root authority');
  const request = await readInstallerRestoreRequest(process.stdin);
  const config = request.configuration;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const signal = controller.signal;
  const docker = createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' });
  const initialize = createInstallerRestoreInitializer(config, docker, signal);
  const manager = new InstallerRestoreJob(
    config.root,
    createRestoreLifecycle({
      docker,
      root: config.root,
      liveRoot: '/srv/verity',
      hostRoot: config.hostRoot,
      tufCachePath: config.tufCachePath,
      hostNetworking: true,
      previousComposeProject: config.previousComposeProject,
      ...(config.previousManagedRoot ? { previousManagedRoot: config.previousManagedRoot } : {}),
      host: {
        root: config.root,
        addresses: config.addresses,
        backupDirectory: config.backupDirectory,
        ...(config.hostname ? { hostname: config.hostname } : {}),
      },
      recoveryKey: request.recoveryKey,
      masterPassword: request.masterPassword,
      initialize,
    }),
  );
  try {
    let result: unknown;
    if (config.action === 'begin') result = await manager.begin(config.selection!);
    else if (config.action === 'status') result = await manager.status();
    else {
      const job = await manager.status();
      if (!job || job.id !== config.jobId) throw new Error('Restore job not found');
      if (config.selection && JSON.stringify(config.selection) !== JSON.stringify(job.selection))
        throw new Error('Restore selection does not match the active checkpoint');
      if (config.action === 'advance')
        result = await manager.advance(job.id, request.recoveryKey, signal);
      else if (config.action === 'abort') result = await manager.abort(job.id, signal);
      else {
        if (!['trial', 'reviewing'].includes(job.phase))
          throw new Error('Staged trial required for device review');
        if (job.selection.newIdentity && config.keepIds?.length)
          throw new Error('New identity cannot retain old devices');
        result = await reviewRestoreDevices({
          root: config.root,
          jobId: job.id,
          masterPassword: request.masterPassword,
          ...(config.action === 'review' ? { keepIds: config.keepIds! } : {}),
          signal,
        });
      }
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    request.recoveryKey = '';
    request.masterPassword = '';
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
