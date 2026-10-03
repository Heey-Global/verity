import { createHash } from 'node:crypto';
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
import { isProbablyText, type KnowledgeFileSlot } from './session-files.js';

export const MAX_EDIT_BYTES = 1_000_000;
export const fileVersion = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export class FileWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Capture before checking the version, then publish without replacing any new
 * save at the original name. The staging directory is pinned against symlink
 * substitution, just like the validated parent slot. */
export async function writeSessionText(
  slot: KnowledgeFileSlot,
  content: string,
  expected: string | null,
) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) throw new FileWriteError(413, 'file is too large to edit');
  if (!isProbablyText(bytes)) throw new FileWriteError(415, 'content must be UTF-8 text');
  const staging = await mkdtemp(`${slot.directoryPath}/.verity-edit-`);
  const handle = await open(
    staging,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const pinned = `/proc/self/fd/${handle.fd}`;
  const previous = `${pinned}/original`;
  const temporary = `${pinned}/new`;
  const destination = `${slot.directoryPath}/${slot.name}`;
  const readCaptured = async () => {
    const file = await open(previous, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw new FileWriteError(409, 'file was replaced');
      if (stats.size > MAX_EDIT_BYTES) throw new FileWriteError(413, 'file is too large to edit');
      return await file.readFile();
    } finally {
      await file.close();
    }
  };
  let captured = false;
  let preserve = false;
  try {
    let mode = 0o644;
    if (expected !== null) {
      try {
        await rename(destination, previous);
        captured = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new FileWriteError(409, 'file changed or was removed; reload before saving');
        throw error;
      }
      const stats = await lstat(previous);
      if (!stats.isFile()) throw new FileWriteError(409, 'file was replaced; reload before saving');
      if (stats.size > MAX_EDIT_BYTES) throw new FileWriteError(413, 'file is too large to edit');
      const current = await readCaptured();
      if (!isProbablyText(current)) throw new FileWriteError(415, 'file is not UTF-8 text');
      if (fileVersion(current) !== expected)
        throw new FileWriteError(409, 'file changed; reload, overwrite, or save a copy');
      mode = stats.mode & 0o777;
    }
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await output.writeFile(bytes);
      await output.chmod(mode);
      await output.sync();
    } finally {
      await output.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new FileWriteError(409, 'file already exists or changed while saving');
      throw error;
    }
    // A descriptor writer may still be modifying the captured inode. Preserve
    // that version for recovery rather than silently discarding a detected save.
    if (captured && fileVersion(await readCaptured()) !== expected) {
      preserve = true;
      throw new FileWriteError(409, `Concurrent save preserved at ${await realpath(previous)}`);
    }
    return {
      path: slot.rel,
      content,
      size: bytes.length,
      version: fileVersion(bytes),
      editable: true,
    };
  } catch (error) {
    if (captured && !preserve) {
      try {
        if ((await lstat(previous)).isDirectory()) {
          await mkdir(destination);
          await rename(previous, destination);
          captured = false;
        } else {
          await link(previous, destination);
        }
      } catch {
        preserve = true;
        throw new FileWriteError(
          409,
          `File changed while saving; original preserved at ${await realpath(previous)}`,
        );
      }
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
    if (captured && !preserve) await unlink(previous).catch(() => undefined);
    await handle.close();
    if (!preserve) await rmdir(staging).catch(() => undefined);
  }
}
