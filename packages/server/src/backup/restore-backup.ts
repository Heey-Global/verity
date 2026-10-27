import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RestoreJob } from './restore-job.js';
import type { BackupDestination } from './destination.js';
import { BackupStateStore, type BackupState } from './state.js';
import { BackupRepository, readBounded, writeDurable } from './repository.js';
import { openMetadata, recoverHostKeys } from './crypto.js';
import { openCaIdentityReceipt, sealCaIdentityReceipt } from './identity-receipt.js';
import { withRepositoryLock } from './repository-lock.js';
import { DEFAULT_BACKUP_INTERVAL_MS } from './scheduler.js';

/** Runs after acceptance. Source repositories are never reused, pruned or modified. */
export async function initializeRestoredBackup(options: {
  job: RestoreJob;
  recoveryKey: string;
  stateRoot: string;
  destination: BackupDestination;
  caPrivateKey: Buffer;
  certificate: Buffer;
  /** Idempotently enable journaling/helper only after CA publication and configured state. */
  enable: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<BackupState> {
  const { job, destination, signal } = options;
  if (
    job.phase !== 'accepted' ||
    !job.verified ||
    job.installationId === job.verified.sourceInstallationId
  )
    throw new Error('A newly accepted installation is required to initialize backups');
  signal?.throwIfAborted();
  const host = await recoverHostKeys(
    options.recoveryKey,
    await readBounded(
      join(job.selection.source, 'repositories', job.selection.repository, 'keys'),
      16384,
    ),
    signal,
  );
  const store = new BackupStateStore(options.stateRoot, job.installationId);
  await mkdir(store.root, { recursive: true, mode: 0o700 });
  return withRepositoryLock(join(store.root, 'setup.lock'), async () => {
    await destination.assertWritable();
    let current = await store.load();
    if (
      current &&
      (current.targetId !== destination.targetId ||
        JSON.stringify(current.host) !== JSON.stringify(host))
    )
      throw new Error('Restored backup state contains an unrelated identity or destination');
    if (!current) {
      let number = 1;
      for (; number <= 10000; number++) {
        try {
          await lstat(destination.repositoryPath(`${job.installationId}-r${number}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
      }
      if (number > 10000) throw new Error('Too many incomplete restore backup repositories');
      current = {
        format: 1,
        installationId: job.installationId,
        targetId: destination.targetId,
        keyGeneration: number,
        repositoryNumber: number,
        confirmedAt: Date.now(),
        host,
        lastProbe: null,
        schedule: {
          intervalMs: DEFAULT_BACKUP_INTERVAL_MS,
          paused: true,
          lastSuccess: null,
          lastAttempt: null,
          failures: 0,
        },
      };
      await new BackupRepository(
        destination.path,
        store.root,
        `${job.installationId}-r${number}`,
        host,
        destination,
      ).initialize();
    }
    signal?.throwIfAborted();
    const repository = `${job.installationId}-r${current.repositoryNumber}`;
    const repositoryRoot = destination.repositoryPath(repository);
    const header: unknown = JSON.parse(
      (
        await openMetadata(
          options.recoveryKey,
          await readBounded(join(repositoryRoot, 'header'), 16384),
          signal,
        )
      ).toString(),
    );
    if (
      !header ||
      typeof header !== 'object' ||
      !('kind' in header) ||
      header.kind !== 'repository' ||
      !('repository' in header) ||
      header.repository !== repository
    )
      throw new Error('Restored backup repository header mismatch');
    const repositoryKeys = await recoverHostKeys(
      options.recoveryKey,
      await readBounded(join(repositoryRoot, 'keys'), 16384),
      signal,
    );
    if (JSON.stringify(repositoryKeys) !== JSON.stringify(host))
      throw new Error('Restored backup repository key mismatch');
    const path = destination.pinnedPath(
      'identity',
      `${job.installationId}-ca-key-k${current.keyGeneration}`,
    );
    await mkdir(destination.pinnedPath('identity'), { recursive: true, mode: 0o700 });
    try {
      openCaIdentityReceipt(
        await readBounded(path, 384 * 1024),
        options.certificate,
        job.installationId,
        current.keyGeneration,
        host.recipient,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const receipt = await sealCaIdentityReceipt(
        {
          recipient: host.recipient,
          installationId: job.installationId,
          keyGeneration: current.keyGeneration,
        },
        options.caPrivateKey,
        options.certificate,
      );
      await destination.assertWritable(BigInt(receipt.length));
      await writeDurable(path, receipt, true);
    }
    if (!(await store.load())) await store.create(current);
    try {
      const complete = (await readBounded(join(store.root, 'restore-complete'), 128)).toString();
      if (complete !== job.id) throw new Error('Backup initialization belongs to another restore');
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    signal?.throwIfAborted();
    await store.update((state) => ({ ...state, schedule: { ...state.schedule, paused: true } }));
    await options.enable();
    signal?.throwIfAborted();
    const active = await store.update((state) => ({
      ...state,
      schedule: { ...state.schedule, paused: false },
    }));
    await writeDurable(join(store.root, 'restore-complete'), Buffer.from(job.id), true);
    return active;
  });
}
