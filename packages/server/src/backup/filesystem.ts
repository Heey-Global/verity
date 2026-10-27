import { BackupFileChangedError } from './capture-errors.js';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import type { CaptureEntry } from './repository.js';
import { validateBackupPath } from './format.js';

/** Linux fd-relative traversal: no sandbox-controlled ancestor is re-resolved after opening. */
function relative(handle: FileHandle, name: string): string {
  return `/proc/self/fd/${handle.fd}/${name}`;
}
export interface CaptureTreeOptions {
  prefix: string;
  signal?: AbortSignal;
  excludeRegenerable: boolean;
  onExcluded: (path: string, bytes: bigint) => void;
  /** A frozen Git copy must report any replacement since directory enumeration. */
  requireStableIdentity?: boolean;
  /** Inventory and final capture both omit live .git trees in favor of their private freezes. */
  onGit?: (path: string, kind: 'directory' | 'file' | 'symlink') => void;
}
const REGENERABLE = new Set([
  'node_modules',
  '.venv',
  'target',
  '__pycache__',
  '.gradle',
  '.turbo',
  '.cache',
]);

async function excludedSize(parent: FileHandle, name: string, depth: number): Promise<bigint> {
  if (depth > 256) throw new Error('Backup directory depth exceeds limit');
  const path = relative(parent, name);
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) return info.isFile() ? info.size : 0n;
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const actual = await directory.stat({ bigint: true });
    if (actual.ino !== info.ino || actual.dev !== info.dev)
      throw new Error('Backup directory changed during inventory');
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    let size = 0n;
    for await (const entry of entries) size += await excludedSize(directory, entry.name, depth + 1);
    return size;
  } finally {
    await directory.close();
  }
}

/** Yields only pinned regular files, directories and recorded symlinks; never follows a symlink. */
export async function* captureTree(
  root: string,
  options: CaptureTreeOptions,
): AsyncGenerator<CaptureEntry> {
  options.signal?.throwIfAborted();
  validateBackupPath(options.prefix);
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let count = 0;
  async function* walk(
    parent: FileHandle,
    prefix: string,
    depth: number,
  ): AsyncGenerator<CaptureEntry> {
    if (depth > 256) throw new Error('Backup directory depth exceeds limit');
    const entries = await opendir(`/proc/self/fd/${parent.fd}`);
    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (++count > 50000) throw new Error('Backup path count exceeds limit');
      const path = posix.join(prefix, entry.name);
      validateBackupPath(path);
      const fdPath = relative(parent, entry.name);
      const info = await lstat(fdPath, { bigint: true });
      if (entry.name === '.git' && options.onGit) {
        if (info.isDirectory()) {
          options.onGit(path, 'directory');
          continue;
        }
        if (info.isSymbolicLink()) {
          options.onGit(path, 'symlink');
          continue;
        }
        if (info.isFile()) options.onGit(path, 'file');
      }
      if (
        options.excludeRegenerable &&
        info.isDirectory() &&
        (REGENERABLE.has(entry.name) ||
          (entry.name === 'cache' && posix.basename(prefix) === '.next'))
      ) {
        options.onExcluded(path, await excludedSize(parent, entry.name, depth));
        continue;
      }
      if (info.isSymbolicLink()) {
        yield { kind: 'symlink', path, target: await readlink(fdPath) };
      } else if (info.isDirectory()) {
        const child = await open(
          fdPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const actual = await child.stat({ bigint: true });
          if (actual.ino !== info.ino || actual.dev !== info.dev)
            throw new Error('Backup directory changed while opening');
          yield { kind: 'directory', path, mode: Number(actual.mode & 0o777n) };
          yield* walk(child, path, depth + 1);
        } finally {
          await child.close();
        }
      } else if (info.isFile()) {
        let unstable = false;
        async function* source(attempt: number): AsyncGenerator<Buffer> {
          const file = await open(
            fdPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const actual = await file.stat({ bigint: true });
            if (!actual.isFile()) throw new Error('Backup source is no longer a regular file');
            if (
              options.requireStableIdentity &&
              (actual.ino !== info.ino || actual.dev !== info.dev)
            )
              throw new BackupFileChangedError();
            if (actual.size > BigInt(Number.MAX_SAFE_INTEGER))
              throw new Error('Backup file size exceeds limit');
            const buffer = Buffer.allocUnsafe(256 * 1024);
            let position = 0;
            while (position < Number(actual.size)) {
              const { bytesRead } = await file.read(
                buffer,
                0,
                Math.min(buffer.length, Number(actual.size) - position),
                position,
              );
              if (!bytesRead) break;
              position += bytesRead;
              yield Buffer.from(buffer.subarray(0, bytesRead));
            }
            const after = await file.stat({ bigint: true });
            unstable =
              after.size !== actual.size ||
              after.mtimeNs !== actual.mtimeNs ||
              after.ctimeNs !== actual.ctimeNs;
            if (unstable && attempt < 2) throw new BackupFileChangedError();
          } finally {
            await file.close();
          }
        }
        yield {
          path,
          mode: Number(info.mode & 0o777n),
          source,
          sizeBytes: info.size,
          unstable: () => unstable,
        };
      } else if (!info.isSocket()) {
        // Sockets are regenerable control state; device nodes/FIFOs must never block the Server.
        throw new Error('Unsupported special file in backup scope');
      } else options.onExcluded(path, 0n);
    }
  }
  try {
    yield {
      kind: 'directory',
      path: options.prefix,
      mode: Number((await directory.stat()).mode & 0o777),
    };
    yield* walk(directory, options.prefix, 0);
  } finally {
    await directory.close();
  }
}
