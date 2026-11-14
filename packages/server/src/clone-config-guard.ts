import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * Guards a managed clone against a `core.worktree` written into its repository config.
 *
 * Every session of a project is a linked worktree of one clone, and every linked worktree
 * shares that clone's `.git/config`. A `core.worktree` there therefore re-points the MAIN
 * checkout for every git process that opens the clone — the server's `fetch` and
 * `reset --hard` during Repair, and git inside the Sandbox at `/work`.
 *
 * Git writes the key itself: `git init` run with both `GIT_DIR` and `GIT_WORK_TREE` set
 * records the work tree as `core.worktree`, and a hook running in a linked worktree
 * already carries `GIT_DIR` pointing into the shared repository. The value then names a
 * session worktree as the Sandbox sees it (`/work/.verity-sessions/<id>`). On the server
 * that path does not exist and every git command dies in repository setup with
 * `Invalid path '/work'`, so Repair can never succeed; where the path DOES resolve, a
 * `reset --hard` meant for the main checkout lands in a session's working tree.
 *
 * Classification is deliberately narrow:
 *
 * - `clean` — no `core.worktree`.
 * - `session-contamination` — exactly one value, naming either one direct child of a
 *   `.verity-sessions` directory under the clone root (`target: 'session'`; the main
 *   checkout never lives there), or the clone root itself (`target: 'clone-root'`). The
 *   latter only restates git's default, but as a path that exists on one side alone:
 *   `/work` is missing on the server and the host path inside the Sandbox. Neither is
 *   ever needed, so these are the values Repair removes.
 * - `unknown` — any other value, several values, or a config that is not a plain file
 *   inside the clone. Nothing is changed; Repair stops with the location to inspect.
 *
 * Reading uses `git config --file`, which does not follow `include.path` and, run from a
 * directory that is not the clone (the server's own cwd, or `/` for
 * {@link defaultCloneConfigGit}), never opens the clone's repository setup — the setup is
 * what fails on the bad value.
 */

/** Where the Sandbox mounts the clone. */
export const SANDBOX_CLONE_ROOT = '/work';

/** Directory under a clone that holds the session worktrees. */
const SESSION_ROOT = '.verity-sessions';

/** Runs `git` with the given arguments, from a directory that is not a repository. */
export type CloneConfigGit = (args: readonly string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

/** {@link CloneConfigGit} on the real binary, from `/` so no repository is discovered. */
export const defaultCloneConfigGit: CloneConfigGit = async (args) => {
  const { stdout } = await execFileAsync('git', [...args], { cwd: '/' });
  return { stdout };
};

export type CloneWorktreeFinding =
  | { kind: 'clean' }
  | {
      kind: 'session-contamination';
      file: string;
      value: string;
      target: 'session' | 'clone-root';
    }
  | { kind: 'unknown'; file: string; reason: string; values: string[] };

export interface CloneWorktreeRepair {
  file: string;
  previousValue: string;
  backupPath: string;
}

/** The finding as a sentence an operator can act on. */
export function describeCloneWorktreeFinding(
  finding: Exclude<CloneWorktreeFinding, { kind: 'clean' }>,
  canRemove = true,
): string {
  if (finding.kind === 'session-contamination') {
    const prefix = canRemove ? '' : 'repository config invalid: ';
    const remedy = canRemove
      ? 'Repair saves a backup of the file and removes only this key.'
      : 'No backup directory is configured, so Repair does not remove it; remove the key ' +
        'from that file, then repair again.';
    const what =
      finding.target === 'session'
        ? `the session worktree "${finding.value}", which re-points the shared main checkout`
        : `the clone root as "${finding.value}", a path that exists only on one side ` +
          '(server or Sandbox) and breaks git on the other';
    return `${prefix}${finding.file} sets core.worktree to ${what}. ${remedy}`;
  }
  const values = finding.values.length > 0 ? ` (${finding.values.join(', ')})` : '';
  return (
    `repository config invalid: ${finding.file} ${finding.reason}${values}. Verity does not ` +
    'change an unrecognized core.worktree; inspect the file and remove or correct the key, ' +
    'then repair again.'
  );
}

/** A config file Verity may read: absent, or a regular file inside the clone's own `.git`. */
async function configFileState(
  clonePath: string,
  name: string,
): Promise<'absent' | 'file' | 'unsafe'> {
  const file = join(clonePath, '.git', name);
  try {
    // lstat: the last component is not followed, so a symlinked config is caught here.
    if (!(await lstat(file)).isFile()) return 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe';
  }
  try {
    // `.git` itself may be a link elsewhere; the resolved file must still be this one.
    return (await realpath(file)) === join(await realpath(clonePath), '.git', name)
      ? 'file'
      : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

async function configValues(
  git: CloneConfigGit,
  file: string,
  key: string,
): Promise<string[] | undefined> {
  // Cheap pre-check: most configs never mention the key, and those need no git call.
  const text = await readFile(file, 'utf8');
  if (!text.toLowerCase().includes(key.split('.').pop()!.toLowerCase())) return [];
  let stdout: string;
  try {
    // `--list` succeeds for a file without the key, so any failure is a file git cannot
    // read — unlike `--get-all`, whose "absent" exit status each runner reports its own way.
    ({ stdout } = await git(['config', '--file', file, '--list', '--null']));
  } catch {
    return undefined;
  }
  const wanted = key.toLowerCase();
  const values: string[] = [];
  for (const entry of stdout.split('\0')) {
    const split = entry.indexOf('\n'); // `key\nvalue`, or just `key` for a bare boolean
    const name = split === -1 ? entry : entry.slice(0, split);
    // Section and key are case-insensitive; neither has a subsection here.
    if (name.toLowerCase() === wanted) values.push(split === -1 ? 'true' : entry.slice(split + 1));
  }
  return values;
}

function normalized(path: string): string {
  return posix.normalize(path).replace(/(.)\/+$/, '$1');
}

function classifyValue(
  value: string,
  gitDir: string,
  roots: readonly string[],
): 'clone-root' | 'session' | 'unknown' {
  // git resolves a relative core.worktree against the git directory.
  const target = normalized(isAbsolute(value) ? value : resolve(gitDir, value));
  for (const root of roots) {
    if (target === root) return 'clone-root';
    const prefix = `${root}/${SESSION_ROOT}/`;
    if (target.startsWith(prefix)) {
      const rest = target.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/') && rest !== '.' && rest !== '..') {
        return 'session';
      }
    }
  }
  return 'unknown';
}

/**
 * Classify the `core.worktree` a clone's main checkout would use. Reads only.
 *
 * Checks `.git/config`, and `.git/config.worktree` when `extensions.worktreeConfig`
 * makes git read it for the main worktree.
 */
export async function inspectCloneWorktreeConfig(
  clonePath: string,
  git: CloneConfigGit,
): Promise<CloneWorktreeFinding> {
  const gitDir = join(clonePath, '.git');
  let realClone = clonePath;
  try {
    realClone = await realpath(clonePath);
  } catch {
    // Missing clone: nothing below exists either, and the file checks report it.
  }
  const roots = [...new Set([clonePath, realClone, SANDBOX_CLONE_ROOT].map(normalized))];
  const files = ['config'];
  const commonState = await configFileState(clonePath, 'config');
  if (commonState === 'absent') return { kind: 'clean' };
  if (commonState === 'unsafe') {
    return {
      kind: 'unknown',
      file: join(gitDir, 'config'),
      reason: 'is not a regular file inside the clone',
      values: [],
    };
  }
  const extension = await configValues(git, join(gitDir, 'config'), 'extensions.worktreeConfig');
  if (extension?.some((value) => /^(true|yes|on|1)$/i.test(value.trim()))) {
    files.push('config.worktree');
  }
  let contamination: CloneWorktreeFinding | undefined;
  for (const name of files) {
    const file = join(gitDir, name);
    const state = name === 'config' ? commonState : await configFileState(clonePath, name);
    if (state === 'absent') continue;
    if (state === 'unsafe') {
      return {
        kind: 'unknown',
        file,
        reason: 'is not a regular file inside the clone',
        values: [],
      };
    }
    const values = await configValues(git, file, 'core.worktree');
    if (values === undefined) {
      return { kind: 'unknown', file, reason: 'cannot be read by git', values: [] };
    }
    if (values.length === 0) continue;
    if (values.length > 1) {
      return { kind: 'unknown', file, reason: 'sets core.worktree more than once', values };
    }
    const value = values[0]!;
    const verdict = classifyValue(value, gitDir, roots);
    if (verdict === 'unknown') {
      return {
        kind: 'unknown',
        file,
        reason: 'sets core.worktree outside the clone root',
        values,
      };
    }
    contamination ??= { kind: 'session-contamination', file, value, target: verdict };
  }
  return contamination ?? { kind: 'clean' };
}

/**
 * Remove a session-worktree `core.worktree` from the file {@link inspectCloneWorktreeConfig}
 * named, after a private backup of that file.
 *
 * The value is removed with `--fixed-value` (git 2.30+; the server image ships Debian
 * bookworm's 2.39), so a file rewritten in between keeps
 * whatever it now holds; the follow-up inspection then reports it instead. Only this one
 * key changes: worktrees, indexes, refs and files are never touched.
 */
export async function removeSessionWorktreeConfig(
  finding: Extract<CloneWorktreeFinding, { kind: 'session-contamination' }>,
  backupRoot: string,
  label: string,
  git: CloneConfigGit,
  now: () => Date = () => new Date(),
): Promise<CloneWorktreeRepair> {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  // `mode` only applies to a directory mkdir creates; the copies hold the whole config.
  await chmod(backupRoot, 0o700);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_');
  const backupPath = join(backupRoot, `${safeLabel}-${stamp}-${posix.basename(finding.file)}`);
  const source = await open(finding.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const content = await source.readFile();
    const target = await open(
      backupPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await target.writeFile(content);
      await target.sync();
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
  await git([
    'config',
    '--file',
    finding.file,
    '--fixed-value',
    '--unset',
    'core.worktree',
    finding.value,
  ]);
  return { file: finding.file, previousValue: finding.value, backupPath };
}

/**
 * Read-only sweep of every clone under `cloneRoot`, reporting each `core.worktree` that
 * would break or misdirect server-side git. Changes nothing: removal belongs to Repair,
 * while no Sandbox is using the clone. One unreadable clone never hides the others.
 */
export async function reportCloneWorktreeConfigs(
  cloneRoot: string,
  git: CloneConfigGit,
  report: (clonePath: string, message: string) => void,
): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(cloneRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of entries) {
    const clonePath = join(cloneRoot, name);
    try {
      const finding = await inspectCloneWorktreeConfig(clonePath, git);
      if (finding.kind !== 'clean') report(clonePath, describeCloneWorktreeFinding(finding));
    } catch {
      // ignore — a probe that cannot run reports nothing rather than a guess
    }
  }
}
