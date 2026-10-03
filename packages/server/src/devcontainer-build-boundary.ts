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

/** Which clone entries a build may read. `null` admits everything but the paths below. */
interface BuildInputs {
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  subtrees: readonly string[];
}

/** Never build inputs: Git's own store, and the worktrees of Verity's sessions. Those
 * hold whatever agents produced — `node_modules`, Python venvs whose interpreter link
 * is absolute, caches — and a single such link made every project rebuild fail. */
const EXCLUDED_ROOT_ENTRIES = new Set(['.git', '.verity-sessions']);
const MAX_INDEX_BYTES = 256 * 1024 ** 2;

function readVarint(buffer: Buffer, offset: number): [number, number] {
  let byte = buffer[offset++]!;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) | (byte & 0x7f);
  }
  return [value, offset];
}

/**
 * The project's tracked paths, read from the clone's Git index as data. Git itself is
 * never run here: the clone is mounted read-write into the Sandbox, so its config can
 * name programs (fsmonitor, filters) that `git ls-files` would execute on the host.
 * The index only narrows what is copied; the copy below still enforces every boundary
 * check on what it reads, so a forged index can drop inputs but never admit a link out.
 * Anything this reader does not fully understand returns `null`, and the caller falls
 * back to the whole clone minus {@link EXCLUDED_ROOT_ENTRIES}.
 */
export function trackedBuildInputs(workspaceFolder: string): BuildInputs | null {
  try {
    const gitDir = join(workspaceFolder, '.git');
    if (!lstatSync(gitDir).isDirectory()) return null;
    const indexPath = join(gitDir, 'index');
    const stat = lstatSync(indexPath);
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_INDEX_BYTES) return null;
    const index = readFileSync(indexPath);
    if (index.toString('latin1', 0, 4) !== 'DIRC') return null;
    const version = index.readUInt32BE(4);
    if (version < 2 || version > 4) return null;
    const count = index.readUInt32BE(8);
    let config = '';
    try {
      config = readFileSync(join(gitDir, 'config'), 'utf8');
    } catch {
      // No config: the default object format.
    }
    const hashBytes = /objectformat\s*=\s*sha256/iu.test(config) ? 32 : 20;
    const files = new Set<string>();
    const dirs = new Set<string>();
    const subtrees: string[] = [];
    let offset = 12;
    let previous = '';
    for (let i = 0; i < count; i++) {
      const start = offset;
      const mode = index.readUInt32BE(start + 24);
      offset = start + 40 + hashBytes;
      const flags = index.readUInt16BE(offset);
      offset += 2;
      if (flags & 0x4000) {
        if (version < 3) return null;
        offset += 2;
      }
      let path: string;
      if (version === 4) {
        let strip: number;
        [strip, offset] = readVarint(index, offset);
        if (strip > previous.length) return null;
        const end = index.indexOf(0, offset);
        if (end < 0) return null;
        path = previous.slice(0, previous.length - strip) + index.toString('utf8', offset, end);
        offset = end + 1;
      } else {
        const end = index.indexOf(0, offset);
        if (end < 0) return null;
        path = index.toString('utf8', offset, end);
        // Entries are NUL-padded to a multiple of eight bytes.
        offset = start + Math.ceil((end - start + 1) / 8) * 8;
      }
      previous = path;
      if (offset > index.length) return null;
      const type = mode >>> 12;
      if (type === 0o16 || type === 0o04)
        subtrees.push(path); // gitlink, sparse directory
      else if (type === 0o10 || type === 0o12)
        files.add(path); // file, symlink
      else return null;
      for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
        dirs.add(path.slice(0, slash));
      }
    }
    // A split index keeps entries in a shared file this reader does not follow.
    if (index.toString('latin1', offset, offset + 4) === 'link') return null;
    return { files, dirs, subtrees };
  } catch {
    return null;
  }
}

function admitted(inputs: BuildInputs | null, path: string, directory: boolean): boolean {
  if (EXCLUDED_ROOT_ENTRIES.has(path.split('/', 1)[0]!)) return false;
  if (!inputs) return true;
  // The configuration is read even when it was never committed.
  if (path === '.devcontainer' || path.startsWith('.devcontainer/')) return true;
  if (inputs.subtrees.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  return directory ? inputs.dirs.has(path) : inputs.files.has(path);
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
  const inputs = trackedBuildInputs(workspaceFolder);
  const copyDirectory = async (
    sourceFd: number,
    destination: string,
    prefix: string,
  ): Promise<void> => {
    const pinned = `/proc/self/fd/${sourceFd}`;
    for (const name of readdirSync(pinned)) {
      const relativePath = prefix + name;
      const source = join(pinned, name);
      const stat = lstatSync(source);
      if (!admitted(inputs, relativePath, stat.isDirectory())) continue;
      if (++entries > 200_000) refuse('project exceeds the 200,000 build input limit');
      if (entries % 64 === 0) await setImmediate();
      const target = join(destination, name);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(source);
        if (isAbsolute(link) || !within(snapshot, resolve(dirname(target), link))) {
          refuse(`symbolic link escapes the project: ${relativePath} -> ${link}`);
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
          await copyDirectory(fd, target, `${relativePath}/`);
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
      await copyDirectory(rootFd, snapshot, '');
    } finally {
      closeSync(rootFd);
    }
    for (const link of links) {
      if (!within(snapshot, realpathSync(link))) {
        refuse(`symbolic link escapes the project: ${relative(snapshot, link)}`);
      }
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
