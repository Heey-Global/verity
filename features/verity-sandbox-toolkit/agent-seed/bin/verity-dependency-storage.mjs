import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Every activated tree is a verbatim copy of a central installation. Without this
// record a later identity change could not tell such a copy from one carrying
// local edits once its central identity was retired, so each change kept another
// full copy of the dependencies in the worktree's Git directory.
const ACTIVATION_RECORD = 'verity-dependencies-activation.json';
function treeKey(stat) {
  return `${stat.dev}:${stat.ino}`;
}
/** The filesystem's current status change time, read from a probe file. */
export function statusTime(gitDir) {
  const probe = join(gitDir, `${ACTIVATION_RECORD}.${randomUUID()}`);
  try {
    writeFileSync(probe, '');
    return lstatSync(probe, { bigint: true }).ctimeNs;
  } finally {
    rmSync(probe, { force: true });
  }
}
export async function recordActivation(gitDir, root, placed, trees, copyAdmission) {
  if (placed === undefined) throw new Error('activation time is unknown');
  // Activation's own writes must have status change times strictly before the
  // record's; a timestamp granularity coarser than this only keeps copies.
  await delay(25);
  const record = join(gitDir, ACTIVATION_RECORD);
  const temporary = `${record}.${randomUUID()}`;
  try {
    // Stored as well: a later chmod or chown of the record moves its own status
    // time forward, which must never move the cutoff past an edit.
    writeFileSync(temporary, '');
    const at = lstatSync(temporary, { bigint: true }).ctimeNs;
    writeFileSync(
      temporary,
      JSON.stringify({
        version: 2,
        copyAdmission,
        at: String(at),
        placed: String(placed),
        trees: Object.fromEntries(
          [...trees].map(([tree, files]) => [
            relative(root, tree),
            { key: treeKey(lstatSync(tree, { bigint: true })), files },
          ]),
        ),
      }),
    );
    renameSync(temporary, record);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** The recorded identity and time of `directory`'s activation, if it is the very
 *  tree that was activated; undefined for unknown, unreadable or replaced trees. */
export function activationRecord(gitDir, root, directory) {
  try {
    const path = join(gitDir, ACTIVATION_RECORD);
    const marker = lstatSync(path, { bigint: true });
    const content = JSON.parse(readFileSync(path, 'utf8'));
    const entry = content?.version === 2 ? content.trees?.[relative(root, directory)] : undefined;
    const recorded = entry?.key;
    if (typeof entry?.files !== 'string') return undefined;
    const time = (value) =>
      typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? BigInt(value) : undefined;
    const at = time(content?.at);
    const placed = time(content?.placed);
    if (at === undefined || placed === undefined) return undefined;
    const top = lstatSync(directory, { bigint: true });
    // Status times are compared only within one filesystem: another one may keep
    // coarser timestamps or a different clock.
    if (!marker.isFile() || marker.dev !== top.dev) return undefined;
    if (!top.isDirectory() || recorded !== treeKey(top)) return undefined;
    const cutoff = at < marker.ctimeNs ? at : marker.ctimeNs;
    // A clock that is still behind the record would date later edits before it.
    if (statusTime(gitDir) <= cutoff) return undefined;
    // Below the roots, a change while activation finished must count as an edit.
    const below = placed < cutoff ? placed : cutoff;
    return { key: recorded, files: entry.files, dev: top.dev, ctimeNs: cutoff, below };
  } catch {
    return undefined;
  }
}
/** True only when no entry changed status since the record: any write, chmod,
 *  link, creation, removal or rename sets a status change time that file tools
 *  cannot set back. Only a host clock stepped backwards and then forward again
 *  past the record could hide a change. */
export function unchangedSince(directory, record, includeTop) {
  try {
    const files = [];
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop();
      const stat = lstatSync(current, { bigint: true });
      if (stat.dev !== record.dev) return false;
      if (current === directory) {
        if (!stat.isDirectory() || treeKey(stat) !== record.key) return false;
        if (includeTop && stat.ctimeNs >= record.ctimeNs) return false;
      } else if (stat.ctimeNs >= record.below && !stat.isDirectory()) {
        // Directories change status with their entries, which are checked below.
        // Sharing a file or retiring its inventory changes its status time, but a
        // read-only file cannot be written, and a write sets its modification time.
        if (!stat.isFile() || stat.mode & 0o222n || stat.mtimeNs >= record.below) return false;
      }
      if (stat.isFile()) files.push(fileIdentity(relative(directory, current), stat));
      if (stat.isDirectory())
        for (const entry of readdirSync(current)) pending.push(join(current, entry));
    }
    return filesKey(files) === record.files;
  } catch {
    return false;
  }
}
// Which inode backs each file: replacing or removing one changes it whatever its times.
export const fileIdentity = (name, stat) => `${name}\0${stat.ino}`;
export const filesKey = (files) =>
  createHash('sha256').update(files.sort().join('\n')).digest('hex');

/** Bound both the work and its allocation estimate; links never authorize a target walk. */
export function measureTrees(trees, limits = {}) {
  const maximum = limits.entries ?? 250_000;
  const deadline = Date.now() + (limits.milliseconds ?? 20_000);
  let entries = 0;
  let bytes = 0;
  let allocatedBytes = 0;
  const seen = new Set();
  for (const tree of trees) {
    if (realpathSync(dirname(tree)) !== dirname(tree))
      throw new Error('Dependency capacity inventory has a symlinked parent.');
    const device = lstatSync(tree).dev;
    const pending = [tree];
    while (pending.length) {
      if (++entries > maximum || Date.now() > deadline)
        throw new Error(
          'Dependency capacity inventory is incomplete; no additional copy admitted.',
        );
      const path = pending.pop();
      const stat = lstatSync(path);
      if (![stat.dev, stat.ino, stat.size, stat.blocks].every(Number.isSafeInteger))
        throw new Error('Dependency capacity inventory has an unknown file identity or size.');
      if (stat.dev !== device)
        throw new Error('Dependency capacity inventory crosses a filesystem.');
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
        throw new Error('Dependency capacity inventory contains an unsupported entry.');
      // Copying sparse files need not preserve their holes; account for their full size.
      bytes += Math.max(4096, stat.blocks * 512, Math.ceil(stat.size / 4096) * 4096);
      const key = `${stat.dev}:${stat.ino}`;
      if (!seen.has(key)) allocatedBytes += stat.blocks * 512;
      seen.add(key);
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(allocatedBytes))
        throw new Error('Dependency capacity inventory exceeds safe accounting limits.');
      if (stat.isDirectory())
        for (const entry of readdirSync(path)) pending.push(join(path, entry));
    }
  }
  return { bytes, inodes: entries, allocatedBytes };
}

/** A conservative full-copy bound; sharing may use less, never more by design. */
export function admitCopy(
  destination,
  growth,
  environment = process.env,
  disk = statfsSync(destination),
) {
  const positive = (name, fallback) => {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]{0,11}$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const reserveBytes = positive('VERITY_BUILD_FREE_GIB', 10) * 1024 ** 3;
  const reserveInodes = positive('VERITY_BUILD_FREE_INODES', 1_000_000);
  const availableBytes = disk.bavail * disk.bsize;
  const freeInodes = disk.ffree;
  if (
    ![availableBytes, freeInodes, growth.bytes, growth.inodes, reserveBytes].every(
      Number.isSafeInteger,
    ) ||
    availableBytes < 0 ||
    freeInodes < 0 ||
    growth.bytes < 0 ||
    growth.inodes < 0
  )
    throw new Error('Dependency capacity is unknown; no additional copy admitted.');
  if (availableBytes < growth.bytes + reserveBytes || freeInodes < growth.inodes + reserveInodes)
    throw new Error(
      `Dependency capacity admission rejected: ${availableBytes} available bytes and ${freeInodes} free inodes; requires ${growth.bytes} additional bytes and ${growth.inodes} inodes plus ${reserveBytes} bytes and ${reserveInodes} inodes reserve. Existing installations and recovery copies are preserved.`,
    );
  return {
    availableBytes,
    freeInodes,
    reserveBytes,
    reserveInodes,
    observedAt: new Date().toISOString(),
  };
}

/** At most one measured full installation may accumulate in recovery before replacement pauses. */
export function recoveryBudget(gitDir, replacementTrees, newlyPreservedTrees) {
  if (newlyPreservedTrees.length === 0) return;
  const preserved = join(gitDir, 'verity-dependencies-preserved');
  const exists = lstatSync(preserved, { throwIfNoEntry: false });
  if (exists && (!exists.isDirectory() || realpathSync(preserved) !== preserved))
    throw new Error('Dependency recovery directory is unsafe; no replacement admitted.');
  // The container directory is bookkeeping, not retained installation content.
  const held = exists
    ? measureTrees(readdirSync(preserved).map((name) => join(preserved, name))).allocatedBytes
    : 0;
  const added = measureTrees(newlyPreservedTrees).allocatedBytes;
  const replacement = measureTrees(replacementTrees).bytes;
  const budget = Math.max(replacement, added);
  if (held + added > budget)
    throw new Error(
      `Dependency recovery budget exceeded: ${held} retained bytes plus ${added} newly preserved bytes exceed the ${budget}-byte measured installation allowance. Resolve the existing recovery copies before replacing dependencies; no recovery data was deleted.`,
    );
}
