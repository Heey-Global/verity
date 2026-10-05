import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative, isAbsolute, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { GitOutput } from './branches.js';

/** Transfer only Git objects, using bounded-memory streams and Git inside each sandbox. */
export async function transferSessionCommit(opts: {
  source: string;
  destination: string;
  sourceGit: GitOutput;
  destinationGit: GitOutput;
  commit?: string;
}): Promise<{ ref: string; cleanup: () => Promise<void> }> {
  const source = resolve(opts.source);
  const destination = resolve(opts.destination);
  const pinCheckout = (checkout: string): number => {
    const fd = openSync(
      checkout,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (realpathSync(`/proc/self/fd/${String(fd)}`) !== checkout) {
      closeSync(fd);
      throw new Error('Git transfer requires real checkout paths');
    }
    return fd;
  };
  const sourceRootFd = pinCheckout(source);
  let destinationRootFd: number;
  try {
    destinationRootFd = pinCheckout(destination);
  } catch (error) {
    closeSync(sourceRootFd);
    throw error;
  }
  const sourceRoot = `/proc/self/fd/${String(sourceRootFd)}`;
  const destinationRoot = `/proc/self/fd/${String(destinationRootFd)}`;
  let sourcePinnedDir: string;
  let destinationPinnedDir: string;
  try {
    sourcePinnedDir = mkdtempSync(join(sourceRoot, '.verity-transfer-'));
    destinationPinnedDir = mkdtempSync(join(destinationRoot, '.verity-transfer-'));
  } catch (error) {
    closeSync(sourceRootFd);
    closeSync(destinationRootFd);
    throw error;
  }
  const sourceDir = join(source, basename(sourcePinnedDir));
  const destinationDir = join(destination, basename(destinationPinnedDir));
  let cleaned = false;
  let destinationFd: number | undefined;
  const ref = `refs/verity/transfers/${randomUUID()}`;
  const cleanup = async (): Promise<void> => {
    await opts.sourceGit(['-C', source, 'update-ref', '-d', ref]).catch(() => undefined);
    await opts.destinationGit(['-C', destination, 'update-ref', '-d', ref]).catch(() => undefined);
    if (cleaned) return;
    cleaned = true;
    try {
      // Pin checkout ancestors too: a replaced checkout path must not redirect
      // recursive cleanup into another host directory.
      rmSync(sourcePinnedDir, { recursive: true, force: true });
      rmSync(destinationPinnedDir, { recursive: true, force: true });
    } finally {
      closeSync(sourceRootFd);
      closeSync(destinationRootFd);
    }
  };
  try {
    // Pin and validate the directory before opening a child: O_NOFOLLOW on the
    // bundle alone does not protect against an agent replacing an ancestor.
    const destinationDirectoryFd = openSync(
      destinationPinnedDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (realpathSync(`/proc/self/fd/${String(destinationDirectoryFd)}`) !== destinationDir)
        throw new Error('Unsafe Git bundle destination');
      destinationFd = openSync(
        `/proc/self/fd/${String(destinationDirectoryFd)}/commit.bundle`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } finally {
      closeSync(destinationDirectoryFd);
    }
    const commit =
      opts.commit ?? (await opts.sourceGit(['-C', source, 'rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit))
      throw new Error('Invalid Git transfer commit');
    await opts.sourceGit(['-C', source, 'update-ref', ref, commit]);
    const sourceBundle = join(sourceDir, 'commit.bundle');
    const destinationBundle = join(destinationDir, 'commit.bundle');
    await opts.sourceGit(['-C', source, 'bundle', 'create', relative(source, sourceBundle), ref]);
    const fd = openSync(sourceBundle, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Resolve the opened inode, not a raced pathname: an agent-created symlink in
      // an ancestor must never make the server broker copy an unrelated host file.
      const opened = realpathSync(`/proc/self/fd/${String(fd)}`);
      const rel = relative(sourceDir, opened);
      if (!fstatSync(fd).isFile() || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Unsafe Git bundle source');
      await pipeline(
        createReadStream(sourceBundle, { fd, autoClose: false }),
        createWriteStream(destinationBundle, { fd: destinationFd, autoClose: false }),
      );
    } finally {
      closeSync(fd);
    }
    if (realpathSync(destinationBundle) !== realpathSync(`/proc/self/fd/${String(destinationFd)}`))
      throw new Error('Unsafe Git bundle destination');
    await opts.destinationGit([
      '-C',
      destination,
      'fetch',
      '--no-write-fetch-head',
      relative(destination, destinationBundle),
      `${ref}:${ref}`,
    ]);
    return { ref, cleanup };
  } catch (error) {
    await cleanup();
    throw new Error('Session Git transfer failed', { cause: error });
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
  }
}
