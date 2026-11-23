import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
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
import { capacityPreloadPath } from './verity-dependency-storage-preload.mjs';

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

/** Check every actual copy destination, including private trees on other mounts.
 * Charging the full bound to each filesystem is conservative when trees split
 * across devices, without mistaking free space beside Git metadata for theirs. */
export function admitCopyDestinations(
  destinations,
  growth,
  environment = process.env,
  sample = statfsSync,
) {
  if (destinations.length === 0)
    throw new Error('Dependency copy destinations are unknown; no additional copy admitted.');
  const admissions = destinations.map((path) => admitCopy(path, growth, environment, sample(path)));
  return {
    ...admissions[0],
    availableBytes: Math.min(...admissions.map((entry) => entry.availableBytes)),
    freeInodes: Math.min(...admissions.map((entry) => entry.freeInodes)),
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

const LEASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const LEASE_ROOT = '/run/verity-capacity-leases';

// Explanations the Server composes from amounts and fixed text (see
// dependency-capacity-route.ts). Any other response body stays unprinted.
const SERVER_REASON =
  /^(?:(?:Dependency capacity|Build storage admission|Storage reservation)[^\n]*|unauthorized|invalid dependency capacity request|session not found in this project)$/u;
const bounded = (text) => {
  const clean = String(text)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim();
  return clean.length > 400 ? `${clean.slice(0, 399)}…` : clean;
};
function serverReason(data) {
  try {
    const reason = JSON.parse(data)?.error;
    return typeof reason === 'string' && SERVER_REASON.test(reason) ? bounded(reason) : undefined;
  } catch {
    return undefined;
  }
}

/** Bounded machine authorization; never print capabilities or unrecognized broker bodies. */
export async function dependencyStorageRequest(body, environment = process.env) {
  const memory = environment.VERITY_PROJECT_MEMORY_URL ?? '';
  if (!/\/internal\/project\/memory$/u.test(memory))
    throw new Error(
      'Dependency capacity requires the project broker; restore sandbox provisioning.',
    );
  let url;
  let capability;
  try {
    url = new URL(memory.replace(/\/internal\/project\/memory$/u, '/internal/dependency-storage'));
    capability = readFileSync(
      environment.VERITY_GH_BROKER_CAPABILITY_FILE ?? '/run/verity/gh-token-capability',
      'utf8',
    ).trim();
  } catch {
    throw new Error('Dependency capacity broker configuration is unavailable.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !capability)
    throw new Error('Dependency capacity broker configuration is invalid.');
  const payload = JSON.stringify({ ...body, version: 1, sessionId: environment.VERITY_SESSION_ID });
  return new Promise((resolve, reject) => {
    let timer;
    const fail = (message) => {
      clearTimeout(timer);
      reject(new Error(message));
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${capability}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
          if (data.length > 16_384) request.destroy();
        });
        response.on('aborted', () => fail('Dependency capacity broker response was interrupted.'));
        response.on('error', () => fail('Dependency capacity broker response failed.'));
        response.on('end', () => {
          clearTimeout(timer);
          if ((response.statusCode ?? 500) >= 400 || (response.statusCode ?? 0) < 200) {
            const reason = serverReason(data);
            return fail(
              `Dependency capacity broker refused admission (HTTP ${response.statusCode ?? 500})${reason ? `: ${reason}` : '.'}`,
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            fail('Dependency capacity broker returned an invalid response.');
          }
        });
      },
    );
    request.on('error', () => fail('Dependency capacity broker request failed.'));
    timer = setTimeout(() => {
      fail('Dependency capacity broker request timed out after 30 seconds.');
      request.destroy();
    }, 30_000);
    request.end(payload);
  });
}

/** flock changes the shared open-file description, which survives in children. */
export async function flockCapacityDescriptor(fd) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn('flock', ['--shared', '--nonblock', '4'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ignore', fd],
    });
    child.once('error', () => reject(new Error('Dependency capacity holder could not start.')));
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error('Dependency capacity holder is unavailable.');
}

/** Whether `uid` is how this process sees files of the broker's root.
 *  The agent sandbox may run in a user namespace that maps only the agent's own
 *  id (gVisor hosts use mount isolation instead of Landlock). There every file of
 *  an unmapped owner, root included, appears as the overflow id. Files the agent
 *  creates always carry its own mapped id, so it cannot forge that owner, and the
 *  lease directory is a read-only view of the broker's. Where root is mapped,
 *  only uid 0 counts. Unreadable mappings trust uid 0 alone. */
export function rootOwned(uid, system = {}) {
  if (uid === 0) return true;
  try {
    const map = system.uidMap ?? readFileSync('/proc/self/uid_map', 'utf8');
    const ranges = map
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/u).map(Number));
    if (
      ranges.length === 0 ||
      !ranges.every((range) => range.length === 3 && range.every(Number.isSafeInteger))
    )
      return false;
    if (ranges.some(([inside, , count]) => inside <= 0 && 0 < inside + count)) return false;
    const overflow = Number(
      system.overflowUid ?? readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim(),
    );
    return (
      Number.isSafeInteger(overflow) &&
      uid === overflow &&
      !ranges.some(([inside, , count]) => inside <= overflow && overflow < inside + count)
    );
  } catch {
    return false;
  }
}

export async function holdCapacityLock(path, system = {}) {
  const root = system.root ?? LEASE_ROOT;
  const trusted = (uid) => (system.rootOwned ?? rootOwned)(uid, system);
  const id = path.slice(root.length + 1, -5);
  if (!LEASE_ID.test(id) || path !== `${root}/${id}.lock`)
    throw new Error('Dependency capacity lock path is invalid.');
  let resolved;
  try {
    resolved = realpathSync(root);
  } catch (error) {
    throw new Error(
      `Dependency capacity lock directory is not visible to this session (${error.code ?? 'unreadable'}).`,
      { cause: error },
    );
  }
  if (resolved !== root) throw new Error('Dependency capacity lock directory is unsafe.');
  const parent = lstatSync(root);
  if (!parent.isDirectory() || !trusted(parent.uid) || parent.mode & 0o022)
    throw new Error(
      `Dependency capacity lock directory is untrusted (owner ${parent.uid}, mode ${(parent.mode & 0o7777).toString(8)}).`,
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const expected = lstatSync(path);
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      !trusted(actual.uid) ||
      actual.mode & 0o022 ||
      expected.dev !== actual.dev ||
      expected.ino !== actual.ino
    )
      throw new Error(
        `Dependency capacity lock identity is untrusted (owner ${actual.uid}, mode ${(actual.mode & 0o7777).toString(8)}).`,
      );
    await flockCapacityDescriptor(fd);
    const after = lstatSync(path);
    if (after.dev !== actual.dev || after.ino !== actual.ino)
      throw new Error('Dependency capacity lock changed before admission.');
    return { fd, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Names why admission failed without echoing anything that could carry a
 *  credential: this module's own messages and filesystem error codes only. */
export function admissionFailureReason(error) {
  if (!(error instanceof Error)) return undefined;
  if (/^Dependency capacity /u.test(error.message))
    return bounded(error.message.replace(/\.$/u, ''));
  if (typeof error.code === 'string' && /^E[A-Z0-9]+$/u.test(error.code))
    return bounded(
      `${typeof error.syscall === 'string' ? `${error.syscall} ` : ''}${error.code}${typeof error.path === 'string' && error.path.startsWith(`${LEASE_ROOT}/`) ? ` on ${error.path}` : ''}`,
    );
  return undefined;
}

/** A lease is mandatory for managed sessions; standalone tools retain local checks. */
export async function beginCapacityLease(kind, growth, options = {}) {
  const environment = options.environment ?? process.env;
  if (!environment.VERITY_SESSION_ID) return { fd: undefined, release: async () => {} };
  const id = randomUUID();
  const request = options.request ?? ((body) => dependencyStorageRequest(body, environment));
  const path = `${LEASE_ROOT}/${id}.lock`;
  const validate = (reply, states) => {
    if (
      reply?.version !== 1 ||
      reply.id !== id ||
      !LEASE_ID.test(reply.id) ||
      reply.lockPath !== path ||
      reply.admitted !== true ||
      !states.includes(reply.state)
    )
      throw new Error('Dependency capacity lease was not admitted by the current broker.');
    return reply;
  };
  const transition = async (action, body, states) => {
    let reply;
    try {
      reply = await request({ version: 1, id, action, ...body });
    } catch (error) {
      // Lost replies must consult the same id, never reserve a second allowance.
      // When that cannot prove admission either, report the original refusal.
      try {
        return validate(await request({ version: 1, id, action: 'status' }), states);
      } catch {
        throw error;
      }
    }
    return validate(reply, states);
  };
  let holder;
  const settle = async () => {
    try {
      await request({ version: 1, id, action: 'settle' });
    } catch {
      // A hint cannot prove retirement. The broker keeps uncertain holders charged.
      console.warn('Dependency capacity settlement is pending broker reconciliation.');
    }
  };
  try {
    await transition('reserve', { kind, bytes: growth.bytes, inodes: growth.inodes }, ['reserved']);
    holder = await (options.hold ?? holdCapacityLock)(path);
    await transition('start', {}, ['started']);
    let released = false;
    return {
      fd: holder.fd,
      id,
      async release() {
        if (released) return;
        released = true;
        holder.close();
        await settle();
      },
    };
  } catch (error) {
    holder?.close();
    await settle();
    const reason = admissionFailureReason(error);
    // No cause: Node prints it for uncaught errors, and an unrecognized failure
    // may carry broker text or credentials that the reason deliberately omits.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Dependency capacity admission failed${reason ? ` (${reason})` : ''}; no additional dependency work started.`,
    );
  }
}

export function capacityChildOptions(lockFd, lease, environment) {
  return {
    stdio:
      lease?.fd === undefined
        ? ['inherit', 'inherit', 'inherit', lockFd]
        : ['inherit', 'inherit', 'inherit', lockFd ?? 'ignore', lease.fd],
    env:
      lease?.fd === undefined
        ? environment
        : {
            ...environment,
            VERITY_DEPENDENCY_STORAGE_FD: '4',
            VERITY_DEPENDENCY_STORAGE_LEASE_ID: lease.id,
            VERITY_DEPENDENCY_PREPARATION_FD: lockFd === undefined ? undefined : '3',
            NODE_OPTIONS:
              `${environment.NODE_OPTIONS ?? ''} --import=${JSON.stringify(capacityPreloadPath)}`.trim(),
          },
  };
}
