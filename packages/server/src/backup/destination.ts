import { constants } from 'node:fs';
import { lstat, open, statfs, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

/** Pin the mounted directory, and recheck both its pathname and installer marker before writes. */
export class BackupDestination {
  private constructor(
    readonly path: string,
    readonly targetId: string,
    private readonly directory: FileHandle,
  ) {}

  static async open(path: string, targetId: string): Promise<BackupDestination> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(targetId))
      throw new Error('Invalid backup target identity');
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const destination = new BackupDestination(path, targetId, directory);
    try {
      await destination.assertWritable();
      return destination;
    } catch (error) {
      await directory.close();
      throw error;
    }
  }

  async assertPresent(): Promise<void> {
    const pinned = await this.directory.stat({ bigint: true });
    const current = await lstat(this.path, { bigint: true });
    if (!current.isDirectory() || current.ino !== pinned.ino || current.dev !== pinned.dev)
      throw new Error('Backup destination was replaced or unmounted');
    const marker = await open(
      `/proc/self/fd/${this.directory.fd}/.verity-backup-target`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await marker.stat();
      if (!info.isFile() || info.size > 128) throw new Error('Invalid backup target marker');
      const bytes = Buffer.alloc(129);
      const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
      if (bytes.subarray(0, bytesRead).toString('utf8').trim() !== this.targetId)
        throw new Error('Backup target marker mismatch');
    } finally {
      await marker.close();
    }
  }

  async assertWritable(
    estimateBytes = 0n,
  ): Promise<{ availableBytes: bigint; nearlyFull: boolean }> {
    if (estimateBytes < 0n) throw new Error('Invalid backup space estimate');
    await this.assertPresent();
    const filesystem = await statfs(`/proc/self/fd/${this.directory.fd}/.`, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    // Preserve room for filesystem metadata and publication even if the inventory estimate is zero.
    const reserve = 64n * 1024n * 1024n;
    if (availableBytes < estimateBytes + reserve)
      throw new Error('Insufficient backup destination space');
    return {
      availableBytes,
      nearlyFull: availableBytes < (filesystem.blocks * filesystem.bsize) / 10n,
    };
  }

  pinnedPath(...parts: string[]): string {
    if (parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
      throw new Error('Invalid backup destination child path');
    return join(`/proc/${process.pid}/fd/${this.directory.fd}`, ...parts);
  }

  repositoryPath(name: string): string {
    return this.pinnedPath('repositories', name);
  }
  async close(): Promise<void> {
    await this.directory.close();
  }
}
