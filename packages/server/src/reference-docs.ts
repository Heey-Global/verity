import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const finalPath = join(referenceDir, fileName);
  const tmpPath = join(referenceDir, `.${randomUUID()}.tmp`);
  // `wx` on the temp file guarantees we never clobber an unrelated entry while
  // staging; the random name makes a collision effectively impossible.
  await writeFile(tmpPath, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}
