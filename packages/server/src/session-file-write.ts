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
import { openFileHistory, recoverFileHistory } from './session-file-history.js';
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
  await recoverFileHistory(slot.directoryPath);
  if (expected !== null) {
    try {
      if (!(await lstat(`${slot.directoryPath}/${slot.name}`)).isFile())
        throw new FileWriteError(409, 'file was replaced; reload before saving');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new FileWriteError(409, 'file changed or was removed; reload before saving');
      throw error;
    }
  }
  const history = await openFileHistory(slot.directoryPath);
  const historyPath = `/proc/self/fd/${history.fd}`;
  const staging = await mkdtemp(`${historyPath}/save-`);
  const handle = await open(
    staging,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const pinned = `/proc/self/fd/${handle.fd}`;
  const previous = `${pinned}/original`;
  const temporary = `${pinned}/new`;
  const destination = `${slot.directoryPath}/${slot.name}`;
  const complete = async () => {
    const parent = await open(slot.directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const done = await open(
      `${pinned}/complete`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await done.sync();
    await done.close();
    await handle.sync();
  };
  const readCaptured = async () => {
    const file = await open(previous, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw new FileWriteError(409, 'file was replaced');
      if (stats.size > MAX_EDIT_BYTES) throw new FileWriteError(413, 'file is too large to edit');
      const bytes = Buffer.alloc(MAX_EDIT_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_EDIT_BYTES) throw new FileWriteError(413, 'file is too large to edit');
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  };
  let captured = false;
  let preserve = false;
  try {
    const record = await open(
      `${pinned}/name`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await record.writeFile(slot.name);
    await record.sync();
    await record.close();
    await handle.sync();
    await history.sync();
    const durableParent = await open(
      slot.directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await durableParent.sync();
    } finally {
      await durableParent.close();
    }
    let mode = 0o644;
    if (expected !== null) {
      try {
        await rename(destination, previous);
        captured = true;
        await handle.sync();
        const parent = await open(slot.directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
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
      const snapshot = await open(
        `${pinned}/snapshot`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await snapshot.writeFile(current);
        await snapshot.sync();
      } finally {
        await snapshot.close();
      }
      await handle.sync();
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
    // Publication succeeded. Late descriptor writes remain recoverable through
    // the retained original inode; report success so extraction follows it.
    await complete();
    preserve = captured;
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
      } catch (restoreError) {
        preserve = true;
        if ((restoreError as NodeJS.ErrnoException).code === 'EEXIST') await complete();
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
    if (!preserve) {
      for (const name of ['name', 'snapshot', 'complete'])
        await unlink(`${pinned}/${name}`).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
    await handle.close();
    await history.close();
    // Retain the captured inode even after publication: an external process can
    // still write through a descriptor it opened before the explorer saved.
  }
}
