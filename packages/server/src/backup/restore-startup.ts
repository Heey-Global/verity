import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** A reviewed trial remains isolated until the installer commits acceptance. */
export async function assertRestoreAccepted(root: string): Promise<void> {
  try {
    await lstat(join(root, '.verity-recovery-pending'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot establish recovery acceptance', { cause: error });
  }
  throw new Error('Recovery is pending; use the installer trial, accept or abort operation');
}
