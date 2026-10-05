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
import { join, relative, isAbsolute, resolve } from 'node:path';
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
  if (realpathSync(source) !== source || realpathSync(destination) !== destination)
    throw new Error('Git transfer requires real checkout paths');
  const sourceDir = mkdtempSync(join(source, '.verity-transfer-'));
  const destinationDir = mkdtempSync(join(destination, '.verity-transfer-'));
  const ref = `refs/verity/transfers/${randomUUID()}`;
  const cleanup = async (): Promise<void> => {
    await opts.sourceGit(['-C', source, 'update-ref', '-d', ref]).catch(() => undefined);
    await opts.destinationGit(['-C', destination, 'update-ref', '-d', ref]).catch(() => undefined);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destinationDir, { recursive: true, force: true });
  };
  try {
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
        createWriteStream(destinationBundle, { flags: 'wx', mode: 0o600 }),
      );
    } finally {
      closeSync(fd);
    }
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
  }
}
