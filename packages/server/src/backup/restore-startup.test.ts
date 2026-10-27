import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertRestoreAccepted } from './restore-startup.js';
it('blocks normal startup for every pending marker including malformed files and dangling symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-startup-'));
  try {
    await expect(assertRestoreAccepted(root)).resolves.toBeUndefined();
    const marker = join(root, '.verity-recovery-pending');
    await writeFile(marker, '');
    await expect(assertRestoreAccepted(root)).rejects.toThrow('Recovery is pending');
    await rm(marker);
    await symlink(join(root, 'missing'), marker);
    await expect(assertRestoreAccepted(root)).rejects.toThrow('Recovery is pending');
    await rm(marker);
    await expect(assertRestoreAccepted(root)).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
