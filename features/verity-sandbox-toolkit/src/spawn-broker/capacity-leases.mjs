import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CAPACITY_LEASE_ROOT = '/run/verity-capacity-leases';
const ROOT = CAPACITY_LEASE_ROOT;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateCapacityLeaseRequest(request) {
  if (
    request?.protocolVersion !== 1 ||
    request.kind !== 'capacity-lease' ||
    !['create', 'status', 'retire'].includes(request.action) ||
    typeof request.operationId !== 'string' ||
    !UUID.test(request.operationId) ||
    typeof request.generation !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.generation)
  )
    throw new Error('invalid capacity lease request');
}

function safeFile(info, uid, mode) {
  return (
    info.isFile() &&
    info.uid === BigInt(uid) &&
    info.nlink === 1n &&
    (info.mode & 0o777n) === BigInt(mode)
  );
}
function identity(info) {
  return { device: String(info.dev), inode: String(info.ino) };
}
function same(a, b) {
  return a?.device === b?.device && a?.inode === b?.inode;
}
async function flock(handle, wait = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/flock',
      ['--exclusive', ...(wait ? ['--wait', '5'] : ['--nonblock']), '3'],
      { stdio: ['ignore', 'ignore', 'ignore', handle.fd] },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve(true)
        : code === 1
          ? resolve(false)
          : reject(new Error('capacity flock failed')),
    );
  });
}
async function rootDirectory(root, uid) {
  await mkdir(root, { mode: 0o755 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new Error('unsafe capacity lease directory');
  // Concurrent initializers can observe mkdir under umask 077 before chmod.
  // Normalize only the verified broker-owned, non-writable directory.
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await directory.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino)
      throw new Error('capacity directory changed');
    await directory.chmod(0o755);
  } finally {
    await directory.close();
  }
}
async function syncDirectory(root) {
  const handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function metadata(path, uid) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!safeFile(info, uid, 0o600) || info.size > 2048n) throw new Error('unsafe lease metadata');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid lease metadata');
    return value;
  } finally {
    await handle.close();
  }
}
async function persist(root, path, value) {
  const temporary = join(root, `.metadata-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(root);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Agents hold leases through a read-only view of this directory. A confined
 *  agent can only see it when it exists before launch, so the broker creates it
 *  up front rather than on the first lease request. */
export async function ensureCapacityLeaseRoot(options = {}) {
  const root = options.capacityLeaseRoot ?? ROOT;
  await rootDirectory(root, options.enforceRoot === false ? process.getuid() : 0);
  return root;
}

/** Only the trusted broker controls these inodes. Missing evidence never releases capacity. */
export async function capacityLeaseRequest(request, options = {}) {
  validateCapacityLeaseRequest(request);
  const root = options.capacityLeaseRoot ?? ROOT;
  const uid = options.enforceRoot === false ? process.getuid() : 0;
  const path = join(root, `${request.operationId}.lock`);
  const reply = (state, extra = {}) => ({
    ok: true,
    capacityLeaseVersion: 1,
    operationId: request.operationId,
    generation: request.generation,
    state,
    path,
    ...extra,
  });
  let registry;
  let lease;
  try {
    await rootDirectory(root, uid);
    registry = await open(
      join(root, '.registry.lock'),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    if (
      !safeFile(await registry.stat({ bigint: true }), uid, 0o600) ||
      !(await flock(registry, true))
    )
      return reply('unknown');
    const recordPath = join(root, `${request.operationId}.json`);
    let record;
    try {
      record = await metadata(recordPath, uid);
    } catch (error) {
      if (error.code !== 'ENOENT' || request.action !== 'create') return reply('unknown');
    }
    if (record) {
      if (
        record.operationId !== request.operationId ||
        record.generation !== request.generation ||
        !/^[0-9]+$/.test(record.identity?.device) ||
        !/^[0-9]+$/.test(record.identity?.inode)
      )
        return reply('unknown');
      if (record.state === 'retired') return reply('retired', { identity: record.identity });
      if (record.state !== 'live') return reply('unknown');
    } else {
      lease = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      await lease.chmod(0o644);
      const info = await lease.stat({ bigint: true });
      if (!safeFile(info, uid, 0o644)) return reply('unknown');
      record = {
        operationId: request.operationId,
        generation: request.generation,
        state: 'live',
        identity: identity(info),
      };
      await lease.sync();
      await persist(root, recordPath, record);
    }
    lease ??= await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await lease.stat({ bigint: true });
    if (!safeFile(info, uid, 0o644) || !same(identity(info), record.identity))
      return reply('unknown');
    if (!(await flock(lease))) return reply('held', { identity: record.identity });
    const current = await lstat(path, { bigint: true });
    if (!safeFile(current, uid, 0o644) || !same(identity(current), record.identity))
      return reply('unknown');
    if (request.action === 'retire') {
      // Persist the fence while the exclusive lock is held. A late reader can
      // acquire the old inode but cannot obtain a Server start acknowledgement.
      await persist(root, recordPath, { ...record, state: 'retired' });
      await unlink(path);
      await syncDirectory(root);
      return reply('retired', { identity: record.identity });
    }
    return reply('idle', { identity: record.identity });
  } catch {
    return reply('unknown');
  } finally {
    await lease?.close();
    await registry?.close();
  }
}
