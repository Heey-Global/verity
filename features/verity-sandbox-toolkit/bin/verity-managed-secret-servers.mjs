import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SECRET_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const RESERVED_ENV =
  /^(?:VERITY_|DOPPLER_|LD_|DYLD_|MALLOC_|LC_|NODE_|PYTHON|BASH|ENV$|PATH$|HOME$|SHELL$|LANG$|USER$|LOGNAME$|HOSTALIASES$|LOCALDOMAIN$|RES_OPTIONS$|TMPDIR$|TZDIR$|PORT$|IFS$|CDPATH$|SHELLOPTS$|BASHOPTS$|GCONV_PATH$|GETCONF_DIR$|GLIBC_TUNABLES$|LOCPATH$|NLSPATH$|PERL|RUBY|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$)/u;

/** Return only tagged PIDs; no environment values leave this helper. */
export async function listTaggedManagedPids(instanceId, procDir = '/proc') {
  if (!ID.test(instanceId)) throw new Error('invalid managed server identity');
  const marker = Buffer.from('VERITY_DEV_SERVER_INSTANCE=' + instanceId + '\0');
  const boundaryMarker = Buffer.concat([Buffer.from([0]), marker]);
  const pids = [];
  for (const name of await readdir(procDir)) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    let bytes;
    try {
      bytes = await readFile(procDir + '/' + name + '/environ');
      if (bytes.subarray(0, marker.length).equals(marker) || bytes.includes(boundaryMarker))
        pids.push(Number(name));
    } catch {
      /* A process may exit or belong to another identity. */
    } finally {
      bytes?.fill(0);
    }
  }
  return pids;
}

/** Run this helper after dropping identity, so a forged PID cannot signal a
 * process belonging to another user. */
export async function stopTaggedManagedPids(instanceId, signal) {
  if (!['SIGTERM', 'SIGKILL'].includes(signal)) throw new Error('invalid managed server signal');
  for (const pid of await listTaggedManagedPids(instanceId)) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      /* Already stopped. */
    }
  }
  return true;
}

// Resolve and open the private directory only after dropping to its owner's identity.
// Keep the directory handle as cwd: reopening the checked path permits symlink swaps.
const LAUNCH = `set -eu
cd -P -- "$1" || exit 3
root=$(pwd -P)
[ "$root" = "$1" ] || exit 4
cd -P -- "$2" || exit 3
target=$(pwd -P)
case "$target/" in "$root"/*) ;; *) exit 4 ;; esac
exec /bin/sh -lc "$3"`;

/** Managed secret processes belong to the broker, not to a turn or launch socket.
 * Output is deliberately discarded: arbitrary application encodings cannot be
 * reliably redacted, and raw output must never reach a persistent log. */
export function createManagedSecretServers(options) {
  const records = new Map();
  const pending = new Map();
  let closing = false;
  const spawnChild = options.spawnChild ?? spawn;
  const signal = async (record, value) => {
    // Exited leaders no longer own their PID; only tagged descendants remain identifiable.
    if (record.alive) {
      try {
        process.kill(-record.child.pid, value);
      } catch {
        try {
          record.child.kill(value);
        } catch {
          /* Already stopped. */
        }
      }
    }
    await options.stopTagged?.(record.instanceId, value).catch(() => undefined);
  };
  const stop = async (record) => {
    if (!record.alive) {
      await signal(record, 'SIGKILL');
      return;
    }
    await signal(record, 'SIGTERM');
    const escalation = setTimeout(() => {
      void signal(record, 'SIGKILL').catch(() => undefined);
    }, 1000);
    try {
      await record.closed;
    } finally {
      clearTimeout(escalation);
    }
  };
  const execute = async (raw) => {
    if (raw.protocolVersion !== 1 || !ID.test(raw.instanceId ?? ''))
      throw new Error('invalid managed server request');
    const record = records.get(raw.instanceId);
    switch (raw.kind) {
      case 'managed-secret-status':
        return record
          ? { found: true, alive: record.alive, exitCode: record.exitCode }
          : { found: false };
      case 'managed-secret-stop':
        if (record) await stop(record);
        else await options.stopTagged?.(raw.instanceId, 'SIGKILL');
        return { found: !!record };
      case 'managed-secret-logs':
        return {
          found: !!record,
          logs: record ? 'Output is disabled for servers with secret bindings.' : '',
        };
      case 'managed-secret-start':
        break;
      default:
        throw new Error('invalid managed server operation');
    }
    if (record?.alive) throw new Error('managed server is already running');
    if (record) await record.closed;
    // Terminal status must survive other starts: Core distinguishes exits from lost broker state.
    if ([...records.values()].filter((entry) => entry.alive).length >= 256)
      throw new Error('managed server limit reached');
    if (
      typeof raw.command !== 'string' ||
      !raw.command.trim() ||
      raw.command.length > 2000 ||
      raw.command.includes('\0') ||
      typeof raw.workdir !== 'string' ||
      raw.workdir.startsWith('/') ||
      raw.workdir.includes('\0') ||
      raw.workdir.split('/').includes('..') ||
      !Array.isArray(raw.secrets) ||
      !raw.secrets.length ||
      raw.secrets.length > 16 ||
      !raw.env ||
      typeof raw.env !== 'object'
    )
      throw new Error('invalid managed server launch');
    const targets = new Set();
    const secretEnv = {};
    for (const secret of raw.secrets) {
      if (
        !secret ||
        !SECRET_ENV.test(secret.env) ||
        RESERVED_ENV.test(secret.env) ||
        targets.has(secret.env) ||
        typeof secret.value !== 'string' ||
        !secret.value.length ||
        secret.value.length > 65536 ||
        secret.value.includes('\0')
      )
        throw new Error('invalid managed server secret');
      targets.add(secret.env);
      secretEnv[secret.env] = secret.value;
    }
    const env = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (
        !/^(?:PORT|VERITY_SESSION_ID|VERITY_SERVER_[A-Z0-9_]+_URL)$/u.test(key) ||
        typeof value !== 'string' ||
        value.includes('\0')
      )
        throw new Error('invalid managed server environment');
      env[key] = value;
    }
    const worktree = await options.realpath(raw.worktree);
    if (!options.allowedPath(worktree)) throw new Error('managed server worktree escaped');
    const target = await options.realpath(resolve(worktree, raw.workdir));
    if (target !== worktree && !target.startsWith(`${worktree}/`))
      throw new Error('managed server directory escaped');
    // A broker crash loses records while detached applications can still be running.
    await options.stopTagged?.(raw.instanceId, 'SIGKILL');
    const child = spawnChild(
      options.setprivPath ?? '/usr/bin/setpriv',
      [
        `--reuid=${options.uid}`,
        `--regid=${options.gid}`,
        ...options.privilegeDropFlags,
        '/bin/sh',
        '-c',
        LAUNCH,
        'verity-managed-secret',
        worktree,
        raw.workdir,
        raw.command,
      ],
      {
        cwd: '/',
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          PATH: options.env?.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: options.env?.VERITY_AGENT_HOME ?? '/home/dev',
          LANG: options.env?.LANG ?? 'C.UTF-8',
          ...env,
          ...secretEnv,
          VERITY_DEV_SERVER_INSTANCE: raw.instanceId,
        },
      },
    );
    let resolveClosed;
    const next = {
      child,
      instanceId: raw.instanceId,
      alive: true,
      exitCode: null,
      closed: new Promise((resolve) => {
        resolveClosed = resolve;
      }),
    };
    records.set(raw.instanceId, next);
    child.once('error', () => {
      next.alive = false;
      next.exitCode = 1;
      next.child = null;
      resolveClosed();
    });
    child.once('close', async (code) => {
      next.alive = false;
      next.exitCode = code ?? 1;
      try {
        await signal(next, 'SIGKILL');
      } finally {
        next.child = null;
        resolveClosed();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(new Error('managed server launch failed')));
      });
    } finally {
      for (const key of Object.keys(secretEnv)) delete secretEnv[key];
    }
    return { found: true, alive: next.alive, exitCode: next.exitCode };
  };
  return {
    handle(raw) {
      if (closing || !ID.test(raw.instanceId ?? ''))
        return Promise.reject(new Error('invalid managed server request'));
      const previous = pending.get(raw.instanceId) ?? Promise.resolve();
      const result = previous.then(() => execute(raw));
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      pending.set(raw.instanceId, tail);
      void tail.then(() => {
        if (pending.get(raw.instanceId) === tail) pending.delete(raw.instanceId);
      });
      return result;
    },
    async close() {
      closing = true;
      await Promise.all(pending.values());
      for (const record of records.values()) {
        if (record.alive) await stop(record);
        else await record.closed;
      }
      records.clear();
    },
  };
}
