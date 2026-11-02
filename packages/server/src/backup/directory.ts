import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

/** Keep an owned procfs capability intermediate while O_NOFOLLOW protects the final component. */
export function backupDirectorySyncPath(path: string): string {
  return new RegExp(`^/proc/(?:self|${process.pid})/fd/[0-9]+$`).test(path) ? path + '/.' : path;
}

/** Caller supplies a pinned ancestor; reject replacement of the final directory before using its FD. */
export async function openBackupDirectory(path: string): Promise<FileHandle> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error('Backup path must be a directory');
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat({ bigint: true });
    if (actual.ino !== info.ino || actual.dev !== info.dev)
      throw new Error('Backup directory changed during open');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
