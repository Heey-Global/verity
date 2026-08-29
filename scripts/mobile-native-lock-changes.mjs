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
 * }} LockPackage
 * @typedef {{ packages?: Record<string, LockPackage> }} Lockfile
 */

const MOBILE_WORKSPACE = 'apps/mobile';

/**
 * Version the workspace actually resolves for `name`: a nested install wins over
 * the hoisted one.
 *
 * @param {Lockfile} lock
 * @param {string} name
 * @returns {string | undefined}
 */
function resolvedVersion(lock, name) {
  const nested = lock.packages?.[`${MOBILE_WORKSPACE}/node_modules/${name}`];
  const hoisted = lock.packages?.[`node_modules/${name}`];
  return nested?.version ?? hoisted?.version;
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
  /** @type {string[]} */
  const changes = [];
  for (const name of mobileDependencyNames(baseLock, headLock)) {
    const before = resolvedVersion(baseLock, name);
    const after = resolvedVersion(headLock, name);
    if (before !== after)
      changes.push(`${name}: ${before ?? '(absent)'} -> ${after ?? '(absent)'}`);
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
