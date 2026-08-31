#!/usr/bin/env node
// Decide whether a root package-lock.json change is NATIVE-sensitive for the
// mobile app, i.e. whether it moves a version inside the app's own dependency
// closure — the only lockfile change an installed TestFlight binary cannot
// absorb over the air.
//
// The OTA workflow previously treated ANY change to the root `package.json` /
// `package-lock.json` as native. In a workspaces monorepo those files also carry
// pure tooling edits (a new lint script, a server-only dependency), so a single
// unrelated merge blocked every later OTA until the next native build — which is
// exactly what happened from mobile-v1.3.6 onward.
//
// Usage: node scripts/mobile-native-lock-changes.mjs <baseRef> [headRef]
// Prints one `name: <before> -> <after>` line per native-relevant change.

import { execFileSync } from 'node:child_process';

/**
 * @typedef {{
 *   version?: string,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   link?: boolean,
 *   resolved?: string,
 * }} LockPackage
 * @typedef {{ packages?: Record<string, LockPackage> }} Lockfile
 */

const MOBILE_WORKSPACE = 'apps/mobile';

/** Follow npm workspace links without allowing a lockfile to traverse outside the
 * checkout. A malformed/missing link fails closed instead of hiding native deps.
 * @param {Lockfile} lock
 * @param {string} key
 * @returns {LockPackage | undefined}
 */
function packageAt(lock, key) {
  let current = key;
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) throw new Error(`cyclic workspace link: ${current}`);
    seen.add(current);
    const pkg = lock.packages?.[current];
    if (pkg?.link !== true) return pkg;
    const target = pkg.resolved;
    if (
      typeof target !== 'string' ||
      target === '' ||
      target.startsWith('/') ||
      target.includes('\\') ||
      target.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new Error(`unsafe workspace link: ${String(target)}`);
    current = target;
    if (lock.packages?.[current] === undefined)
      throw new Error(`missing workspace link: ${current}`);
  }
}

/**
 * Resolve an npm dependency using the lockfile's Node-style ancestor lookup.
 * @param {Lockfile} lock
 * @param {string} fromKey
 * @param {string} name
 * @returns {string | undefined}
 */
function resolvedPackageKey(lock, fromKey, name) {
  let directory = fromKey;
  while (true) {
    const candidate = `${directory}/node_modules/${name}`;
    if (lock.packages?.[candidate] !== undefined) return candidate;
    const marker = directory.lastIndexOf('/node_modules/');
    if (marker >= 0) directory = directory.slice(0, marker);
    else {
      const slash = directory.lastIndexOf('/');
      if (slash < 0) break;
      directory = directory.slice(0, slash);
    }
  }
  const root = `node_modules/${name}`;
  return lock.packages?.[root] === undefined ? undefined : root;
}

/**
 * The complete installed dependency closure of the mobile workspace. Native
 * code can change through a transitive package even when every direct version
 * stays fixed, so the OTA gate must compare this closure rather than its first
 * level only.
 */
/** @param {Lockfile} lock */
function mobileDependencyClosure(lock) {
  /** @type {Map<string, string | undefined>} */
  const closure = new Map();
  /** @type {Array<[string, string]>} */
  const queue = [];
  const workspace = lock.packages?.[MOBILE_WORKSPACE];
  for (const field of /** @type {const} */ (['dependencies', 'optionalDependencies'])) {
    for (const name of Object.keys(workspace?.[field] ?? {})) queue.push([MOBILE_WORKSPACE, name]);
  }
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [fromKey, name] = next;
    const key = resolvedPackageKey(lock, fromKey, name);
    if (key === undefined || closure.has(key)) continue;
    const pkg = packageAt(lock, key);
    closure.set(key, pkg?.version);
    for (const field of /** @type {const} */ (['dependencies', 'optionalDependencies'])) {
      for (const child of Object.keys(pkg?.[field] ?? {})) queue.push([key, child]);
    }
  }
  return closure;
}

/**
 * Direct dependencies of the mobile workspace in either lockfile. Direct deps pin
 * the native surface (expo, react-native, every expo-* module); a purely
 * transitive bump cannot add a native module without one of these moving.
 *
 * @param {Lockfile} baseLock
 * @param {Lockfile} headLock
 * @returns {string[]}
 */
export function mobileDependencyNames(baseLock, headLock) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const lock of [baseLock, headLock]) {
    const workspace = lock.packages?.[MOBILE_WORKSPACE];
    for (const field of /** @type {const} */ (['dependencies', 'optionalDependencies'])) {
      for (const name of Object.keys(workspace?.[field] ?? {})) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Native-relevant version moves between two lockfiles: added, removed, or changed.
 *
 * @param {Lockfile} baseLock
 * @param {Lockfile} headLock
 * @returns {string[]}
 */
export function nativeLockChanges(baseLock, headLock) {
  const baseClosure = mobileDependencyClosure(baseLock);
  const headClosure = mobileDependencyClosure(headLock);
  /** @type {string[]} */
  const changes = [];
  const directNames = new Set(mobileDependencyNames(baseLock, headLock));
  const directKeys = new Set();
  for (const name of [...directNames].sort()) {
    const baseKey = resolvedPackageKey(baseLock, MOBILE_WORKSPACE, name);
    const headKey = resolvedPackageKey(headLock, MOBILE_WORKSPACE, name);
    if (baseKey !== undefined) directKeys.add(baseKey);
    if (headKey !== undefined) directKeys.add(headKey);
    const before = baseKey === undefined ? undefined : packageAt(baseLock, baseKey)?.version;
    const after = headKey === undefined ? undefined : packageAt(headLock, headKey)?.version;
    if (before !== after)
      changes.push(`${name}: ${before ?? '(absent)'} -> ${after ?? '(absent)'}`);
  }
  const keys = new Set([...baseClosure.keys(), ...headClosure.keys()]);
  for (const key of [...keys].sort()) {
    if (directKeys.has(key)) continue;
    const before = baseClosure.get(key);
    const after = headClosure.get(key);
    if (before !== after) changes.push(`${key}: ${before ?? '(absent)'} -> ${after ?? '(absent)'}`);
  }
  return changes;
}

/**
 * @param {string} ref
 * @returns {Lockfile}
 */
function readLockAtRef(ref) {
  const raw = execFileSync('git', ['show', `${ref}:package-lock.json`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  /** @type {unknown} */
  const parsed = JSON.parse(raw);
  return /** @type {Lockfile} */ (parsed);
}

// `import.meta.main` is not available on the pinned Node version, so compare paths.
if (process.argv[1]?.endsWith('mobile-native-lock-changes.mjs') === true) {
  const [baseRef, headRef = 'HEAD'] = process.argv.slice(2);
  if (baseRef === undefined) {
    console.error('usage: mobile-native-lock-changes.mjs <baseRef> [headRef]');
    process.exit(1);
  }
  try {
    for (const change of nativeLockChanges(readLockAtRef(baseRef), readLockAtRef(headRef))) {
      console.log(change);
    }
  } catch (error) {
    console.error(
      `could not compare package-lock.json between ${baseRef} and ${headRef}: ${String(error)}`,
    );
    process.exit(1);
  }
}
