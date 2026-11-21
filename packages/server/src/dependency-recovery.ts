import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface RecoveryHolds {
  count: number;
  /** Lower bound when complete is false; hard-linked files are counted once per tree. */
  sampledBytes: number;
  oldestObservedAt: number | null;
  complete: boolean;
}

export interface DependencyCopyObservation {
  path: string;
  availableBytes: number;
  freeInodes: number;
  reserveBytes: number;
  reserveInodes: number;
  requiredBytes: number;
  requiredInodes: number;
  copiedFiles: number;
  copiedBytes: number;
  sharingEnabled: boolean;
  observedAt: string;
}

/** Activation receipts are untrusted evidence, never cleanup authority. */
export async function readDependencyCopyObservation(
  gitDir: string,
  worktree: string,
): Promise<DependencyCopyObservation | undefined> {
  try {
    const value = await readBoundedJson(join(gitDir, 'verity-dependencies-activation.json'));
    if (!value || typeof value !== 'object' || !('copyAdmission' in value)) return;
    const admission = value.copyAdmission;
    if (!admission || typeof admission !== 'object') return;
    const input = admission as Record<string, unknown>;
    const keys = [
      'availableBytes',
      'freeInodes',
      'reserveBytes',
      'reserveInodes',
      'requiredBytes',
      'requiredInodes',
      'copiedFiles',
      'copiedBytes',
    ] as const;
    const numbers = {} as Pick<DependencyCopyObservation, (typeof keys)[number]>;
    for (const key of keys) {
      const number = input[key];
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return;
      numbers[key] = number;
    }
    if (
      typeof input.sharingEnabled !== 'boolean' ||
      typeof input.observedAt !== 'string' ||
      input.observedAt.length > 40 ||
      !Number.isFinite(Date.parse(input.observedAt)) ||
      new Date(input.observedAt).toISOString() !== input.observedAt
    )
      return;
    return {
      path: worktree.slice(0, 500),
      ...numbers,
      sharingEnabled: input.sharingEnabled,
      observedAt: input.observedAt,
    };
  } catch {
    return;
  }
}

async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

const MARKER = 'verity-dependencies-recovery.json';
const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 100;

/** A bounded durable explanation, never an authority to delete recovery data. */
export async function recordRecoveryHolds(
  gitDir: string,
  holds: Array<{ path: string; reason: string }>,
  now: number,
  signal: AbortSignal,
  dryRun = false,
): Promise<RecoveryHolds> {
  const marker = join(gitDir, MARKER);
  let firstObservedAt = now;
  try {
    const stat = await lstat(marker);
    if (stat.isFile() && stat.size <= MAX_BYTES) {
      const previous = (await readBoundedJson(marker)) as { firstObservedAt?: unknown } | undefined;
      const previousAt = previous?.firstObservedAt;
      if (typeof previousAt === 'number' && Number.isFinite(previousAt) && previousAt > 0)
        firstObservedAt = Math.min(previousAt, now);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
      throw error;
  }
  const result: RecoveryHolds = {
    count: holds.length,
    sampledBytes: 0,
    oldestObservedAt: holds.length ? firstObservedAt : null,
    complete: true,
  };
  // Hold each opened directory while observing children through its descriptor.
  // A rename or symlink replacement can never redirect the walk to another tree.
  let remaining = 10_000;
  const inodes = new Set<string>();
  const sample = async (path: string): Promise<void> => {
    if (signal.aborted || remaining-- <= 0) {
      result.complete = false;
      return;
    }
    try {
      const stat = await lstat(path);
      const key = `${stat.dev}:${stat.ino}`;
      if (!inodes.has(key)) {
        inodes.add(key);
        result.sampledBytes += stat.blocks * 512;
      }
      if (!stat.isDirectory()) return;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const actual = await handle.stat();
        if (actual.dev !== stat.dev || actual.ino !== stat.ino) {
          result.complete = false;
          return;
        }
        // Unavailable descriptor paths leave a partial observation; never fall
        // back to following mutable directory names.
        const pinned = `/proc/self/fd/${handle.fd}`;
        const directory = await opendir(pinned);
        for await (const entry of directory) {
          if (signal.aborted || remaining <= 0) {
            result.complete = false;
            break;
          }
          await sample(join(pinned, entry.name));
        }
      } finally {
        await handle.close();
      }
    } catch {
      result.complete = false;
    }
  };
  for (const hold of holds) await sample(hold.path);
  if (dryRun) return result;
  if (!holds.length) {
    await rm(marker, { force: true });
    return result;
  }
  const value = {
    version: 1,
    firstObservedAt,
    observedAt: now,
    ...result,
    entries: holds.slice(0, MAX_ENTRIES).map(({ path, reason }) => ({
      path: path.slice(0, 500),
      reason: reason.slice(0, 500),
    })),
    entriesComplete: holds.length <= MAX_ENTRIES,
  };
  let content = JSON.stringify(value);
  while (Buffer.byteLength(content) > MAX_BYTES && value.entries.length) {
    value.entries.pop();
    value.entriesComplete = false;
    content = JSON.stringify(value);
  }
  await mkdir(gitDir, { recursive: true });
  if ((await lstat(gitDir)).isSymbolicLink())
    throw new Error('Recovery hold directory is symlinked');
  const temp = `${marker}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, marker);
    const directory = await open(gitDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
  return result;
}
