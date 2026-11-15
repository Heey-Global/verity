import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  DEFAULT_RUNTIME_DIR,
  OPENCODE_STATE_DIR,
  SESSION_HOME_BUSY,
  activeSessionHomes,
  isLocalConnectorUrl,
  isObject,
  lockSessionHome,
  managedDirectory,
  npmCachePath,
  policyWrite,
  sessionHomeLocks,
  sessionHomePath,
  validateIdentity,
  validateImmutablePath,
  waitForSessionHome,
} from './request.mjs';
import { validateRunnerRuntimeStats } from './process.mjs';

async function packageCacheDirectory(options) {
  const { uid, gid } = validateIdentity(options);
  const root = join(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, 'package-cache');
  try {
    await mkdir(root, { mode: 0o755 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.getuid() ||
    (rootMetadata.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new Error('invalid package cache root');
  // The broker may inherit umask 077. The agent must traverse this broker-owned
  // parent, while npm contents and the broker lease remain private.
  await chmod(root, 0o755);
  const cache = npmCachePath(options);
  try {
    await mkdir(cache, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(cache);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.uid !== uid && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new Error('invalid package cache');
  // mkdir establishes the private mode before ownership is handed to the agent.
  // The production broker has CAP_CHOWN but no CAP_FOWNER: chmod after that
  // handoff fails, including on subsequent or concurrent cache acquisitions.
  if (metadata.uid !== uid || metadata.gid !== gid) await chown(cache, uid, gid);
  return cache;
}

/** Admission and offline maintenance share an inode; children inherit the open-file-description lease. */
export async function acquireRuntimeAdmissionLease(options, exclusive = false) {
  const runtime = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const root = await lstat(runtime);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (options.runnerUid === undefined && root.uid !== process.getuid()) ||
    (root.mode & 0o002) !== 0 ||
    (await realpath(runtime)) !== runtime
  )
    throw new Error('unsafe runner runtime');
  validateRunnerRuntimeStats(root, options);
  const handle = await open(
    join(runtime, 'admission.lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error('invalid runtime admission lease');
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn(
        '/usr/bin/flock',
        [...(exclusive ? ['--exclusive', '--nonblock'] : ['--shared', '--wait', '30']), '3'],
        { stdio: ['ignore', 'ignore', 'ignore', handle.fd] },
      );
      child.once('error', rejectLock);
      child.once('exit', (code) =>
        code === 0 ? resolveLock() : rejectLock(new Error('runner runtime is in use')),
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Caller must independently prove that every runtime consumer supports exclusion or is stopped. */
export async function reclaimPackageCachesOffline(request, options) {
  const lease = await acquireRuntimeAdmissionLease(options, true);
  try {
    return await reclaimPackageCaches(request, { ...options, runtimeAdmissionLockFd: lease.fd });
  } finally {
    await lease.close();
  }
}

export async function packageCacheMaintenanceMain(runtimeDir) {
  let input = '';
  const inputDeadline = setTimeout(() => {
    process.stdin.destroy(new Error('package cache maintenance request timed out'));
  }, 5_000);
  try {
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 96 * 1024)
        throw new Error('invalid package cache maintenance request');
    }
  } finally {
    clearTimeout(inputDeadline);
  }
  const request = JSON.parse(input);
  if (!isObject(request) || !Array.isArray(request.sessionIds) || request.sessionIds.length > 512)
    throw new Error('invalid package cache maintenance request');
  const report = await reclaimPackageCachesOffline(request, {
    runtimeDir,
    agentUid: Number(process.env.VERITY_AGENT_UID ?? 1000),
    agentGid: Number(process.env.VERITY_AGENT_GID ?? 1000),
    runnerUid: Number(process.env.VERITY_RUNNER_RUNTIME_UID ?? 1101),
    runnerGid: Number(process.env.VERITY_RUNNER_RUNTIME_GID ?? 1101),
  });
  const output = JSON.stringify({ ok: true, report });
  if (Buffer.byteLength(output) > 64 * 1024)
    throw new Error('invalid package cache maintenance result');
  process.stdout.write(output);
  return true;
}

/** flock's open-file-description lease survives broker death in the spawned child. */
export async function acquirePackageCacheLease(options, exclusive = false) {
  await packageCacheDirectory(options);
  const handle = await open(
    join(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, 'package-cache', 'npm.lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1)
      throw new Error('invalid package cache lease');
    await new Promise((resolveLock, rejectLock) => {
      const child = spawn(
        '/usr/bin/flock',
        [...(exclusive ? ['--exclusive', '--nonblock'] : ['--shared', '--wait', '30']), '3'],
        { stdio: ['ignore', 'ignore', 'ignore', handle.fd] },
      );
      child.once('error', rejectLock);
      child.once('exit', (code) =>
        code === 0 ? resolveLock() : rejectLock(new Error('package cache is in use')),
      );
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function cacheTreeBytes(path, budget, owner) {
  if (++budget.entries > 100_000 || Date.now() > budget.deadline)
    throw new Error('package cache inventory limit');
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    (!metadata.isDirectory() && !metadata.isFile()) ||
    metadata.uid !== owner ||
    (metadata.isFile() && metadata.nlink !== 1)
  )
    throw new Error('unsafe package cache entry');
  let bytes = metadata.blocks * 512;
  if (metadata.isDirectory()) {
    const directory = await opendir(path);
    for await (const entry of directory)
      bytes += await cacheTreeBytes(join(path, entry.name), budget, owner);
  }
  return bytes;
}

async function validatedCacache(parent, options, budget) {
  const { uid } = validateIdentity(options);
  // No ancestor of the removable leaf may redirect outside its owned home.
  const parentMetadata = await lstat(parent).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!parentMetadata) return { path: join(parent, '_cacache'), bytes: 0 };
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    parentMetadata.uid !== uid ||
    (await realpath(parent)) !== parent
  )
    throw new Error('unsafe package cache root');
  const path = join(parent, '_cacache');
  const metadata = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return { path, bytes: 0 };
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('unsafe package cache root');
  return { path, bytes: await cacheTreeBytes(path, budget, uid) };
}

/** Run data operations as the owner: the broker intentionally lacks DAC_OVERRIDE. */
async function maintainPackageCache(parent, options, budget, maxBytes, shared = false) {
  const { uid, gid } = validateIdentity(options);
  if (uid === process.getuid() && gid === process.getgid())
    return await collectPackageCacheLeaf(parent, options, budget, maxBytes, shared);
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      options.setprivPath ?? '/usr/bin/setpriv',
      [
        `--reuid=${uid}`,
        `--regid=${gid}`,
        '--clear-groups',
        process.execPath,
        fileURLToPath(import.meta.url),
        '--package-cache-leaf',
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'ignore',
          ...(options.runtimeAdmissionLockFd === undefined ? [] : [options.runtimeAdmissionLockFd]),
        ],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      },
    );
    let output = '';
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      Math.max(1, budget.deadline - Date.now()),
    );
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 4096) child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 4096)
        return rejectResult(new Error('package cache owner operation could not be verified'));
      try {
        resolveResult(JSON.parse(output));
      } catch {
        rejectResult(new Error('invalid package cache owner result'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        parent,
        maxBytes,
        shared,
        remainingEntries: 100_000 - budget.entries,
        durationMs: Math.max(1, budget.deadline - Date.now()),
      }),
    );
  });
  if (
    !result ||
    !Number.isSafeInteger(result.entries) ||
    result.entries < 0 ||
    !Number.isSafeInteger(result.removedBytes) ||
    result.removedBytes < 0 ||
    !Number.isSafeInteger(result.remainingBytes) ||
    result.remainingBytes < 0 ||
    typeof result.pruned !== 'boolean' ||
    typeof result.otherEntries !== 'boolean'
  )
    throw new Error('invalid package cache owner result');
  budget.entries += result.entries;
  return result;
}

async function collectPackageCacheLeaf(parent, options, budget, maxBytes, shared) {
  const before = budget.entries;
  const cache = await validatedCacache(parent, options, budget);
  const pruned = cache.bytes > maxBytes;
  let otherEntries = false;
  if (shared) {
    const directory = await opendir(parent);
    for await (const entry of directory) {
      if (++budget.entries > 100_000 || Date.now() > budget.deadline)
        throw new Error('package cache inventory limit');
      if (entry.name !== '_cacache') otherEntries = true;
    }
  }
  if (pruned) await rm(cache.path, { recursive: true });
  return {
    remainingBytes: pruned ? 0 : cache.bytes,
    removedBytes: pruned ? cache.bytes : 0,
    pruned,
    otherEntries,
    entries: budget.entries - before,
  };
}

export async function packageCacheLeafMain() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 4096) throw new Error('invalid package cache owner request');
  }
  const value = JSON.parse(input);
  if (
    typeof value.parent !== 'string' ||
    !isAbsolute(value.parent) ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 0 ||
    typeof value.shared !== 'boolean' ||
    !Number.isSafeInteger(value.remainingEntries) ||
    value.remainingEntries < 0 ||
    value.remainingEntries > 100_000 ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 1 ||
    value.durationMs > 15_000
  )
    throw new Error('invalid package cache owner request');
  const result = await collectPackageCacheLeaf(
    value.parent,
    { enforceRoot: false, agentUid: process.getuid(), agentGid: process.getgid() },
    { entries: 100_000 - value.remainingEntries, deadline: Date.now() + value.durationMs },
    value.maxBytes,
    value.shared,
  );
  process.stdout.write(JSON.stringify(result));
  return true;
}

/** Only the broker can exclude actual child starts; a server activity snapshot cannot. */
export async function reclaimPackageCaches(request, options) {
  if (
    !Array.isArray(request.sessionIds) ||
    request.sessionIds.length > 1000 ||
    new Set(request.sessionIds).size !== request.sessionIds.length ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes <= 0
  )
    throw new Error('invalid package cache reclamation request');
  const homes = request.sessionIds.map((id) =>
    sessionHomePath(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, id),
  );
  const report = {
    observedAt: new Date().toISOString(),
    sharedBytes: null,
    legacyBytes: 0,
    removedBytes: 0,
    legacyCachesRemoved: 0,
    sharedCachePruned: false,
    usageComplete: true,
    blockers: [],
  };
  const block = (reason) => {
    report.usageComplete = false;
    if (report.blockers.length < 100) report.blockers.push(String(reason).slice(0, 500));
  };
  const budget = { entries: 0, deadline: Date.now() + 15_000 };
  let safeHomes = true;
  try {
    const directory = join(options.runtimeDir ?? DEFAULT_RUNTIME_DIR, 'session-homes');
    const metadata = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata) {
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== process.getuid() ||
        (metadata.mode & 0o022) !== 0 ||
        (await realpath(directory)) !== directory
      )
        throw new Error('unsafe session homes root');
      const owned = new Set(homes);
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (++budget.entries > 100_000 || Date.now() > budget.deadline)
          throw new Error('package cache inventory limit');
        if (/^[a-f0-9]{64}$/u.test(entry.name) && !owned.has(join(directory, entry.name))) {
          report.legacyBytes = null;
          block('session home ownership is unknown');
        }
      }
    }
  } catch (error) {
    safeHomes = false;
    report.legacyBytes = null;
    block(error.message);
  }
  for (const home of safeHomes ? homes : []) {
    let lease;
    try {
      if (Date.now() > budget.deadline) throw new Error('package cache inventory limit');
      if (activeSessionHomes.has(home)) throw new Error('session home is in use');
      const metadata = await lstat(home).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!metadata) continue;
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.uid !== process.getuid() && metadata.uid !== validateIdentity(options).uid) ||
        (await realpath(home)) !== home
      )
        throw new Error('unsafe session home');
      lease = await lockSessionHome(home, options, true);
      if (activeSessionHomes.has(home)) throw new Error('session home is in use');
      const cache = await maintainPackageCache(join(home, 'cache'), options, budget, 0);
      report.removedBytes += cache.removedBytes;
      if (cache.pruned) report.legacyCachesRemoved++;
    } catch (error) {
      report.legacyBytes = null;
      block(error.message);
    } finally {
      await lease?.close();
    }
  }
  let lease;
  try {
    lease = await acquirePackageCacheLease(options, true);
    const cache = await maintainPackageCache(
      npmCachePath(options),
      options,
      budget,
      request.maxBytes,
      true,
    );
    report.removedBytes += cache.removedBytes;
    report.sharedCachePruned = cache.pruned;
    report.sharedBytes = cache.remainingBytes;
    if (cache.otherEntries) {
      report.sharedBytes = null;
      block('Retained non-cacache npm cache entries have unknown allocation');
    }
  } catch (error) {
    block(error.message);
  } finally {
    await lease?.close();
  }
  return report;
}

async function claimSessionHome(request, options) {
  const sessionId = request.sessionEnv?.VERITY_SESSION_ID;
  if (request.knowledgeIsolation || typeof sessionId !== 'string') return undefined;
  const home = sessionHomePath(options.runtimeDir, sessionId);
  await waitForSessionHome(home);
  // Recheck after the await: concurrent waiters must not share a broker claim.
  if (activeSessionHomes.has(home)) throw new Error(SESSION_HOME_BUSY);
  activeSessionHomes.add(home);
  try {
    sessionHomeLocks.set(home, await lockSessionHome(home, options));
    await prepareSessionHome(sessionId, options);
    return home;
  } catch (error) {
    activeSessionHomes.delete(home);
    await sessionHomeLocks.get(home)?.close();
    sessionHomeLocks.delete(home);
    throw error;
  }
}

export async function nativeStateRequest(request, options) {
  const { uid, gid } = validateIdentity(options);
  return await new Promise((resolveNative, rejectNative) => {
    const sameIdentity = process.getuid() === uid && process.getgid() === gid;
    const helper =
      options.enforceRoot === false
        ? fileURLToPath(new URL('./verity-session-state.mjs', import.meta.url))
        : '/usr/local/bin/verity-session-state.mjs';
    const args = [process.execPath, helper];
    const child = spawn(
      sameIdentity ? args[0] : (options.setprivPath ?? '/usr/bin/setpriv'),
      sameIdentity
        ? args.slice(1)
        : [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', ...args],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
    );
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 65536) child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectNative(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 65536)
        return rejectNative(new Error('Native session migration or cleanup could not be verified'));
      try {
        resolveNative(JSON.parse(output));
      } catch {
        rejectNative(new Error('Invalid native session migration result'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

export async function prepareSessionHome(sessionId, options, migration) {
  const home = sessionHomePath(options.runtimeDir, sessionId);
  const marker = `${home}.deleted`;
  const lease = sessionHomeLocks.has(home) ? undefined : await lockSessionHome(home, options);
  try {
    if (
      await lstat(marker).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      throw new Error('session home has been deleted');
    const { uid, gid } = validateIdentity(options);
    await managedDirectory(
      join(options.runtimeDir, 'session-homes'),
      process.getuid(),
      process.getgid(),
    );
    await managedDirectory(home, process.getuid(), process.getgid());
    for (const name of ['claude', 'codex', 'config'])
      await managedDirectory(join(home, name), process.getuid(), process.getgid());
    for (const relative of [
      'claude/projects',
      'codex/sessions',
      'codex/thread-writer-locks',
      'codex-state',
      'data',
      'state',
      'cache',
      'tmp',
    ]) {
      const path = join(home, relative);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('invalid session storage');
      await chown(path, uid, gid);
    }
    if (migration?.backend === 'opencode-acp' && migration.sessionId !== undefined) {
      if (
        typeof migration.sessionId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(migration.sessionId)
      )
        throw new Error('invalid legacy native session id');
      const source = join(
        options.enforceRoot === false
          ? join(options.runtimeDir, 'opencode-state')
          : OPENCODE_STATE_DIR,
        'data',
        'opencode',
        'opencode.db',
      );
      const result = await nativeStateRequest(
        {
          source,
          target: join(home, 'data', 'opencode', 'opencode.db'),
          rootId: migration.sessionId,
        },
        options,
      );
      if (Array.isArray(result.sessionIds) && result.sessionIds.length) {
        if (
          !result.sessionIds.every(
            (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id),
          )
        )
          throw new Error('Invalid migrated native session identity');
        await policyWrite(
          join(home, '.legacy-opencode.json'),
          JSON.stringify({ source, sessionIds: result.sessionIds }),
        );
      }
    }
    return home;
  } finally {
    await lease?.close();
  }
}

/** Create only transport configuration; no transcript, user instructions or project config crosses this boundary. */
async function prepareKnowledgeIsolation(request, options, connectorUrl) {
  if (!isLocalConnectorUrl(connectorUrl))
    throw new Error('Wiki isolation requires the local model gateway');
  const { uid, gid } = validateIdentity(options);
  const parent =
    options.enforceRoot === false
      ? join(options.runtimeDir, 'wiki-homes')
      : '/run/verity-knowledge';
  await mkdir(parent, { recursive: true, mode: 0o755 });
  if (options.enforceRoot !== false) await validateImmutablePath(parent);
  // mkdir's mode only applies when it creates the directory. A runtime volume
  // left at 0700 still lets the broker create a correctly owned job home, but
  // the dropped agent uid cannot traverse the parent to reach it.
  await chmod(parent, 0o711);
  const home = (await claimSessionHome(request, options)) ?? (await mkdtemp(join(parent, 'job-')));
  try {
    // Build the complete tree while the broker still owns its root. In
    // rootless/user-namespace deployments, changing ownership of this 0700
    // directory can remove the broker's right to create or traverse anything
    // below it.
    await chmod(home, 0o700);
    const directories = [];
    for (const relative of ['claude', 'codex', 'config', 'data', 'state', 'cache', 'tmp']) {
      const directory = join(home, relative);
      await managedDirectory(directory, process.getuid(), process.getgid());
      directories.push(directory);
    }
    const files = [];
    const writeConfig = async (path, content) => {
      await policyWrite(path, content, { mode: 0o600 });
      files.push(path);
    };
    const gateway = new URL(connectorUrl);
    await writeConfig(
      join(home, 'codex', 'config.toml'),
      [
        'model_provider = "verity_gateway"',
        '[model_providers.verity_gateway]',
        'name = "Verity Gateway"',
        `base_url = "${gateway.origin}/codex"`,
        'env_key = "VERITY_CODEX_PLACEHOLDER"',
        'http_headers = { "x-openai-actor-authorization" = "verity-codex-gateway-placeholder-v1" }',
        'wire_api = "responses"',
        'requires_openai_auth = false',
      ].join('\n'),
    );
    if (request.command === 'opencode-acp') {
      const configPath = options.env?.OPENCODE_CONFIG;
      if (typeof configPath !== 'string')
        throw new Error('Wiki isolation requires configured OpenCode models');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const models = config?.provider?.verity?.models;
      if (!models || typeof models !== 'object' || Array.isArray(models))
        throw new Error('Invalid OpenCode model gateway configuration');
      await writeConfig(
        join(home, 'config', 'opencode.json'),
        JSON.stringify({
          autoupdate: false,
          provider: {
            verity: {
              npm: '@opencode/ai/providers/openai-compatible',
              name: 'Verity',
              options: {
                baseURL: `${gateway.origin}/opencode`,
                apiKey: 'verity-opencode-gateway-placeholder-v1',
              },
              models: Object.fromEntries(
                Object.keys(models).map((model) => [model, { name: model }]),
              ),
            },
          },
        }),
      );
    }
    // Transfer children before their 0700 parent, and the home itself last. No
    // broker filesystem operation may follow this handoff.
    if (!activeSessionHomes.has(home)) {
      for (const file of files) await chown(file, uid, gid);
      for (const directory of directories) await chown(directory, uid, gid);
      await chown(home, uid, gid);
    } else {
      for (const directory of directories.slice(3)) {
        // Without CAP_FOWNER, chmod must precede the ownership handoff.
        await chmod(directory, 0o700);
        await chown(directory, uid, gid);
      }
    }
    return home;
  } catch (error) {
    if (!activeSessionHomes.has(home))
      await removeKnowledgeIsolation(home, uid, gid, options.setprivPath);
    activeSessionHomes.delete(home);
    await sessionHomeLocks.get(home)?.close();
    sessionHomeLocks.delete(home);
    throw error;
  }
}

export async function removeKnowledgeIsolation(home, uid, gid, setprivPath = '/usr/bin/setpriv') {
  try {
    await rm(home, { recursive: true, force: true });
    return;
  } catch {
    // Return only the broker-owned policy directories to the child. Its identity
    // can then unlink root-owned policy files without traversing private data as root.
    for (const name of ['config/opencode', 'config', 'codex', 'claude', '.']) {
      const path = join(home, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isDirectory() && metadata.uid === process.getuid()) {
          await chmod(path, 0o700);
          await chown(path, uid, gid);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
      }
    }
    const asAgent = async (args) => {
      await new Promise((resolveCleanup, rejectCleanup) => {
        const sameIdentity = process.getuid() === uid && process.getgid() === gid;
        const child = spawn(
          sameIdentity ? '/usr/bin/find' : setprivPath,
          sameIdentity
            ? args
            : [
                `--reuid=${String(uid)}`,
                `--regid=${String(gid)}`,
                '--clear-groups',
                '/usr/bin/find',
                ...args,
              ],
          { stdio: 'ignore' },
        );
        child.once('error', rejectCleanup);
        child.once('close', (code) =>
          code === 0 ? resolveCleanup() : rejectCleanup(new Error('Agent home cleanup failed')),
        );
      });
    };
    // Preorder chmod restores traversal even if the child left a mode-000 directory.
    // Neither walk follows symlinks; both run with the unprivileged child identity.
    await asAgent([home, '-type', 'd', '-exec', '/bin/chmod', 'u+rwx', '{}', ';']);
    await asAgent([home, '-mindepth', '1', '-delete']);
    // rmdir needs access to the broker-owned parent, not the private empty home.
    await rmdir(home);
  }
}

export async function materializeKnowledgeIsolation(request, options, connectorUrl) {
  const { uid, gid } = validateIdentity(options);
  const home = await prepareKnowledgeIsolation(request, options, connectorUrl);
  const persistent = activeSessionHomes.has(home);
  let cleaned = false;
  return {
    home,
    lockFd: sessionHomeLocks.get(home)?.fd,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      if (persistent) {
        // Native databases, rollouts and auxiliary files belong to the session.
        // Only the explicitly temporary subtree is disposable at turn exit.
        try {
          await removeKnowledgeIsolation(join(home, 'tmp'), uid, gid, options.setprivPath);
        } finally {
          activeSessionHomes.delete(home);
          await sessionHomeLocks.get(home)?.close();
          sessionHomeLocks.delete(home);
        }
      } else await removeKnowledgeIsolation(home, uid, gid, options.setprivPath);
    },
  };
}

export function planningRuntimeRoots(request, options) {
  if (!request.planning || request.knowledgeIsolation || request.sessionEnv?.VERITY_SESSION_ID)
    return [];
  if (request.command === 'codex-acp' && options.runtimeDir)
    return [join(options.runtimeDir, 'codex-sessions'), join(options.runtimeDir, 'codex-state')];
  if (request.command === 'claude-agent-acp' && options.env?.CLAUDE_CONFIG_DIR)
    return [join(options.env.CLAUDE_CONFIG_DIR, 'projects')];
  if (request.command === 'opencode-acp')
    return [
      options.enforceRoot === false
        ? join(options.runtimeDir, 'opencode-state')
        : OPENCODE_STATE_DIR,
    ];
  return [];
}

/** Explicit metadata prevents model-owned patch/code-mode tools from bypassing feature switches. */
export function restrictedCodexModelCatalog(model) {
  if (
    typeof model !== 'string' ||
    !/^codex\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model) ||
    model === 'codex/default'
  )
    throw new Error('Native tool isolation requires a concrete Codex model');
  const slug = model.slice('codex/'.length);
  return {
    models: [
      {
        slug,
        display_name: slug,
        description: 'Verity tool isolation',
        base_instructions:
          'You are Verity. Complete the supplied assignment using only the provided Verity tools.',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: ['minimal', 'low', 'medium', 'high', 'xhigh'].map((effort) => ({
          effort,
          description: effort,
        })),
        shell_type: 'disabled',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        support_verbosity: false,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'bytes', limit: 10000 },
        experimental_supported_tools: [],
        tool_mode: null,
        input_modalities: ['text'],
        node_repl_disabled: true,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
      },
    ],
  };
}

export function restrictedOpenCodePermissions() {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'verity_*', resource: '*', effect: 'allow' },
  ];
}

export function restrictedOpenCodePolicies() {
  return [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'verity', effect: 'allow' },
    { action: 'tool.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'verity_*:*', effect: 'allow' },
    { action: 'skill.use', resource: '*', effect: 'deny' },
    { action: 'plugin.use', resource: '*', effect: 'deny' },
    { action: 'mcp.use', resource: '*', effect: 'deny' },
    { action: 'mcp.use', resource: 'verity', effect: 'allow' },
  ];
}

/** Build a broker-owned configuration tree, separate from writable runtime data. */
export async function materializeManagedAgentHome(request, options, connectorUrl) {
  const { uid, gid } = validateIdentity(options);
  const isolated = await materializeKnowledgeIsolation(request, options, connectorUrl);
  const home = isolated.home;
  try {
    // Hand ownership back before installing policy. Production runs as root;
    // rootless tests use their own identity and exercise the generated content.
    await chown(home, process.getuid(), process.getgid());
    await chmod(home, 0o755);
    for (const name of ['claude', 'codex', 'config']) {
      const directory = join(home, name);
      await chown(directory, process.getuid(), process.getgid());
      await chmod(directory, 0o755);
    }
    // Import only the image-owned template, never the previous mutable user home.
    let gitPolicy = '';
    try {
      const template = await open(
        '/etc/verity-agent.gitconfig',
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await template.stat();
        if (
          !metadata.isFile() ||
          metadata.uid !== 0 ||
          (metadata.mode & 0o022) !== 0 ||
          metadata.size > 65536
        )
          throw new Error('Untrusted managed Git configuration');
        gitPolicy = await template.readFile('utf8');
      } finally {
        await template.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || options.enforceRoot !== false) throw error;
    }
    const gitValue = (value) => JSON.stringify(value);
    const gitIgnore = join(home, 'config', 'git-ignore');
    // Per-checkout gate state. Repositories opened into a session are standalone
    // clones without Verity's info/exclude, so this file is all that keeps these
    // markers out of their commits.
    await policyWrite(
      gitIgnore,
      '.gh-token\n.env\n.agents/.last-code-review-sha\n.agents/.last-code-review-run\n.agents/.local-checks-skip\n',
      { mode: 0o644 },
    );
    const gitIdentity = options.env ?? {};
    await policyWrite(
      join(home, '.gitconfig'),
      [
        gitPolicy,
        '[core]',
        `excludesFile = ${gitValue(gitIgnore)}`,
        '[user]',
        ...(gitIdentity.GIT_USER_NAME ? [`name = ${gitValue(gitIdentity.GIT_USER_NAME)}`] : []),
        ...(gitIdentity.GIT_USER_EMAIL ? [`email = ${gitValue(gitIdentity.GIT_USER_EMAIL)}`] : []),
      ].join('\n'),
      { mode: 0o644 },
    );
    const configFile = join(home, 'codex', 'config.toml');
    await chown(configFile, process.getuid(), process.getgid());
    const codexConfig = await readFile(configFile, 'utf8');
    await policyWrite(
      configFile,
      [
        `sqlite_home = ${JSON.stringify(join(home, 'codex-state'))}`,
        `log_dir = ${JSON.stringify(join(home, 'state'))}`,
        'skills.include_instructions = false',
        ...(request.gatewayToolsOnly === true
          ? [
              'web_search = "disabled"',
              ...(request.command === 'codex-acp'
                ? [
                    `model = ${JSON.stringify(request.gatewayToolsModel.slice('codex/'.length))}`,
                    `model_catalog_json = ${JSON.stringify(join(home, 'codex', 'restricted-models.json'))}`,
                  ]
                : []),
            ]
          : []),
        codexConfig,
        '[features]',
        'multi_agent = false',
        'plugins = false',
        ...(request.gatewayToolsOnly === true
          ? [
              ...[
                'shell_tool',
                'unified_exec',
                'multi_agent_v2',
                'goals',
                'view_image',
                'apps',
                'browser_use',
                'browser_use_external',
                'browser_use_full_cdp_access',
                'computer_use',
                'in_app_browser',
                'image_generation',
                'tool_suggest',
                'sleep_tool',
                'skill_search',
                'skill_mcp_dependency_install',
                'code_mode_host',
                'code_mode',
                'hooks',
                'deferred_executor',
                'context_management',
                'chronicle',
              ].map((name) => `${name} = false`),
              '[tools.experimental_request_user_input]',
              'enabled = false',
            ]
          : []),
        '[hooks]',
        // No trusted projects are imported from the former user home. Codex's
        // loader disables project-local config, hooks and exec policies by default.
      ].join('\n'),
    );
    await chmod(configFile, 0o644);
    if (request.gatewayToolsOnly === true && request.command === 'codex-acp') {
      await policyWrite(
        join(home, 'codex', 'restricted-models.json'),
        JSON.stringify(restrictedCodexModelCatalog(request.gatewayToolsModel)),
        { mode: 0o644 },
      );
    }
    const writable = async (path) => {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error('invalid writable session directory');
      await chown(path, uid, gid);
    };
    // Codex opens its installation id read-write at startup and exits with EACCES
    // when it cannot (codex 0.163). It cannot create one in the broker-owned
    // CODEX_HOME either, so pre-create it owned by the agent. It is a random
    // identifier, not policy. Created exclusively and changed through its own
    // handle, so the broker never writes or hands over a path it did not create.
    try {
      const installationId = await open(
        join(home, 'codex', 'installation_id'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await installationId.writeFile(randomUUID());
        await installationId.chown(uid, gid);
      } finally {
        await installationId.close();
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await writable(join(home, 'codex-state'));
    for (const name of ['tmp', '.tmp', 'skills', 'log', 'shell_snapshots'])
      await writable(join(home, 'codex', name));
    for (const name of [
      'todos',
      'tasks',
      'debug',
      'session-env',
      'shell-snapshots',
      'plans',
      'telemetry',
    ])
      await writable(join(home, 'claude', name));
    if (activeSessionHomes.has(home)) {
      await writable(join(home, 'claude', 'projects'));
      await writable(join(home, 'codex', 'sessions'));
      await writable(join(home, 'codex', 'thread-writer-locks'));
    } else {
      if (options.env?.CLAUDE_CONFIG_DIR)
        await symlink(
          join(options.env.CLAUDE_CONFIG_DIR, 'projects'),
          join(home, 'claude', 'projects'),
        );
      else await writable(join(home, 'claude', 'projects'));
      if (options.runtimeDir) {
        await symlink(
          join(options.runtimeDir, 'codex-state', 'thread-writer-locks'),
          join(home, 'codex', 'thread-writer-locks'),
        );
        await symlink(join(options.runtimeDir, 'codex-sessions'), join(home, 'codex', 'sessions'));
      } else {
        await writable(join(home, 'codex', 'sessions'));
        await writable(join(home, 'codex', 'thread-writer-locks'));
      }
    }
    await policyWrite(
      join(home, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true }),
      {
        mode: 0o644,
      },
    );
    const openCodeDir = join(home, 'config', 'opencode');
    await managedDirectory(openCodeDir, process.getuid(), process.getgid());
    await policyWrite(join(openCodeDir, '.gitignore'), '*\n', { mode: 0o644 });
    if (request.command === 'opencode-acp') {
      const path = join(home, 'config', 'opencode.json');
      await chown(path, process.getuid(), process.getgid());
      if (request.gatewayToolsOnly === true) {
        const config = JSON.parse(await readFile(path, 'utf8'));
        config.policies = restrictedOpenCodePolicies();
        config.permissions = restrictedOpenCodePermissions();
        await policyWrite(path, JSON.stringify(config), { mode: 0o644 });
      }
      await chmod(path, 0o644);
    }
    for (const path of [
      join(home, '.gitconfig'),
      gitIgnore,
      join(home, '.claude.json'),
      join(openCodeDir, '.gitignore'),
    ])
      await chmod(path, 0o644);
    await chmod(openCodeDir, 0o755);
    return isolated;
  } catch (error) {
    await isolated.cleanup();
    throw error;
  }
}

/** A root-issued lease cannot be supplied through the agent spawn protocol. */
export async function agentSignalTraceSeconds(controlDir, request, now = Date.now()) {
  if (
    request.command !== 'codex-acp' ||
    request.knowledgeIsolation ||
    typeof request.sessionEnv?.VERITY_SESSION_ID !== 'string'
  )
    return undefined;
  let handle;
  try {
    handle = await open(
      join(controlDir, 'signal-trace.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096)
      return undefined;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return undefined;
    return validateAgentSignalTraceLease(
      buffer.subarray(0, bytesRead).toString('utf8'),
      request,
      now,
    );
  } catch {
    // Missing, malformed, or untrusted leases leave normal launches unchanged.
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function validateAgentSignalTraceLease(text, request, now = Date.now()) {
  if (request.command !== 'codex-acp' || request.knowledgeIsolation || text.length > 4096)
    return undefined;
  try {
    const lease = JSON.parse(text);
    if (
      !isObject(lease) ||
      Object.keys(lease).sort().join(',') !== 'expiresAt,sessionId' ||
      typeof lease.sessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lease.sessionId) ||
      lease.sessionId !== request.sessionEnv?.VERITY_SESSION_ID ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= now ||
      lease.expiresAt > now + 600_000
    )
      return undefined;
    const seconds = Math.floor((lease.expiresAt - now) / 1000);
    return seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export function nodeRuntimeRoots() {
  // Node loads this public configuration before the ACP adapter can initialize.
  // Grant only the file, keeping the sibling TLS private-key directory excluded.
  return lstatSync('/etc/ssl/openssl.cnf', { throwIfNoEntry: false })
    ? ['--secret', '/etc/ssl/openssl.cnf']
    : [];
}
