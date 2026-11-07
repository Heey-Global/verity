import { constants } from 'node:fs';
import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';

/** Walk through pinned descriptors: a concurrent symlink replacement must never
 * redirect recursive removal into a directory outside the selected folder. */
export async function removeSessionDirectory(
  parent: string,
  name: string,
  onRemoved?: (relativePath: string) => Promise<void>,
): Promise<void> {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('invalid path');
  const walk = async (
    directory: string,
    entry: string,
    remove: boolean,
    relative: string,
  ): Promise<void> => {
    const path = `${directory}/${entry}`;
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      if (remove) {
        await unlink(path);
        await onRemoved?.(relative);
      }
      return;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const pinned = `/proc/self/fd/${String(handle.fd)}`;
      const children = await readdir(pinned);
      if (children.includes('.git'))
        throw new Error('Folders containing Git metadata cannot be deleted');
      for (const child of children)
        await walk(pinned, child, remove, [relative, child].filter(Boolean).join('/'));
      if (remove) await rmdir(path);
    } finally {
      await handle.close();
    }
  };
  // Refuse nested repositories before removing any of the folder's contents.
  await walk(parent, name, false, '');
  await walk(parent, name, true, '');
}
