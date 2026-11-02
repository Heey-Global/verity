import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BackupLockBusyError, withRepositoryLock } from './repository-lock.js';
import { readBounded } from './repository.js';

const OWNER = 'verity-capture-v1';

/** Serialize creation and recovery; a run's kernel lock, never its age, proves it is active. */
export async function withCaptureStaging<T>(
  root: string,
  action: (run: string) => Promise<T>,
): Promise<T> {
  const parent = join(root, 'capture');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const pinned = `/proc/${process.pid}/fd/${directory.fd}`;
    // Hold the creation lock until the run lock is acquired, closing the create/cleanup race.
    let ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let runWork!: Promise<T>;
    await withRepositoryLock(join(pinned, 'staging.lock'), async () => {
      await cleanup(pinned);
      const run = await mkdtemp(join(pinned, 'run-'));
      await writeFile(join(run, 'owner'), OWNER, { flag: 'wx', mode: 0o600 });
      runWork = withRepositoryLock(join(run, 'lock'), async () => {
        ready();
        // Defer the action until the creator releases staging.lock.
        await released;
        try {
          return await action(run);
        } finally {
          await rm(run, { recursive: true, force: true });
        }
      });
      await Promise.race([acquired, runWork]);
    }).finally(() => release());
    return await runWork;
  } finally {
    await directory.close();
  }
}

async function cleanup(parent: string): Promise<void> {
  let count = 0;
  for await (const entry of await opendir(parent)) {
    if (++count > 10000) throw new Error('Capture staging entry budget exceeded');
    if (!/^run-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const path = join(parent, entry.name);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory()) continue;
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const actual = await directory.stat();
      if (actual.ino !== info.ino || actual.dev !== info.dev)
        throw new Error('Capture staging changed during recovery');
      const pinned = `/proc/${process.pid}/fd/${directory.fd}`;
      let owner: string;
      try {
        owner = (await readBounded(join(pinned, 'owner'), 64)).toString();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (owner !== OWNER) continue;
      try {
        await withRepositoryLock(join(pinned, 'lock'), async () => {
          await rm(path, { recursive: true, force: true });
        });
      } catch (error) {
        if (!(error instanceof BackupLockBusyError)) throw error;
      }
    } finally {
      await directory.close();
    }
  }
}
