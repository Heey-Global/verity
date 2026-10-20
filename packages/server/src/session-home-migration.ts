import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Copy only attributed native artifacts. Originals remain until session deletion.
 * The caller holds the session's backend handoff fence, so its source is quiescent.
 * Refuse links rather than importing a pointer into another session's storage. */
export async function migrateSessionArtifact(
  source: string,
  destination: string,
  runtimeDir: string,
): Promise<void> {
  const root = await realpath(runtimeDir);
  if (!within(root, source) || !within(root, destination))
    throw new Error('Migration escaped runtime');
  for (const path of [source, dirname(destination)]) {
    const components = relative(root, path).split('/').filter(Boolean);
    let current = root;
    for (const component of components) {
      current = join(current, component);
      const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (metadata?.isSymbolicLink()) throw new Error('Migration refuses symbolic links');
    }
  }
  const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source))
      await migrateSessionArtifact(join(source, entry), join(destination, entry), root);
    return;
  }
  if (!metadata.isFile()) throw new Error('Migration refuses non-regular artifacts');
  // A migrated or subsequently updated destination is authoritative on retries.
  if (
    await lstat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    )
  )
    return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.migration`;
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    const output = await open(temporary, 'wx', 0o600);
    const originalHash = createHash('sha256');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        originalHash.update(chunk);
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('Native session artifact changed during migration');
    const verify = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    const copiedHash = createHash('sha256');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await verify.read(buffer);
        if (!bytesRead) break;
        copiedHash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await verify.close();
    }
    if (copiedHash.digest('hex') !== originalHash.digest('hex'))
      throw new Error('Native session migration verification failed');
    await rename(temporary, destination);
  } finally {
    await input.close();
    await rm(temporary, { force: true });
  }
}
