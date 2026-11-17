import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function digest(path: string, signal: AbortSignal): Promise<string> {
  const file = await open(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) return hash.digest('hex');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

export interface DependencySharing {
  files: number;
  bytes: number;
}

/**
 * `verity-dependencies` activates a central inventory by linking its read-only
 * files into the session (see docs/session-dependencies.md). Sessions activated
 * before that hold a private copy of every package file. A copy that is
 * byte-identical to the sealed inventory named by the session's own receipt is
 * replaced by a link to the inventory's file, so it stops costing space. Edited,
 * unknown, differing or already linked files are left exactly as they are, and
 * the receipts npm rewrites in place stay private.
 *
 * Callers hold the session's claim, so no turn of the session runs meanwhile;
 * a write that lands during the comparison still keeps the file.
 */
export async function shareOwnDependencyFiles(
  root: string,
  worktree: string,
  signal: AbortSignal,
  dryRun = false,
): Promise<DependencySharing> {
  const result = { files: 0, bytes: 0 };
  const modules = join(worktree, 'node_modules');
  let identity: unknown;
  try {
    identity = (
      JSON.parse(await readFile(join(modules, '.verity-install.json'), 'utf8')) as {
        identity?: unknown;
      } | null
    )?.identity;
  } catch {
    return result;
  }
  if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/u.test(identity)) return result;
  const inventory = join(root, '.git', 'verity-dependencies', identity);
  const central = join(inventory, 'node_modules');
  try {
    // Only a sealed inventory has read-only files that are safe to share.
    if (
      (await readFile(join(inventory, 'sealed'), 'utf8')) !== 'v1' ||
      (await realpath(central)) !== central ||
      (await realpath(modules)) !== modules ||
      // A session running as root ignores read-only files; it keeps its copies.
      (await lstat(modules)).uid === 0
    )
      return result;
  } catch {
    return result;
  }
  const pending = [''];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(join(modules, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      const name = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(name);
      if (!entry.isFile() || directory === '') continue;
      const path = join(modules, name);
      const shared = join(central, name);
      const [before, source] = await Promise.all([
        lstat(path).catch(() => undefined),
        lstat(shared).catch(() => undefined),
      ]);
      if (
        !before?.isFile() ||
        !source?.isFile() ||
        before.nlink > 1 ||
        source.dev !== before.dev ||
        source.mode & 0o222 ||
        source.size !== before.size ||
        // Write bits are the only difference sharing introduces.
        (source.mode & 0o7555) !== (before.mode & 0o7555) ||
        (await digest(path, signal)) !== (await digest(shared, signal))
      )
        continue;
      const latest = await lstat(path);
      if (
        latest.ino !== before.ino ||
        latest.size !== before.size ||
        latest.mtimeMs !== before.mtimeMs ||
        latest.ctimeMs !== before.ctimeMs
      )
        continue;
      // A directory swapped for a link since the listing must not redirect either path.
      const placed = async () =>
        (await realpath(dirname(path))) === dirname(path) &&
        (await realpath(dirname(shared))) === dirname(shared);
      if (!(await placed())) continue;
      if (!dryRun) {
        const temporary = `${path}.verity-share-${randomUUID()}`;
        try {
          try {
            await link(shared, temporary);
          } catch (error) {
            // Another filesystem or link protection: this file stays a copy.
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EACCES'].includes(code)) continue;
            throw error;
          }
          // Only the very file that was compared may take the copy's place.
          const linked = await lstat(temporary);
          if (linked.ino !== source.ino || linked.dev !== source.dev || !(await placed())) continue;
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      result.files++;
      result.bytes += before.blocks * 512;
    }
  }
  return result;
}

const run = promisify(execFile);

/**
 * Runs {@link shareOwnDependencyFiles} with no more rights than the session has:
 * the paths it links and renames are under the session's control, so a Server
 * with other rights would let a session redirect them. With the owner's own uid
 * it runs in process; as root, in a worker process under the owner's uid and
 * gid. Otherwise, and for installations that belong to root, it shares nothing.
 */
export async function shareDependencyFiles(
  root: string,
  worktree: string,
  signal: AbortSignal,
  dryRun = false,
  worker = fileURLToPath(new URL('./dependency-sharing-main.js', import.meta.url)),
): Promise<DependencySharing> {
  let owner;
  try {
    owner = await lstat(join(worktree, 'node_modules'));
  } catch {
    return { files: 0, bytes: 0 };
  }
  const uid = process.geteuid?.();
  if (!owner.isDirectory() || owner.uid === 0 || uid === undefined) return { files: 0, bytes: 0 };
  if (uid === owner.uid) return shareOwnDependencyFiles(root, worktree, signal, dryRun);
  if (uid !== 0 || !existsSync(worker)) return { files: 0, bytes: 0 };
  const { stdout } = await run(
    process.execPath,
    [worker, root, worktree, dryRun ? 'dry-run' : 'apply'],
    { uid: owner.uid, gid: owner.gid, env: { PATH: process.env.PATH }, signal, maxBuffer: 4096 },
  );
  const result = JSON.parse(stdout) as Partial<DependencySharing>;
  return {
    files: Number.isSafeInteger(result.files) ? result.files! : 0,
    bytes: Number.isSafeInteger(result.bytes) ? result.bytes! : 0,
  };
}
