import { statfs } from 'node:fs/promises';

/** Free and total bytes of the filesystem holding `path`. */
export async function diskSpaceAt(
  path: string,
): Promise<{ freeBytes: number; totalBytes: number }> {
  const stats = await statfs(path);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}
