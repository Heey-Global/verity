import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const escapes = (fromWorktree: string): boolean =>
  fromWorktree === '..' || fromWorktree.startsWith(`..${sep}`) || isAbsolute(fromWorktree);

async function readBounded(handle: FileHandle, maxBytes: number, tooLarge: string) {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) throw new Error(tooLarge);
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

/**
 * Read a regular file named relative to a session worktree. `label` names the tool
 * argument in errors; `tooLarge` is the message for a file above `maxBytes`.
 */
export async function readWorktreeFile(
  worktree: string,
  path: string,
  options: { label: string; maxBytes: number; tooLarge: string },
): Promise<Buffer> {
  if (isAbsolute(path)) throw new Error(`${options.label} must be relative`);
  const worktreeReal = await realpath(worktree);
  const target = resolve(worktreeReal, path);
  // Refuse an obvious escape before opening anything: opening a device outside the
  // worktree can have side effects even though the descriptor check below rejects it.
  const lexical = relative(worktreeReal, target);
  if (lexical === '' || escapes(lexical)) {
    throw new Error(`${options.label} must stay inside the session worktree`);
  }
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (handle === undefined) throw new Error(`${options.label} does not exist`);
  try {
    // Validate the opened object, not the pathname: an agent process may replace a
    // path component after resolution, while this descriptor continues to identify
    // the exact bytes we inspect and upload.
    const openedReal = await realpath(`/proc/self/fd/${handle.fd}`);
    const fromWorktree = relative(worktreeReal, openedReal);
    if (fromWorktree === '' || escapes(fromWorktree)) {
      throw new Error(`${options.label} must stay inside the session worktree`);
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${options.label} must name a file`);
    if (metadata.size > options.maxBytes) throw new Error(options.tooLarge);
    return await readBounded(handle, options.maxBytes, options.tooLarge);
  } finally {
    await handle.close();
  }
}
