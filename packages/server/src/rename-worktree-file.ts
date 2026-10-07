import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Capture the source atomically before publishing it without replacement.
 * An agent's atomic save after capture recreates the source; never unlink that
 * path afterwards, since it now holds a different file. */
export async function renameWorktreeFile(source: string, destination: string): Promise<void> {
  const staging = await mkdtemp(join(dirname(source), '.verity-rename-'));
  const handle = await open(
    staging,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const captured = `/proc/self/fd/${handle.fd}/file`;
  let retained = false;
  try {
    await rename(source, captured);
    retained = true;
    try {
      if (!(await lstat(captured)).isFile()) throw new Error('Only files can be renamed');
      await link(captured, destination);
    } catch (error) {
      try {
        // Roll back without replacing a new save at the original name either.
        if ((await lstat(captured)).isDirectory()) {
          // Reserve an empty directory: renaming a directory over a file or a
          // nonempty directory fails, so concurrent content cannot be replaced.
          await mkdir(source);
          await rename(captured, source);
          retained = false;
        } else {
          await link(captured, source);
        }
      } catch {
        const recoveryPath = await realpath(captured).catch(() => captured);
        throw new Error(`Rename failed; the original file is preserved at ${recoveryPath}`, {
          cause: error,
        });
      }
      if (retained) await unlink(captured);
      retained = false;
      throw error;
    }
    await unlink(captured);
    retained = false;
  } finally {
    await handle.close();
    if (!retained) await rmdir(staging).catch(() => undefined);
  }
}
