import {
  readFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync, fstatSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

const INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'add']);
const UPDATE = new Set(['update', 'up', 'upgrade']);
const VALUES = new Set([
  '--prefix',
  '-C',
  '--workspace',
  '-w',
  '--userconfig',
  '--globalconfig',
  '--registry',
  '--cache',
  '--tag',
  '--omit',
  '--include',
  '--loglevel',
  '--install-strategy',
  '--min-release-age',
  '--location',
  '--before',
  '--cpu',
  '--os',
  '--libc',
]);
const SAVE =
  /^(?:--(?:save(?:-dev|-prod|-optional|-peer|-exact|-bundle)?|no-save|package-lock(?:-only)?)|-[DEOPBS])(?:=|$)/u;

/** Freeze the resolved tree instead of resolving a different tree after approval. */
export function npmInstallPlan(args, cwd, env = {}) {
  let command;
  const flags = [];
  const resolution = [];
  let lockOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [key, inline] = arg.split('=', 2);
    if (arg === '--') {
      if (!command)
        throw new Error('Cannot verify this npm invocation; use npm install or npm ci.');
      // npm's remaining positional arguments are package specs, never ci flags.
      break;
    }
    if (
      (['--global', '-g'].includes(key) && inline !== 'false') ||
      /^-[A-Za-z]*g[A-Za-z]*$/u.test(arg) ||
      arg === '--location=global' ||
      (key === '--location' && args[i + 1] === 'global') ||
      /^(?:true|1)$/iu.test(env.npm_config_global ?? env.NPM_CONFIG_GLOBAL ?? '')
    )
      throw new Error('Global npm installs cannot be verified; install dependencies in a project.');
    if (arg.startsWith('-')) {
      const value = VALUES.has(key) && inline === undefined ? args[++i] : undefined;
      if (VALUES.has(key) && inline === undefined && value === undefined)
        throw new Error(`Missing value for ${key}.`);
      if (key === '--no-save' || (key === '--save' && inline === 'false'))
        throw new Error(
          'An unsaved npm install cannot be frozen; save dependencies in the project lockfile.',
        );
      if (key === '--package-lock-only' && inline !== 'false') lockOnly = true;
      if (!SAVE.test(arg)) {
        flags.push(arg);
        if (value !== undefined) flags.push(value);
      }
      continue;
    }
    if (!command) command = ['clean-install', 'ic'].includes(arg) ? 'ci' : arg;
    else resolution.push(arg);
  }
  if (!(INSTALL.has(command) || UPDATE.has(command) || command === 'ci'))
    throw new Error(
      'This npm operation cannot be age-verified; install dependencies with npm install or npm ci, then run local scripts.',
    );
  if (command === 'ci' && resolution.length)
    throw new Error('npm ci does not accept package specifications.');
  return {
    root: resolve(cwd),
    resolveArgs:
      command === 'ci'
        ? undefined
        : [
            ...args.filter((arg) => arg !== '--'),
            '--package-lock-only=true',
            '--package-lock=true',
            '--ignore-scripts=true',
            '--audit=false',
          ],
    installArgs: lockOnly ? undefined : ['ci', ...flags],
  };
}

/** Let npm identify workspace membership; an ancestor lock alone proves nothing. */
export function npmProjectRoot(executable, directory, env, args) {
  const workspaces = args.find((arg) => arg === '--workspaces=false' || arg === '--no-workspaces');
  const output = execFileSync(
    executable,
    ['prefix', '--global=false', ...(workspaces ? [workspaces] : [])],
    {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 65_536,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  if (!output || !isAbsolute(output))
    throw new Error('Cannot determine the npm project root; installation remains blocked.');
  return realpathSync(output);
}

export function npmStateDirectory(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return join(root, '.cache');
  }
}

/** The open file description survives an interrupted parent in its native child. */
export async function lockNpmProject(root, env) {
  const path = join(npmStateDirectory(root), 'verity-npm.lock');
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  if (env.VERITY_NPM_LOCK_FD === '3') {
    try {
      const inherited = fstatSync(3);
      const expected = statSync(path);
      if (inherited.dev === expected.dev && inherited.ino === expected.ino) fd = 3;
    } catch {
      /* No valid inherited lock descriptor. */
    }
  }
  fd ??= openSync(path, 'a', 0o600);
  try {
    await new Promise((done, reject) => {
      const child = spawn('flock', ['-w', '90', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 && !signal
          ? done()
          : reject(
              new Error(
                'npm preparation lock unavailable or busy after 90 seconds; retry after the active command finishes.',
              ),
            ),
      );
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    fd,
    release() {
      closeSync(fd);
    },
  };
}

/** npm ci removes existing packages; retain independent recovery files first. */
export function preserveNpmDependencies(root) {
  const lock = JSON.parse(npmLockedPackages(root).source);
  const projects = [
    '',
    ...Object.keys(lock.packages ?? {}).filter(
      (path) => path && !path.split('/').includes('node_modules'),
    ),
  ];
  let recovery;
  const preserved = [];
  for (const project of projects) {
    const directory = resolve(root, project);
    const rel = relative(root, directory);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
      throw new Error('Unsafe project path in npm lockfile.');
    const modules = join(directory, 'node_modules');
    try {
      lstatSync(modules);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const actualParent = realpathSync(directory);
    const actualRelative = relative(realpathSync(root), actualParent);
    if (isAbsolute(actualRelative) || actualRelative === '..' || actualRelative.startsWith('../'))
      throw new Error('Cannot preserve dependencies outside this npm project.');
    recovery ??= join(npmStateDirectory(root), 'verity-npm-preserved', randomUUID());
    const target = join(recovery, String(preserved.length));
    mkdirSync(recovery, { recursive: true });
    // A failed cross-device move leaves the original files intact and blocks ci.
    renameSync(modules, target);
    preserved.push({ source: modules, target });
    writeFileSync(join(recovery, 'paths.json'), JSON.stringify(preserved, null, 2) + '\n');
  }
  return recovery;
}

/** Include every pinned registry version, even if npm can satisfy it from cache. */
export function npmLockedPackages(root) {
  const path = existsSync(join(root, 'npm-shrinkwrap.json'))
    ? join(root, 'npm-shrinkwrap.json')
    : join(root, 'package-lock.json');
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      'npm age verification requires a project lockfile; resolve it with npm install first.',
    );
  }
  const lock = JSON.parse(source);
  const result = new Map();
  const add = (name, entry) => {
    if (entry.link) return;
    // Local source dependencies stay local; arbitrary Git/tarball sources have no
    // authoritative npm publication date and must not inherit registry approval.
    if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) return;
    if (
      typeof entry.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(entry.version) ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
    )
      throw new Error(
        `Cannot verify npm publication date for ${name}; use a registry version or local workspace dependency.`,
      );
    if (
      entry.resolved &&
      !/^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved) &&
      !/^http:\/\/verity-package-broker:8080\/internal\/package-artifacts\//u.test(entry.resolved)
    )
      throw new Error(
        `Cannot verify npm publication date for ${name}@${entry.version}: unsupported source.`,
      );
    result.set(`${name}@${entry.version}`, { name, version: entry.version });
  };
  if (lock.packages && typeof lock.packages === 'object') {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const at = path.lastIndexOf('node_modules/');
      if (at < 0) continue;
      const name = entry.name ?? path.slice(at + 'node_modules/'.length);
      add(name, entry);
    }
  } else if (lock.lockfileVersion === 1 && lock.dependencies) {
    const visit = (dependencies) => {
      for (const [name, entry] of Object.entries(dependencies)) {
        add(name, entry);
        if (entry.dependencies) visit(entry.dependencies);
      }
    };
    visit(lock.dependencies);
  } else throw new Error('Unsupported npm lockfile; regenerate it with a supported npm version.');
  if (result.size > 5000)
    throw new Error(
      'npm age verification supports at most 5000 distinct package versions per install.',
    );
  return { packages: [...result.values()], source, path };
}
