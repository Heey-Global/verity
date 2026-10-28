import { constants } from 'node:fs';
import { mkdir, opendir, rm, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupRepository, readBounded, writeDurable } from './repository.js';
import { validateBackupState, type BackupState } from './state.js';
import { retainedSnapshots } from './retention.js';
import type { BackupDestination } from './destination.js';
import { BackupRevocationJournal } from './revocations.js';

/** Local host keys cannot decrypt snapshots; retain them to authenticate retired catalogs and checkpoints. */
export async function registerBackupGeneration(root: string, current: BackupState): Promise<void> {
  const directory = join(root, 'generations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, String(current.repositoryNumber));
  try {
    await writeDurable(path, Buffer.from(JSON.stringify(current)), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = validateBackupState(
      JSON.parse((await readBounded(path, 65536)).toString()),
      current.installationId,
    );
    if (
      existing.keyGeneration !== current.keyGeneration ||
      existing.targetId !== current.targetId ||
      JSON.stringify(existing.host) !== JSON.stringify(current.host)
    )
      throw new Error('Backup generation identity mismatch', { cause: error });
  }
}

/** Caller holds the installation operation lock; every catalog is validated before the first prune. */
export async function maintainBackupGenerations(
  root: string,
  destination: BackupDestination,
  current: BackupState,
  now: number,
  shouldPrune: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<void> {
  if (current.schedule.paused) return;
  await registerBackupGeneration(root, current);
  await destination.assertPresent();
  const records: { state: BackupState; repository: BackupRepository }[] = [];
  const known = new Set<string>();
  for await (const entry of await opendir(join(root, 'generations'))) {
    if (!/^[1-9][0-9]{0,8}$/.test(entry.name))
      throw new Error('Unexpected backup generation entry');
    if (records.length >= 1000) throw new Error('Backup generation budget exceeded');
    const state = validateBackupState(
      JSON.parse((await readBounded(join(root, 'generations', entry.name), 65536)).toString()),
      current.installationId,
    );
    if (
      String(state.repositoryNumber) !== entry.name ||
      state.targetId !== current.targetId ||
      state.repositoryNumber > current.repositoryNumber
    )
      throw new Error('Invalid backup generation catalog');
    const name = `${state.installationId}-r${state.repositoryNumber}`;
    known.add(name);
    const repository = new BackupRepository(destination.path, root, name, state.host, destination);
    records.push({ state, repository });
  }
  // Unknown repositories may still need any generation's CA and journal. Never guess their owner key.
  let count = 0;
  for await (const entry of await opendir(destination.pinnedPath('repositories'))) {
    if (++count > 50000) throw new Error('Installation repository budget exceeded');
    if (entry.name.startsWith(current.installationId + '-r') && !known.has(entry.name))
      throw new Error('Missing backup generation catalog; maintenance refused');
  }
  const catalog = [];
  for (const record of records) {
    const snapshots = await record.repository.retentionCatalog();
    if (catalog.length + snapshots.length > 50000)
      throw new Error('Installation retention catalog budget exceeded');
    catalog.push(...snapshots);
  }
  const retained = retainedSnapshots(catalog, now);
  const catalogued = new Set(
    catalog.map((snapshot) => `${snapshot.repositoryNumber}/${snapshot.sequence}`),
  );
  for (const { state, repository } of records) {
    if (!(await shouldPrune())) return;
    await repository.maintain({
      installationId: current.installationId,
      now,
      paused: false,
      retained,
      catalogued,
      emptyRetired: state.keyGeneration !== current.keyGeneration,
      shouldPrune,
    });
    if (state.keyGeneration === current.keyGeneration) continue;
    // A generation may own several repositories. Keep all identity material while any snapshot survives.
    const generation = records.filter((item) => item.state.keyGeneration === state.keyGeneration);
    let live = false;
    for (const item of generation)
      if ((await item.repository.retentionCatalog()).length) live = true;
    if (live) continue;
    const journal = new BackupRevocationJournal(
      destination,
      join(root, `key-${state.keyGeneration}`),
      state.installationId,
      state.keyGeneration,
      state.host,
    );
    await journal.retire(shouldPrune);
    if (!(await shouldPrune())) return;
    try {
      const identityRoot = destination.pinnedPath('identity');
      const identityInfo = await lstat(identityRoot);
      if (!identityInfo.isDirectory()) throw new Error('Backup identity must be a directory');
      const directory = await open(
        identityRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const actual = await directory.stat();
        if (actual.ino !== identityInfo.ino || actual.dev !== identityInfo.dev)
          throw new Error('Backup identity changed during open');
        const identity = join(
          `/proc/self/fd/${directory.fd}`,
          `${state.installationId}-ca-key-k${state.keyGeneration}`,
        );
        const info = await lstat(identity);
        if (!info.isFile()) throw new Error('Unexpected retired CA type');
        await rm(identity);
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Keep the empty repository and local catalog as durable ownership evidence for retry.
    // Its ciphertext objects are collected only by normal reference checks and the GC grace period.
  }
}
