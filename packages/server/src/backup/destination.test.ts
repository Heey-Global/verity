import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupDestination } from './destination.js';
const capacity = vi.hoisted(() => ({ full: false }));
vi.mock('node:fs/promises', async (originalImport) => {
  const original = await originalImport<typeof import('node:fs/promises')>();
  return {
    ...original,
    statfs: async (...args: Parameters<typeof original.statfs>) => {
      const result = await original.statfs(...args);
      return capacity.full ? { ...result, bavail: 0n } : result;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  capacity.full = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('mounted backup destination', () => {
  it('validates the marker and space estimate and detects a replaced mount without redirecting writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verity-destination-'));
    roots.push(root);
    const path = join(root, 'mounted');
    await mkdir(path);
    const id = randomUUID();
    await writeFile(join(path, '.verity-backup-target'), id);
    const destination = await BackupDestination.open(path, id);
    try {
      expect((await destination.assertWritable()).availableBytes > 0n).toBe(true);
      await expect(destination.assertWritable(2n ** 120n)).rejects.toThrow('Insufficient');
      await rename(path, join(root, 'original'));
      await mkdir(path);
      await writeFile(join(path, '.verity-backup-target'), id);
      await expect(destination.assertWritable()).rejects.toThrow('replaced or unmounted');
      await mkdir(join(root, 'original', 'repositories'));
      await writeFile(destination.repositoryPath('pinned'), 'original mount');
      expect(await readFile(join(root, 'original', 'repositories', 'pinned'), 'utf8')).toBe(
        'original mount',
      );
      await expect(readFile(join(path, 'repositories', 'pinned'))).rejects.toThrow();
    } finally {
      await destination.close();
    }
  });
  it('rejects missing, mismatched or symlinked markers', async () => {
    const path = await mkdtemp(join(tmpdir(), 'verity-destination-'));
    roots.push(path);
    const id = randomUUID();
    await expect(BackupDestination.open(path, id)).rejects.toThrow();
    await writeFile(join(path, 'other'), id);
    await symlink('other', join(path, '.verity-backup-target'));
    await expect(BackupDestination.open(path, id)).rejects.toThrow();
    await rm(join(path, '.verity-backup-target'));
    await writeFile(join(path, '.verity-backup-target'), randomUUID());
    await expect(BackupDestination.open(path, id)).rejects.toThrow('mismatch');
  });
});

it('rejects a FIFO marker without waiting for a writer', async () => {
  const path = await mkdtemp(join(tmpdir(), 'verity-destination-'));
  roots.push(path);
  execFileSync('mkfifo', [join(path, '.verity-backup-target')]);
  await expect(BackupDestination.open(path, randomUUID())).rejects.toThrow(
    'Invalid backup target marker',
  );
});

it('opens an authenticated full destination so scheduled failures and alerts remain retryable after reboot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-full-boot-'));
  roots.push(root);
  const targetId = randomUUID();
  await writeFile(join(root, '.verity-backup-target'), targetId);
  capacity.full = true;
  const destination = await BackupDestination.open(root, targetId);
  try {
    await expect(destination.assertWritable()).rejects.toThrow('Insufficient');
    capacity.full = false;
    expect((await destination.assertWritable()).availableBytes > 0n).toBe(true);
  } finally {
    await destination.close();
  }
});
