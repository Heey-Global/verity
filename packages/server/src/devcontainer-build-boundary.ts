import { rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
  symlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function refuse(detail: string): never {
  throw new Error(`unsafe devcontainer build: ${detail}`);
}

function verifyOpenedInput(fd: number, expected: Stats): Stats {
  const actual = fstatSync(fd);
  // Some filesystem adapters do not enforce O_NOFOLLOW. Reject replacement
  // between lstat and open even on those adapters, before reading any bytes.
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    refuse('build input changed while opening');
  }
  return actual;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** JSONC supports comments and trailing commas, but never executable expressions. */
function parseJsonc(source: string): Record<string, unknown> {
  let clean = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      clean += c;
      if (c === '\\') clean += source[++i] ?? '';
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      clean += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) refuse('unterminated configuration comment');
      i = end + 1;
      clean += ' ';
    } else clean += c;
  }
  let normalized = '';
  quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      normalized += c;
      if (c === '\\') normalized += clean[++i] ?? '';
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      normalized += c;
    } else if (c !== ',' || !/^\s*[}\]]/.test(clean.slice(i + 1))) normalized += c;
  }
  return object(JSON.parse(normalized) as unknown, 'configuration');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validate(root: string, configFile: string): void {
  const config = parseJsonc(readFileSync(configFile, 'utf8'));
  // Substitution runs in the server process: a build argument alone can leak its environment.
  const remaining = JSON.stringify(config)
    .replaceAll('${containerWorkspaceFolder}', '')
    .replaceAll('${workspaceFolder}', '');
  if (remaining.includes('${')) refuse('configuration variable substitution is unsupported');
  if ('dockerComposeFile' in config) refuse('Docker Compose builds are unsupported');
  if ('cacheFrom' in config) refuse('cacheFrom is unsupported');
  const configDir = dirname(configFile);
  const pathInput = (value: unknown, label: string): void => {
    if (typeof value !== 'string' || value.length === 0 || value.includes('${')) {
      refuse(`${label} must be a literal project-relative path`);
    }
    if (isAbsolute(value)) refuse(`${label} must be project-relative`);
    const target = resolve(configDir, value);
    if (!within(root, target) || !within(root, realpathSync(target))) {
      refuse(`${label} escapes the project`);
    }
  };
  for (const key of ['dockerFile', 'context']) {
    if (key in config) pathInput(config[key], key);
  }
  if ('build' in config) {
    const build = object(config['build'], 'build');
    // Unknown switches can introduce host files through --secret, --ssh or --build-context.
    const supported = new Set(['dockerfile', 'dockerFile', 'context', 'args', 'target']);
    for (const key of Object.keys(build)) {
      if (!supported.has(key)) refuse(`build.${key} is unsupported`);
    }
    for (const key of ['dockerfile', 'dockerFile', 'context']) {
      if (key in build) pathInput(build[key], `build.${key}`);
    }
  }
  // The CLI uses Feature metadata ids to construct host-side staging paths.
  // Project-selected Features cannot be trusted to keep those paths confined.
  if ('features' in config && Object.keys(object(config['features'], 'features')).length > 0) {
    refuse('project-declared Features are unsupported; only server-injected Features are allowed');
  }
  if ('overrideFeatureInstallOrder' in config) {
    const order = config['overrideFeatureInstallOrder'];
    if (!Array.isArray(order) || order.length > 0) {
      refuse('overrideFeatureInstallOrder is unsupported');
    }
  }
}

export interface DevcontainerBuildSnapshot {
  workspaceFolder: string;
  configFile: string;
  dispose(): Promise<void>;
}

/** Pin each source directory before reading descendants; an attacker can rename or
 * replace clone entries while a rebuild copies them. A path-only preflight would
 * otherwise authorize one file and let the CLI read a different host file later.
 * Linux /proc is already required by the sandbox deployment. */
export async function createDevcontainerBuildSnapshot(
  workspaceFolder: string,
): Promise<DevcontainerBuildSnapshot> {
  const snapshot = mkdtempSync(join(tmpdir(), 'verity-build-'));
  const links: string[] = [];
  let entries = 0;
  let bytes = 0;
  let bytesSinceYield = 0;
  const copyDirectory = async (sourceFd: number, destination: string): Promise<void> => {
    const pinned = `/proc/self/fd/${sourceFd}`;
    for (const name of readdirSync(pinned)) {
      if (++entries > 200_000) refuse('project exceeds the 200,000 build input limit');
      if (entries % 64 === 0) await setImmediate();
      const source = join(pinned, name);
      const target = join(destination, name);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(source);
        if (isAbsolute(link) || !within(snapshot, resolve(dirname(target), link))) {
          refuse('symbolic link escapes the project');
        }
        symlinkSync(link, target);
        links.push(target);
      } else if (stat.isDirectory()) {
        const fd = openSync(
          source,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          if (!verifyOpenedInput(fd, stat).isDirectory()) refuse('non-directory build input');
          mkdirSync(target);
          await copyDirectory(fd, target);
        } finally {
          closeSync(fd);
        }
      } else if (stat.isFile()) {
        const fd = openSync(
          source,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const actual = verifyOpenedInput(fd, stat);
          if (!actual.isFile()) refuse('non-regular build input');
          if (bytes + actual.size > 2 * 1024 ** 3)
            refuse('project exceeds the 2 GiB build input limit');
          const out = openSync(target, 'wx', actual.mode & 0o777);
          try {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let count: number;
            while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
              bytes += count;
              bytesSinceYield += count;
              if (bytesSinceYield >= 1024 * 1024) {
                await setImmediate();
                bytesSinceYield = 0;
              }
              if (bytes > 2 * 1024 ** 3) refuse('project exceeds the 2 GiB build input limit');
              let offset = 0;
              while (offset < count) offset += writeSync(out, buffer, offset, count - offset);
            }
            fchmodSync(out, actual.mode & 0o777);
          } finally {
            closeSync(out);
          }
        } finally {
          closeSync(fd);
        }
      } else refuse('non-regular build input');
    }
  };
  try {
    const root = lstatSync(workspaceFolder);
    if (!root.isDirectory()) refuse('project root must be a real directory');
    const rootFd = openSync(
      workspaceFolder,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!verifyOpenedInput(rootFd, root).isDirectory()) refuse('project root changed');
      await copyDirectory(rootFd, snapshot);
    } finally {
      closeSync(rootFd);
    }
    for (const link of links) {
      if (!within(snapshot, realpathSync(link))) refuse('symbolic link escapes the project');
    }
    const configFile = join(snapshot, '.devcontainer', 'devcontainer.json');
    validate(snapshot, configFile);
    return {
      workspaceFolder: snapshot,
      configFile,
      dispose: () => rm(snapshot, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(snapshot, { recursive: true, force: true });
    throw cause;
  }
}
