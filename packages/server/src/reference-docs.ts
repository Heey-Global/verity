import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write imported Google Drive document bytes to `<referenceDir>/<fileName>` (ADR
 * 0009), overwriting any existing entry.
 *
 * The write goes to a fresh temp file in the SAME directory and is then
 * `rename()`d over the target. `rename` replaces the directory entry atomically
 * and does NOT follow a symlink sitting at the target — so a pre-existing symlink
 * at the deterministic target name (`<slug>-<fileIdHash8>.<ext>`) is REPLACED with
 * our regular file rather than having its out-of-tree referent overwritten at
 * server privilege. This preserves overwrite-on-reimport semantics while closing
 * the planted-symlink escape that a plain `writeFile(path, …, 'w')` would open
 * (the sibling meeting-transcript flow instead refuses to overwrite, using `wx` +
 * a symlink check).
 *
 * `referenceDir` MUST already be a validated real directory inside the session
 * worktree (the caller's `ensureReferenceDirectory` enforces that), and
 * `fileName` MUST be a bare, sanitized basename (no path separators).
 */
export async function writeReferenceDocFile(
  referenceDir: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    basename(fileName) !== fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error('reference document filename must be a bare filename');
  }
  const directory = await open(
    referenceDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const anchoredDir = `/proc/self/fd/${String(directory.fd)}`;
  const finalPath = join(anchoredDir, fileName);
  const tmpPath = join(anchoredDir, `.${randomUUID()}.tmp`);
  try {
    // Both entries are resolved relative to the already-open directory handle.
    // Renaming an ancestor after this point therefore cannot redirect either
    // the staging write or the final replacement outside the validated tree.
    await writeFile(tmpPath, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  } finally {
    await directory.close();
  }
}
