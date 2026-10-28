import { backupCommand, backupWork } from './priority.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { captureTree } from './filesystem.js';
import { validateBackupPath } from './format.js';
import { BackupFileChangedError } from './capture-errors.js';

export interface FrozenGit {
  directory: string;
  git: string;
  userFiles: string;
  status: 'validated' | 'not-validated' | 'alternates-dropped' | 'unstable';
  findings: string[];
  /** Original pointer contents are encrypted metadata, never used as Git configuration. */
  pointers: { path: string; target: string }[];
}

/** Walk from the trusted project root; neither a project nor a Git ancestor may be a link. */
export async function openBackupPath(
  root: string,
  path: string,
  directory: boolean,
): Promise<FileHandle> {
  validateBackupPath(path);
  const checkedOpen = async (path: string, directory: boolean): Promise<FileHandle> => {
    const before = await lstat(path, { bigint: true });
    if (directory ? !before.isDirectory() : !before.isFile())
      throw new Error('Backup path has an unsafe type');
    const file = await open(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (directory ? constants.O_DIRECTORY : 0),
    );
    try {
      const after = await file.stat({ bigint: true });
      if (before.ino !== after.ino || before.dev !== after.dev || before.mode !== after.mode)
        throw new Error('Backup path changed while opening');
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  };
  let parent = await checkedOpen(root, true);
  try {
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const child = await checkedOpen(
        `/proc/self/fd/${parent.fd}/${part}`,
        index < parts.length - 1 || directory,
      );
      await parent.close();
      parent = child;
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}

/** Deliberately small parser: never ask Git to interpret the original configuration. */
export function sanitizedGitConfig(input: string): string | undefined {
  let section = '';
  const values = new Map<string, string>();
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const match = /^\[([a-zA-Z]+)(?:\s+"[^"]*")?\]\s*(?:[#;].*)?$/.exec(line);
      if (!match) return undefined;
      section = match[1]!.toLowerCase();
      continue;
    }
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!match) return undefined;
    const key = `${section}.${match[1]!.toLowerCase()}`;
    if (
      section === 'extensions' &&
      !['extensions.objectformat', 'extensions.worktreeconfig'].includes(key)
    )
      return undefined;
    if (
      ![
        'core.repositoryformatversion',
        'core.bare',
        'extensions.objectformat',
        'extensions.worktreeconfig',
      ].includes(key)
    )
      continue;
    const value = (match[2] ?? 'true').trim().toLowerCase();
    if (
      (key === 'core.repositoryformatversion' && !/^[01]$/.test(value)) ||
      (key === 'extensions.objectformat' && !/^(sha1|sha256)$/.test(value)) ||
      (['core.bare', 'extensions.worktreeconfig'].includes(key) && !/^(true|false)$/.test(value))
    )
      return undefined;
    values.set(key, value);
  }
  const output: string[] = [];
  for (const group of ['core', 'extensions']) {
    output.push(`[${group}]`);
    for (const [key, value] of values)
      if (key.startsWith(group + '.')) output.push(`\t${key.slice(group.length + 1)} = ${value}`);
  }
  return output.join('\n') + '\n';
}

/** Fixed executable, command allowlist, clean environment, bounded runtime and output. */
export async function runBackupGit(
  git: string,
  privateRoot: string,
  command: 'fsck' | 'repair',
  workTree?: string,
  worktrees: readonly string[] = [],
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const hooks = join(privateRoot, 'empty-hooks');
  const work = workTree ?? join(privateRoot, 'empty-worktree');
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  await mkdir(work, { recursive: true, mode: 0o700 });
  const settings = [
    `safe.directory=${git}`,
    `core.hooksPath=${hooks}`,
    'core.fsmonitor=false',
    'core.sshCommand=/bin/false',
    'credential.helper=',
    'core.askPass=/bin/false',
    'core.alternateRefsCommand=',
    'protocol.allow=never',
    'gc.auto=0',
    'maintenance.auto=false',
    'core.commitGraph=false',
    'core.multiPackIndex=false',
    'pack.useBitmaps=false',
  ];
  return new Promise<boolean>((done) => {
    const [commandPath, commandArgs] = backupCommand('/usr/bin/git', [
      ...settings.flatMap((setting) => ['-c', setting]),
      ...(command === 'fsck'
        ? ['fsck', '--connectivity-only']
        : ['worktree', 'repair', '--', ...worktrees]),
    ]);
    const child = spawn(commandPath, commandArgs, {
      cwd: privateRoot,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: privateRoot,
        LANG: 'C',
        GIT_DIR: git,
        GIT_WORK_TREE: work,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let output = 0;
    let exceeded = false;
    const limit = (bytes: Buffer): void => {
      output += bytes.length;
      if (output > 1024 * 1024) {
        exceeded = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', limit);
    child.stderr.on('data', limit);
    const timeout = setTimeout(() => {
      exceeded = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.on('error', () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      done(code === 0 && !exceeded);
    });
  });
}

async function checkFrozenGit(git: string, privateRoot: string): Promise<boolean> {
  return runBackupGit(git, privateRoot, 'fsck');
}

const userContent = (path: string): boolean =>
  path.split('/').includes('hooks') ||
  /(^|\/)config(?:\.worktree)?$/.test(path) ||
  /(^|\/)objects\/info\/alternates$/.test(path);
const pointer = (path: string): boolean => /(^|\/)(gitdir|commondir)$/.test(path);
const maximumControlFile = 1024 * 1024;

/** Call while holding the lifecycle barrier. Staging is outside every sandbox mount. */
export async function freezeGitDirectory(
  projectRoot: string,
  gitPath: string,
  stagingParent: string,
  allowedPaths?: readonly string[],
): Promise<FrozenGit> {
  const directory = await mkdtemp(join(stagingParent, 'git-'));
  let source: FileHandle | undefined;
  const result: FrozenGit = {
    directory,
    git: join(directory, 'git'),
    userFiles: join(directory, 'user-files'),
    status: 'validated',
    findings: [],
    pointers: [],
  };
  let changed = false;
  try {
    await chmod(directory, 0o700);
    await mkdir(result.userFiles, { mode: 0o700 });
    await mkdir(result.git, { mode: 0o700 });
    source = await openBackupPath(projectRoot, gitPath, true);
    for await (const entry of captureTree(`/proc/self/fd/${source.fd}/.`, {
      prefix: 'git',
      excludeRegenerable: false,
      requireStableIdentity: true,
      onExcluded: () => {
        result.findings.push('control-socket');
        result.status = 'not-validated';
      },
    })) {
      const path = entry.path.slice(4);
      if (entry.kind === 'symlink') {
        result.findings.push(`symlink:${path}`);
        result.status = 'not-validated';
        continue;
      }
      if (/^objects\/pack\/[^/]+\.bitmap$/.test(path)) continue;
      const relocated = path && userContent(path);
      const destination = path ? join(relocated ? result.userFiles : result.git, path) : result.git;
      if (entry.kind === 'directory') {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const file = await open(destination, 'wx', 0o600);
      try {
        for await (const chunk of typeof entry.source === 'function'
          ? entry.source(2)
          : entry.source) {
          const work = backupWork();
          if (work) await work.call('file', chunk, { fd: file.fd });
          else await file.writeFile(chunk);
        }
        await file.chmod(entry.mode);
      } finally {
        await file.close();
      }
      changed ||= entry.unstable?.() ?? false;
      if (/(^|\/)objects\/info\/alternates$/.test(path)) {
        if (result.status === 'validated') result.status = 'alternates-dropped';
        result.findings.push('alternates-dropped');
      }
      if (/(^|\/)config$/.test(path)) {
        const control = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await control.stat()).size > maximumControlFile) {
            result.status = 'not-validated';
            result.findings.push('config-size');
            continue;
          }
          const sanitized = sanitizedGitConfig(await control.readFile('utf8'));
          if (sanitized === undefined) {
            result.status = 'not-validated';
            result.findings.push('unsupported-config');
          } else await writeFile(join(result.git, path), sanitized, { mode: 0o600 });
        } finally {
          await control.close();
        }
      }
      if (pointer(path)) {
        const control = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await control.stat()).size > 4096) throw new Error('Oversized Git pointer');
          const target = (await control.readFile('utf8')).trim();
          result.pointers.push({ path, target });
          const absolute = resolve(projectRoot, gitPath, dirname(path), target);
          const local = relative(projectRoot, absolute);
          if (
            !target ||
            target.includes('\0') ||
            local === '..' ||
            local.startsWith('..' + sep) ||
            isAbsolute(local)
          )
            throw new Error('Git pointer outside project');
          if (
            allowedPaths &&
            !allowedPaths.some((allowed) => local === allowed || local.startsWith(allowed + '/'))
          )
            throw new Error('Git pointer outside project paths');
          const pinned = await openBackupPath(projectRoot, local, path.endsWith('commondir'));
          await pinned.close();
          const withinGit = relative(resolve(projectRoot, gitPath), absolute);
          if (
            path.endsWith('commondir') &&
            withinGit !== '..' &&
            !withinGit.startsWith('..' + sep) &&
            !isAbsolute(withinGit)
          )
            await writeFile(
              destination,
              relative(dirname(destination), join(result.git, withinGit)) + '\n',
            );
          else if (path.endsWith('gitdir')) {
            // Worktree registration points to an empty private placeholder, never the live worktree.
            const placeholder = join(directory, 'worktrees', String(result.pointers.length));
            await mkdir(placeholder, { recursive: true, mode: 0o700 });
            await writeFile(join(placeholder, '.git'), `gitdir: ${dirname(destination)}\n`);
            await writeFile(destination, join(placeholder, '.git') + '\n');
          } else throw new Error('Git common directory outside frozen repository');
        } catch {
          result.status = 'not-validated';
          result.findings.push(`unsafe-pointer:${path}`);
        } finally {
          await control.close();
        }
      }
    }
    if (changed) {
      result.status = 'unstable';
      result.findings.push('changed-during-freeze');
    }
    if (
      (result.status === 'validated' || result.status === 'alternates-dropped') &&
      !(await checkFrozenGit(result.git, directory))
    ) {
      result.status = result.status === 'alternates-dropped' ? 'not-validated' : 'unstable';
      result.findings.push('connectivity');
    }
    return result;
  } catch (error) {
    if (
      error instanceof BackupFileChangedError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      result.status = 'unstable';
      result.findings.push('changed-during-freeze');
      return result;
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await source?.close();
  }
}

/** Re-freeze under the same lifecycle authority, never run Git against a live source. */
export async function captureFrozenGit(
  projectRoot: string,
  gitPath: string,
  stagingParent: string,
  underBarrier: <T>(action: () => Promise<T>) => Promise<T>,
): Promise<FrozenGit> {
  for (let attempt = 0; ; attempt++) {
    const frozen = await underBarrier(() =>
      freezeGitDirectory(projectRoot, gitPath, stagingParent),
    );
    if (frozen.status !== 'unstable' || attempt === 2) return frozen;
    await rm(frozen.directory, { recursive: true, force: true });
  }
}
