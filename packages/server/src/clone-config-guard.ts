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
const SANDBOX_CLONE_ROOT = '/work';

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
function describeCloneWorktreeFinding(
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
  // normalize() already collapses repeated slashes, so at most one trailing slash is left.
  const result = posix.normalize(path);
  return result.length > 1 && result.endsWith('/') ? result.slice(0, -1) : result;
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
  // git's boolean: everything but these (and any integer 0) is true.
  if (extension?.some((value) => !/^(false|no|off|0+|)$/i.test(value.trim()))) {
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
  canRemove = true,
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
      if (finding.kind !== 'clean')
        report(clonePath, describeCloneWorktreeFinding(finding, canRemove));
    } catch {
      // ignore — a probe that cannot run reports nothing rather than a guess
    }
  }
}

/** A git step of the clone phase failed; `step` names it in the project's failure. Carries
 *  only the redacted output, never the raw error: that can include Authorization headers. */
export class CloneStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloneStepError';
  }
}

/** Read-only: what Repair would find in the clone config, before the operator confirms. */
export async function cloneWorktreeWarning(
  clonePath: string,
  git: CloneConfigGit,
  backupRoot: string | undefined,
): Promise<string | null> {
  try {
    const finding = await inspectCloneWorktreeConfig(clonePath, git);
    if (finding.kind === 'clean') return null;
    return describeCloneWorktreeFinding(finding, backupRoot !== undefined && backupRoot !== '');
  } catch {
    return null; // a warning probe never blocks Repair; the repair path inspects again
  }
}

/**
 * Make the shared clone config safe to open before the server runs git against it.
 *
 * A removable `core.worktree` is taken out after a private backup; anything else
 * unexpected stops the provision (through `fail`) with the file and value to inspect.
 * Local projects are not handled here: their config is reduced to an allowlist that
 * already drops the key.
 */
export async function ensureCloneWorktreeConfig(options: {
  clonePath: string;
  projectId: string;
  backupRoot: string | undefined;
  git: CloneConfigGit;
  onRepaired?: ((event: { projectId: string } & CloneWorktreeRepair) => void) | undefined;
  /** Builds the provisioning error that carries an operator-facing message. */
  fail: (message: string) => Error;
}): Promise<void> {
  const { clonePath, projectId, backupRoot, git, fail } = options;
  const canRemove = backupRoot !== undefined && backupRoot.length > 0;
  // One pass per file that can carry the key (`config`, `config.worktree`), plus the
  // inspection that has to come back clean.
  for (let pass = 0; pass < 3; pass++) {
    let repair: CloneWorktreeRepair;
    let stop: Error | undefined;
    try {
      const finding = await inspectCloneWorktreeConfig(clonePath, git);
      if (finding.kind === 'clean') return;
      if (pass === 2 && finding.kind === 'session-contamination') {
        stop = fail(
          `repository config invalid: ${finding.file} still sets core.worktree ` +
            `("${finding.value}") after Repair removed it; something is writing it back. ` +
            'Stop the Sandbox, remove the key from that file, then repair again.',
        );
      } else if (finding.kind === 'unknown' || !canRemove) {
        stop = fail(describeCloneWorktreeFinding(finding, canRemove));
      }
      if (stop !== undefined) throw stop;
      repair = await removeSessionWorktreeConfig(
        finding as Extract<CloneWorktreeFinding, { kind: 'session-contamination' }>,
        backupRoot!,
        projectId,
        git,
      );
    } catch (cause) {
      if (cause === stop) throw cause;
      // An unreadable file, a failed backup, or a value that changed under the removal.
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CloneStepError('repository config check', message.split('\n')[0]!.slice(0, 200));
    }
    try {
      options.onRepaired?.({ projectId, ...repair });
    } catch {
      // Observability never changes the repair.
    }
  }
}

type Warn = (event: object, message: string) => void;

/** Provisioner options for Repair's clone-config handling, given durable server storage
 *  (absent → Repair reports a removable key instead of removing it). */
export function cloneConfigRepairOptions(
  durableRoot: string | undefined,
  warn: Warn,
): {
  cloneConfigBackupDirectory?: string;
  onCloneConfigRepaired: (event: { projectId: string } & CloneWorktreeRepair) => void;
} {
  return {
    // Dot-prefixed: no `owner-repo` clone directory can carry that name.
    ...(durableRoot === undefined
      ? {}
      : { cloneConfigBackupDirectory: join(durableRoot, '.clone-config-backups') }),
    onCloneConfigRepaired: (event) =>
      warn(event, 'verity: removed a core.worktree from a clone config'),
  };
}

/**
 * Start the read-only startup sweep ({@link reportCloneWorktreeConfigs}) without waiting
 * for it. A `core.worktree` in a shared clone config fails every later Repair with
 * "Invalid path", or points server-side git at a session's files; reporting it at startup
 * makes it visible before an update recreates the Sandbox. Repair is what removes it.
 */
export function startCloneConfigSweep(
  cloneRoot: string | undefined,
  canRemove: boolean,
  warn: Warn,
): void {
  if (!cloneRoot) return;
  void reportCloneWorktreeConfigs(
    cloneRoot,
    defaultCloneConfigGit,
    (clonePath, message) =>
      warn({ clonePath }, `verity: project clone config needs repair: ${message}`),
    canRemove,
  ).catch(() => undefined);
}
