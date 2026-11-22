// Keep a granted capacity holder through npm's legitimate Node/native children.
// This is lifecycle accounting, not a sandbox for hostile package code.
import childProcess from 'node:child_process';
import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export const capacityPreloadPath = fileURLToPath(import.meta.url);
const installed = Symbol.for('verity.dependency-storage-preload.v1');
if (process.env.VERITY_DEPENDENCY_STORAGE_FD === '4' && !globalThis[installed]) {
  globalThis[installed] = true;
  if (!fstatSync(4).isFile()) throw new Error('Dependency capacity descriptor is unavailable.');
  const preparation = process.env.VERITY_DEPENDENCY_PREPARATION_FD === '3';
  if (preparation && !fstatSync(3).isFile())
    throw new Error('Dependency preparation descriptor is unavailable.');
  const lease = process.env.VERITY_DEPENDENCY_STORAGE_LEASE_ID;
  if (!/^[a-f0-9-]{36}$/u.test(lease ?? ''))
    throw new Error('Dependency capacity lease identity is unavailable.');
  const preload = `--import=${JSON.stringify(fileURLToPath(import.meta.url))}`;
  const nodeOptions = (value = '') =>
    value.includes(preload) ? value : `${value} ${preload}`.trim();
  const environment = (env = process.env) => ({
    ...env,
    VERITY_DEPENDENCY_STORAGE_FD: '4',
    VERITY_DEPENDENCY_STORAGE_LEASE_ID: lease,
    VERITY_DEPENDENCY_PREPARATION_FD: preparation ? '3' : undefined,
    NODE_OPTIONS: nodeOptions(env.NODE_OPTIONS),
  });
  const stdio = (value) => {
    const result = Array.isArray(value)
      ? [...value]
      : Array(3).fill(value === undefined ? 'pipe' : value);
    while (result.length < 5) result.push('ignore');
    if (preparation) {
      // fork's IPC channel is positional internally, not fixed to descriptor 3.
      if (result[3] === 'ipc') result.push('ipc');
      else if (![undefined, null, 'ignore', 3].includes(result[3]))
        throw new Error('Child descriptor 3 conflicts with dependency preparation.');
      result[3] = 3;
    }
    if (![undefined, null, 'ignore', 4].includes(result[4]))
      throw new Error('Child descriptor 4 conflicts with the dependency capacity holder.');
    result[4] = 4;
    return result;
  };

  // All async public methods, including execFile's internal spawn, converge here
  // before Node normalizes stdio. Patching only the exported spawn misses them.
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    const env = Object.fromEntries(
      (options.envPairs ?? []).map((entry) => {
        const at = entry.indexOf('=');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
    return spawn.call(this, {
      ...options,
      stdio: stdio(options.stdio),
      envPairs: Object.entries(environment(env)).map(([key, value]) => `${key}=${value}`),
    });
  };

  // Sync helpers use a separate native binding rather than ChildProcess.spawn.
  for (const name of ['spawnSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function (file, args, options) {
      if (!Array.isArray(args)) {
        options = args;
        args = [];
      }
      return original.call(this, file, args, {
        ...options,
        stdio: stdio(options?.stdio),
        env: environment(options?.env),
      });
    };
  }
  const execSync = childProcess.execSync;
  childProcess.execSync = function (command, options) {
    return execSync.call(this, command, {
      ...options,
      stdio: stdio(options?.stdio),
      env: environment(options?.env),
    });
  };
  syncBuiltinESMExports();
}
