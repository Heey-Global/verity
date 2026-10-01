#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string>, optionalDependencies?: Record<string, string>, peerDependencies?: Record<string, string>, link?: boolean, resolved?: string }} LockPackage */
/** @typedef {{ lockfileVersion?: number, packages?: Record<string, LockPackage> }} Lockfile */
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

/** @param {Lockfile} lock @param {string[]} roots */
function closure(lock, roots) {
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Unsupported lockfile');
  const result = new Map();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    if (key === undefined || result.has(key)) continue;
    const pkg = packageAt(lock, key);
    if (!pkg) throw new Error(`Missing package: ${key}`);
    result.set(key, JSON.stringify(pkg));
    if (lock.packages[key]?.link) queue.push(lock.packages[key].resolved);
    for (const field of /** @type {const} */ ([
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        const target = resolvedPackageKey(
          lock,
          lock.packages[key]?.link ? (lock.packages[key].resolved ?? key) : key,
          name,
        );
        if (target) queue.push(target);
        else if (field === 'dependencies' || field === 'devDependencies')
          throw new Error(`Missing dependency: ${name}`);
      }
    }
  }
  return result;
}

/** Compare both installed graphs, including source pins, peers and workspace links.
 * @param {Lockfile} before @param {Lockfile} after @param {string[]} roots
 */
export function dependencyGraphChanged(before, after, roots) {
  const left = closure(before, roots);
  const right = closure(after, roots);
  return [...new Set([...left.keys(), ...right.keys()])].some(
    (key) => left.get(key) !== right.get(key),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Any unreadable evidence runs the checks; this optimization cannot grant green.
  try {
    const [base, head = 'HEAD', component] = process.argv.slice(2);
    if (!base || !['relay', 'sandbox'].includes(component ?? ''))
      throw new Error('Invalid arguments');
    const roots = ['', component === 'relay' ? 'packages/project-relay' : 'packages/session'];
    /** @param {string} ref @returns {Lockfile} */
    const read = (ref) => {
      /** @type {unknown} */
      const parsed = JSON.parse(
        execFileSync('git', ['show', `${ref}:package-lock.json`], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        }),
      );
      return /** @type {Lockfile} */ (parsed);
    };
    const before = read(base),
      after = read(head);
    const paths = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', `${base}...${head}`],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    const owners = new Set([...closure(before, roots).keys(), ...closure(after, roots).keys()]);
    const sourceChanged = paths.some(
      (path) =>
        path !== 'package-lock.json' &&
        (!/^packages\/[^/]+\/package\.json$/.test(path) ||
          owners.has(path.slice(0, -'/package.json'.length))),
    );
    console.log(sourceChanged || dependencyGraphChanged(before, after, roots) ? 'true' : 'false');
  } catch (error) {
    console.error(`Dependency classification unavailable: ${String(error)}`);
    console.log('true');
  }
}
