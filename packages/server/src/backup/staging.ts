import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseManifest, type BackupManifest } from './format.js';
import { restoreFile } from './repository.js';
import { withRepositoryLock } from './repository-lock.js';

/** Extract only into a new private tree. Nothing is promoted until the installer validates it. */
export async function stageSnapshot(
  destination: string,
  backupRoot: string,
  manifest: BackupManifest,
  recoveryKey: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // Revalidate even when the caller constructed a manifest instead of reading it.
  const checked = parseManifest(
    Buffer.from(JSON.stringify(manifest)),
    manifest.repository,
    manifest.sequence,
  );
  return withRepositoryLock(join(backupRoot, checked.repository, 'lock'), async () => {
    const staging = await mkdtemp(join(destination, '.verity-restore-'));
    await chmod(staging, 0o700);
    try {
      for (const directory of checked.directories ?? []) {
        signal?.throwIfAborted();
        await mkdir(join(staging, directory.path), { recursive: true, mode: 0o700 });
      }
      for (const file of checked.files) {
        signal?.throwIfAborted();
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          for await (const bytes of restoreFile(backupRoot, checked, file, recoveryKey, signal)) {
            // writeFile can buffer/retain an async iterable; explicit bounded chunks keep memory predictable.
            await handle.writeFile(bytes);
          }
          await handle.chmod(file.mode);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      // No filesystem writes traverse a restored symlink: links come after all files/directories.
      for (const link of checked.symlinks ?? []) {
        signal?.throwIfAborted();
        const target = join(staging, link.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await symlink(link.target, target);
      }
      for (const directory of [...(checked.directories ?? [])].sort(
        (a, b) => b.path.split('/').length - a.path.split('/').length,
      )) {
        await chmod(join(staging, directory.path), directory.mode);
      }
      signal?.throwIfAborted();
      return staging;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  });
}
