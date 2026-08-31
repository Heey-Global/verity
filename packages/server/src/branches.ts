import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SandboxUnavailableError } from './sandbox-git.js';

const execFileAsync = promisify(execFile);

/**
 * Whether the base clone is sitting in the middle of a merge, read from the file git
 * writes for it rather than by running git.
 *
 * The one question that still has to be answerable with the sandbox gone. Every other
 * probe in the merge path goes through the sandbox, because reading this repository with
 * the server's git would run what its config names; a `stat` runs nothing at all, and the
 * clone is on the server's own filesystem — it created it.
 *
 * Absent is the ONLY answer that means "no merge in progress": a path that cannot be read
 * is unknown state, and the safe reading of unknown state here is that something was left
 * behind.
 */
function mergeInProgressOnDisk(basePath: string): boolean {
  try {
    statSync(join(basePath, '.git', 'MERGE_HEAD'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Switches the working branch of a session's git worktree while keeping the chat
 * (concept #91 "branch switcher"). An operator can move a worktree onto a fresh
 * branch off the base, or onto an existing local branch that isn't checked out
 * anywhere else — handling uncommitted changes by blocking, stashing, or
 * committing a checkpoint first.
 */

/** Runs a `git` invocation and resolves with its stdout. Injected so tests can
 * assert args without a real repo; defaults to `execFile('git', …)`. Rejects on
 * a non-zero exit (execFile does). */
export type GitOutput = (args: readonly string[]) => Promise<string>;

const defaultGitOutput: GitOutput = async (args) => {
  const { stdout } = await execFileAsync('git', [...args]);
  return stdout;
};

/**
 * Config pins for the local-merge path, whose git commands run against a repository
 * the sandbox owns. They run INSIDE that sandbox (see `createSandboxGit`), so these
 * are no longer a security boundary — a program the repository's config names is the
 * sandbox's own, running where it is already allowed to run. What is left is
 * determinism: a Verity-initiated merge must do the same thing in every project, and
 * must not be blocked or rewritten by whatever the repository has configured.
 *
 * - `--work-tree` pins WHERE the command writes, against a `core.worktree` that points
 *   the working tree somewhere else entirely. It has to be the option and not
 *   `-c core.worktree=…`: git reads that key during repository setup, before `-c`
 *   overrides apply, so the `-c` form does not win. `--work-tree` (like `GIT_WORK_TREE`)
 *   does, and is correct for a linked worktree too.
 * - `core.hooksPath=/dev/null` makes every hook lookup fail to resolve, which git treats
 *   as "no hook" — a repository's `pre-merge-commit` cannot veto the operator's merge.
 * - `core.fsmonitor=false` disables the file-system monitor, otherwise spawned as a
 *   hook-like helper on each index refresh.
 * - `merge.verifySignatures=false`: a local project has no signing policy to enforce,
 *   and an inherited `true` would abort the merge on unsigned session commits.
 * - `submodule.recurse=false` keeps `merge`/`checkout` from descending into submodules,
 *   which is work the operator did not ask for.
 *
 * Applied to every invocation in the local-merge path that refreshes the index, writes
 * a ref, or commits. Plain ref plumbing (`rev-parse`, `show-ref`, `symbolic-ref`) reads
 * no such config and writes nothing to the working tree, and is left alone.
 *
 * @param repoPath the repository the command runs in — the same path passed to `-C`.
 */
function untrustedRepo(repoPath: string): string[] {
  return [
    `--work-tree=${repoPath}`,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'merge.verifySignatures=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'credential.helper=',
    '-c',
    'core.sshCommand=ssh -F /dev/null',
    '-c',
    'protocol.ext.allow=never',
  ];
}

/** The worktree has uncommitted changes and `onDirty` was `'block'`. */
export class DirtyWorktreeError extends Error {
  constructor(worktreePath: string) {
    super(`worktree "${worktreePath}" has uncommitted changes; commit, stash, or use onDirty`);
    this.name = 'DirtyWorktreeError';
  }
}

/** The target branch is already checked out in another worktree. */
export class BranchInUseError extends Error {
  constructor(branch: string) {
    super(`branch "${branch}" is checked out in another worktree`);
    this.name = 'BranchInUseError';
  }
}

/** The requested new branch already exists. */
export class BranchExistsError extends Error {
  constructor(branch: string) {
    super(`branch "${branch}" already exists`);
    this.name = 'BranchExistsError';
  }
}

/** The switch target branch does not exist. */
export class BranchNotFoundError extends Error {
  constructor(branch: string) {
    super(`branch "${branch}" does not exist`);
    this.name = 'BranchNotFoundError';
  }
}

/** A project's managed base checkout cannot receive a merge: it is missing,
 *  detached, or has uncommitted changes of its own. */
export class BaseCheckoutUnavailableError extends Error {
  constructor(basePath: string, reason: string) {
    super(`base checkout "${basePath}" cannot be merged into: ${reason}`);
    this.name = 'BaseCheckoutUnavailableError';
  }
}

/** The merge failed AND the base checkout could not be put back the way it was, so it
 *  may still be sitting mid-merge. Distinct from every other failure on this path:
 *  those all leave the base untouched, and merging again is safe. */
export class BaseCheckoutStrandedError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
    cause?: unknown,
  ) {
    super(`merging "${branch}" into "${base}" failed and the base checkout was not restored`);
    this.name = 'BaseCheckoutStrandedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** The merge stopped on conflicting changes and was rolled back. Carries the two
 *  branch names so callers can name them without re-parsing the message. */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
  ) {
    super(`merging "${branch}" into "${base}" hit conflicts`);
    this.name = 'MergeConflictError';
  }
}

/** The branch carries nothing the base does not already have. */
export class NothingToMergeError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
  ) {
    super(`branch "${branch}" is already contained in "${base}"`);
    this.name = 'NothingToMergeError';
  }
}

/** The requested new-branch name is unsafe / malformed. */
export class InvalidBranchNameError extends Error {
  constructor(branch: string) {
    super(`branch name "${branch}" is invalid`);
    this.name = 'InvalidBranchNameError';
  }
}

export interface GitBranchServiceOptions {
  /** The source repository whose branches/worktrees are inspected (e.g. /work).
   *  Omit for multi-project runners: repo-wide commands then use each session's
   *  worktree, which resolves to that worktree's shared repository metadata. */
  repoDir?: string;
  /** Branch new branches are created off. Default `main`. */
  baseBranch?: string;
  /** Injected git runner (tests); defaults to the real `git`. */
  git?: GitOutput;
  /** Injected merge-state probe (tests); defaults to {@link mergeInProgressOnDisk}. */
  mergeInProgress?: (basePath: string) => boolean;
}

export interface SwitchOptions {
  /** Create and switch to a NEW branch off the base. */
  newBranch?: string;
  /** Switch to an EXISTING local branch. */
  branch?: string;
  /**
   * PREVIEW a pushed branch (issue #122): fetch `origin/<preview>` and check it
   * out DETACHED, so it never claims the local branch name and so a branch being
   * developed in another worktree can still be previewed (no {@link
   * BranchInUseError}). The cockpit uses this to see an open PR live.
   */
  preview?: string;
  /** How to handle uncommitted changes. Default `'block'`. */
  onDirty?: 'block' | 'stash' | 'commit';
}

export interface GitBranchService {
  /** The branch currently checked out in the worktree. When the worktree is
   * detached at a previewed `origin/<branch>` tip, resolves to that branch name
   * (not git's bare "HEAD"); falls back to a short SHA for any other detached HEAD. */
  current(worktreePath: string): Promise<string>;
  /**
   * The branches this session has worked on, worktree HEAD first, then the others
   * most-recently-active first. Sourced from the worktree's OWN HEAD reflog (each
   * linked worktree keeps its own), which records every branch checked out here — so
   * a multi-phase session that created/pushed several feature branches is attributed
   * all of them, not just its current HEAD. Excludes the base branch and any reflog
   * token that isn't a real local branch (bare SHAs from detached checkouts). Falls
   * back to just `[current]` when the reflog is unavailable, so the single-branch
   * case is unchanged. Used to find a session's PR when it lives on a branch other
   * than the worktree HEAD.
   */
  sessionBranches(worktreePath: string): Promise<string[]>;
  /** Whether the worktree has uncommitted (or untracked) changes. */
  isDirty(worktreePath: string): Promise<boolean>;
  /** Local branches the worktree could switch to (not checked out elsewhere). */
  switchable(worktreePath: string): Promise<string[]>;
  /** Pushed branches (`origin/*`) the worktree can PREVIEW (issue #122) — open-PR
   * / remote branches, INCLUDING ones checked out in another worktree. Excludes
   * the base branch and `origin/HEAD`. */
  previewable(worktreePath: string): Promise<string[]>;
  /** Switch the worktree to a new/existing/previewed branch; resolves the new current branch. */
  switch(worktreePath: string, opts: SwitchOptions): Promise<string>;
  /**
   * Rename a fresh session branch in place from an auto-generated `<type>/<slug>`
   * candidate. Only local, unpublished Verity-minted branches are renamed; pushed
   * branches with an upstream are left untouched so existing PR heads keep matching.
   * Returns the new branch name, or `null` when the guard decides to skip.
   */
  autoRename(worktreePath: string, candidate: string): Promise<string | null>;
  /**
   * After the operator merges the session's PR, bring the worktree back onto the
   * freshly-merged base and delete the now-merged local feature branch. Fetches
   * `origin/<base>` and checks it out DETACHED (never claims the `base` branch
   * name) so parallel session worktrees can all sit on the merged base without
   * git's "already checked out elsewhere" refusal — the same reason previews
   * detach (#122). Resolves the base name and the deleted branch (absent when the
   * worktree was already on the base or on a detached/preview HEAD with no local
   * branch to delete). Best-effort by contract: the caller has already merged on
   * GitHub, so it must treat a rejection here as a warning, not a merge rollback.
   * The detach uses `checkout -f`, discarding any uncommitted changes — call this
   * only when the session is idle (no in-flight turn), never mid-turn.
   *
   * `base` is the branch the pull request actually merged INTO, which is not
   * always the project's base branch: a stacked PR targets another session's
   * branch, and resetting such a worktree to the project base would force-check-out
   * a commit that does NOT contain the work just merged. Pass the merged PR's base
   * ref whenever it is known; omitting it keeps the project base, which is correct
   * for the ordinary case and the only answer available to a caller that cannot
   * resolve the PR. A malformed ref is rejected rather than silently replaced by the
   * project base — that fallback is the very reset this parameter exists to prevent.
   *
   * @throws InvalidBranchNameError
   */
  resetToMergedBase(
    worktreePath: string,
    opts?: { base?: string },
  ): Promise<{ base: string; deletedBranch?: string }>;
  /**
   * Merge a session branch into the project's base branch WITHOUT GitHub — the
   * merge path for `local` projects, which have no remote and therefore no pull
   * request to merge. `basePath` is the project's managed clone, the checkout the
   * session worktrees hang off; its currently checked-out branch IS the base (read
   * live rather than assumed, so a project initialized on a non-`main` default
   * branch merges into the branch it actually has).
   *
   * Both checkouts must be clean and the base must be attached to a branch, so a
   * rejection never leaves half-merged state behind. Conflicts abort the merge and
   * raise {@link MergeConflictError} — the base checkout is restored to its
   * pre-merge state and the operator resolves the conflict in the session instead.
   * Calls against the same `basePath` are serialized, so parallel sessions of one
   * project cannot interleave their merges.
   *
   * `git` is REQUIRED and is not the service's own runner: every command below runs
   * against a repository the sandbox owns — including its `.git/config`, which can
   * name programs git executes — so the caller passes a runner that executes them
   * INSIDE that sandbox (`createSandboxGit`). Making it a parameter rather than a
   * fallback is deliberate: there is no configuration in which this quietly runs
   * server-side instead.
   *
   * This touches only the base checkout; the session worktree is left on its branch
   * so the caller can defer the (destructive) reset to {@link resetToLocalBase}
   * until the session is idle. Pass the whole result to that call: `mergedTip` is the
   * branch commit this merge absorbed, so it can detect work committed in between, and
   * `baseTip` is the merge commit it created, so the worktree lands on THIS merge even
   * if another session moved the base on in between.
   */
  mergeIntoLocalBase(
    worktreePath: string,
    basePath: string,
    opts: { git: GitOutput },
  ): Promise<{
    base: string;
    branch: string;
    mergedTip: string;
    baseTip: string;
  }>;
  /**
   * Post-{@link mergeIntoLocalBase} housekeeping: detach the session worktree onto
   * the merged `base` and delete the branch it was on. Detaches rather than checks
   * the base out for the same reason {@link resetToMergedBase} does — the project's
   * clone already claims that branch — but needs no fetch, since the worktree shares
   * the clone's refs and objects. Resolves the deleted branch, absent when the
   * worktree was already on the base or on a detached HEAD.
   *
   * `merged` is the result of that call. `branch` is the one the merge absorbed, and
   * only that branch is deleted: a worktree that has since moved to another branch is
   * left alone entirely, since a second branch can point at the same commit and the tip
   * comparison alone would not tell the two apart.
   *
   * `mergedTip`, the branch commit it absorbed, is what keeps work the session added
   * afterwards from being discarded, whenever it arrived: the branch is deleted by
   * compare-and-swap against it, and the checkout runs unforced so git itself refuses to
   * overwrite modified files. When the branch has already moved on, or the worktree
   * carries uncommitted tracked changes, it resolves `{ skipped: true }` having changed
   * nothing — the operator merges again to bring that work across.
   *
   * `baseTip`, the merge commit that call created, is what the worktree detaches ONTO.
   * Deliberately not the base branch as it stands now: another session of the same
   * project can merge into it between the two calls, and the operator is told the
   * worktree sits at the commit their merge produced.
   *
   * The two steps are not atomic together, so the outcome is reported per step rather
   * than as one boolean: `deletedBranch` means both landed, `retainedBranch` means the
   * worktree was detached but the branch outlived the compare-and-swap (it moved on in
   * between), and `skipped` means nothing was touched at all.
   *
   * Best-effort by contract: the merge has already landed, so a rejection here is a
   * warning, not a rollback.
   *
   * `git` is the same in-sandbox runner {@link mergeIntoLocalBase} takes, and for the
   * same reason.
   */
  resetToLocalBase(
    worktreePath: string,
    base: string,
    merged: { branch: string; mergedTip: string; baseTip: string },
    opts: { git: GitOutput },
  ): Promise<{
    base: string;
    deletedBranch?: string;
    retainedBranch?: string;
    skipped?: true;
  }>;
}

/**
 * A conservative branch-name guard for newly created branches: one or more of
 * `[A-Za-z0-9._/-]`, no leading `-` (could be read as a git flag), no `..`
 * (ref traversal / `git` rejects it), no whitespace. Stricter than git's own
 * `check-ref-format` on purpose — we only mint simple names.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/**
 * Whether a branch name that Verity did NOT mint is safe to put in argv of a git
 * command.
 *
 * Deliberately not {@link isValidBranchName}: that one is a naming policy for
 * branches this server creates, and applying it to a name GitHub already accepted
 * would reject perfectly ordinary refs — `release+next`, or anything not spelled in
 * ASCII. What matters here is only that git reads the argument as the ref it is, so
 * this is git's own ref grammar by exclusion (`git check-ref-format`) plus the one
 * rule argv adds: a leading `-` is an option, not a name.
 *
 * The 255-character bound is not part of that grammar; it is GitHub's own cap on a
 * branch name, so it cannot reject a ref that arrived from there, and it keeps an
 * absurd argument out of argv.
 */
export function isSafeRefName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('-')) return false;
  // Control characters, space, DEL, and the characters git itself forbids in a ref.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name === '@') return false;
  if (name.endsWith('.')) return false;
  // No empty, dot-leading, or `.lock`-suffixed component (`a//b`, `a/.b`, `a.lock/b`).
  return name
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Refuse a ref name that git could read as anything but a ref when it lands in argv of
 *  a server-side command — an option (`-x`), a range (`a..b`), or a name carrying shell
 *  or ref metacharacters. The local-merge path takes both of its ref names from a
 *  repository the sandbox can write, so it validates them once up front rather than
 *  terminating option parsing at every call site (`git checkout -- <ref>` cannot: there
 *  `--` introduces paths, not refs).
 *
 *  @throws InvalidBranchNameError */
function assertPlainRef(name: string): void {
  if (!isValidBranchName(name)) throw new InvalidBranchNameError(name);
}

/** Parse `git worktree list --porcelain` for the set of branches checked out in
 * any worktree (lines `branch refs/heads/<name>`). */
function checkedOutBranches(porcelain: string): Set<string> {
  const out = new Set<string>();
  for (const line of porcelain.split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (m?.[1] != null) out.add(m[1]);
  }
  return out;
}

/**
 * Build a {@link GitBranchService}. All git access goes through the injected
 * runner; nothing here touches the filesystem directly. Branch existence and
 * checkout-elsewhere are pre-checked against `repoDir` so a failed switch reports
 * a typed error rather than a raw git exit.
 */
export function createGitBranchService(opts: GitBranchServiceOptions): GitBranchService {
  const baseBranch = opts.baseBranch ?? 'main';
  const git = opts.git ?? defaultGitOutput;
  const mergeInProgress = opts.mergeInProgress ?? mergeInProgressOnDisk;

  /** True iff `refs/heads/<branch>` exists in the repo. */
  async function branchExists(worktreePath: string, branch: string): Promise<boolean> {
    try {
      await git([
        '-C',
        opts.repoDir ?? worktreePath,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      // show-ref --quiet exits non-zero when the ref is absent.
      return false;
    }
  }

  /** Short names of `origin/*` remote branches, excluding `origin/HEAD`. */
  async function remoteBranches(worktreePath: string): Promise<string[]> {
    const refs = await git([
      '-C',
      worktreePath,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    ]);
    return refs
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== 'origin/HEAD')
      .map((l) => l.replace(/^origin\//, ''));
  }

  async function current(worktreePath: string): Promise<string> {
    const out = (await git(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (out !== 'HEAD') return out; // a normal (attached) branch
    // Detached HEAD (e.g. a #122 preview checkout of `origin/<branch>`): show the
    // branch name whose remote tip == HEAD rather than git's bare "HEAD".
    const pointed = await git([
      '-C',
      worktreePath,
      'for-each-ref',
      '--points-at',
      'HEAD',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    ]);
    // If several remote branches share the tip (e.g. two PRs at one commit), take
    // the first — `for-each-ref` orders by refname, so it's deterministic. This is
    // only the displayed label; the checkout itself is by SHA, so a tie is cosmetic.
    const match = pointed
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && l !== 'origin/HEAD');
    if (match !== undefined) return match.replace(/^origin\//, '');
    // A `local` project has no remotes at all, so the post-merge detach (see
    // `mergeIntoLocalBase`) sits on a commit only LOCAL refs point at. Label it
    // with that branch — same intent as the remote lookup above: show the base the
    // worktree was reset onto, not a bare SHA.
    const localPointed = await git([
      '-C',
      worktreePath,
      'for-each-ref',
      '--points-at',
      'HEAD',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    const localMatch = localPointed
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (localMatch !== undefined) return localMatch;
    // Any other detached HEAD → a short SHA is more useful than "HEAD".
    return (await git(['-C', worktreePath, 'rev-parse', '--short', 'HEAD'])).trim();
  }

  async function sessionBranches(worktreePath: string): Promise<string[]> {
    const here = await current(worktreePath);
    let extra: string[] = [];
    try {
      // The worktree's OWN HEAD reflog records every checkout that happened here — a
      // linked worktree keeps its own HEAD reflog under `.git/worktrees/<id>/logs/HEAD`,
      // so this is exactly the set of branches THIS session touched. `%gs` is the
      // reflog subject; a checkout reads `checkout: moving from <a> to <b>`, newest
      // entry first.
      const reflog = await git(['-C', worktreePath, 'reflog', 'show', '--format=%gs', 'HEAD']);
      const candidates: string[] = [];
      const seen = new Set<string>();
      for (const line of reflog.split('\n')) {
        const m = /^checkout: moving from (.+) to (.+)$/.exec(line.trim());
        if (m === null) continue;
        // The `to` side is the more recent of the pair; record it before the `from`.
        for (const name of [m[2], m[1]]) {
          if (name !== undefined && name.length > 0 && !seen.has(name)) {
            seen.add(name);
            candidates.push(name);
          }
        }
      }
      // Keep only real local branches — a reflog token can be a bare SHA (detached
      // checkout, e.g. a #122 preview) which `branchExists` filters out. Drop the base
      // and the current branch (added first, below). The existence probes are
      // independent, so run them in parallel — this is on the ~2s `/sessions` poll
      // path and a long session can accumulate several distinct branches.
      const named = candidates.filter((name) => name !== here && name !== baseBranch);
      const exists = await Promise.all(named.map((name) => branchExists(worktreePath, name)));
      extra = named.filter((_, i) => exists[i]);
    } catch {
      // No reflog / git error → just the current branch (single-branch behavior).
    }
    return [here, ...extra];
  }

  async function isDirty(worktreePath: string): Promise<boolean> {
    const out = await git(['-C', worktreePath, 'status', '--porcelain']);
    return out.trim().length > 0;
  }

  async function switchable(worktreePath: string): Promise<string[]> {
    const refs = await git([
      '-C',
      opts.repoDir ?? worktreePath,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    const all = refs
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const porcelain = await git([
      '-C',
      opts.repoDir ?? worktreePath,
      'worktree',
      'list',
      '--porcelain',
    ]);
    const inUse = checkedOutBranches(porcelain);
    // This worktree's own branch is reported as checked-out by `worktree list`,
    // but also exclude it explicitly so a detached HEAD or unparsed porcelain
    // line can never leave the current branch in the candidate set.
    const here = await current(worktreePath);
    const result = all.filter((b) => b !== here && !inUse.has(b)).sort();
    // Surface the base branch first when it's a candidate.
    const baseIdx = result.indexOf(baseBranch);
    if (baseIdx > 0) {
      result.splice(baseIdx, 1);
      result.unshift(baseBranch);
    }
    return result;
  }

  async function previewable(worktreePath: string): Promise<string[]> {
    // All pushed branches, minus the base (you switch to it locally, not preview)
    // and minus whatever HEAD is already on. Crucially this does NOT exclude
    // branches checked out in another worktree — previewing those (detached) is
    // the whole point (#122).
    const remote = await remoteBranches(worktreePath);
    const here = await current(worktreePath);
    const result = remote.filter((b) => b !== baseBranch && b !== here).sort();
    return result;
  }

  /** Resolve dirty changes per `onDirty` before a checkout. */
  async function handleDirty(
    worktreePath: string,
    onDirty: SwitchOptions['onDirty'],
  ): Promise<void> {
    if (!(await isDirty(worktreePath))) return;
    const mode = onDirty ?? 'block';
    if (mode === 'block') throw new DirtyWorktreeError(worktreePath);
    if (mode === 'stash') {
      await git(['-C', worktreePath, 'stash', 'push', '--include-untracked']);
      return;
    }
    // mode === 'commit'
    await git(['-C', worktreePath, 'add', '-A']);
    await git(['-C', worktreePath, 'commit', '-m', 'wip: checkpoint before branch switch']);
  }

  async function doSwitch(worktreePath: string, sw: SwitchOptions): Promise<string> {
    const targets = [sw.newBranch, sw.branch, sw.preview].filter((t) => t != null);
    if (targets.length !== 1) {
      throw new Error('specify exactly one of newBranch/branch/preview');
    }

    const target = sw.newBranch ?? sw.branch ?? sw.preview;
    if (target === undefined || !isValidBranchName(target)) {
      throw new InvalidBranchNameError(target ?? '');
    }

    // Validate the complete target before checkpointing or stashing user work.
    await handleDirty(worktreePath, sw.onDirty);

    if (sw.newBranch != null) {
      const newBranch = sw.newBranch;
      if (await branchExists(worktreePath, newBranch)) throw new BranchExistsError(newBranch);
      await git(['-C', worktreePath, 'checkout', '-b', newBranch, baseBranch]);
    } else if (sw.preview != null) {
      // PREVIEW (#122): fetch the pushed branch and check it out DETACHED at
      // `origin/<preview>`. Detached HEAD doesn't claim the branch name, so this
      // works even while another worktree is developing that branch.
      const preview = sw.preview;
      const remoteRef = `refs/remotes/origin/${preview}`;
      try {
        await git(['-C', worktreePath, 'fetch', 'origin', `+refs/heads/${preview}:${remoteRef}`]);
      } catch {
        // No such branch on the remote (or fetch refused it).
        throw new BranchNotFoundError(preview);
      }
      await git(['-C', worktreePath, 'checkout', '--detach', remoteRef]);
    } else {
      const branch = sw.branch as string;
      if (!(await branchExists(worktreePath, branch))) throw new BranchNotFoundError(branch);
      const porcelain = await git([
        '-C',
        opts.repoDir ?? worktreePath,
        'worktree',
        'list',
        '--porcelain',
      ]);
      if (checkedOutBranches(porcelain).has(branch)) throw new BranchInUseError(branch);
      await git(['-C', worktreePath, 'checkout', '--', branch]);
    }

    return current(worktreePath);
  }

  async function hasUpstream(worktreePath: string): Promise<boolean> {
    try {
      await git(['-C', worktreePath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      return true;
    } catch {
      return false;
    }
  }

  /** `run` defaults to the service's own git; the local-merge path passes its
   *  in-sandbox runner so the lookup happens in the same repository view as the
   *  merge that follows it. */
  async function branchExistsInWorktree(
    worktreePath: string,
    branch: string,
    run: GitOutput = git,
  ): Promise<boolean> {
    try {
      await run(['-C', worktreePath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch (error) {
      // Same reason as `attachedBranch`: a sandbox that could not run the command has
      // not told us the ref is missing, and callers here act on "missing" (refusing the
      // merge, or leaving a merged branch behind).
      if (error instanceof SandboxUnavailableError) throw error;
      return false;
    }
  }

  function autoRenameTarget(currentBranch: string, candidate: string): string | undefined {
    if (!isValidBranchName(candidate)) return undefined;
    const candidateMatch =
      /^(feat|fix|chore|refactor|docs|style|test)\/([a-z0-9][a-z0-9-]{0,39})$/.exec(candidate);
    if (candidateMatch === null) return undefined;
    const [, type, slug] = candidateMatch;

    const agent = /^agent\/(?:.+-)?([0-9a-f]{8})$/.exec(currentBranch);
    if (agent !== null) return `${type}/${slug}-${agent[1]}`;

    const issue = /^(?:feat|fix|chore|refactor|docs|style|test)\/(\d+)-([0-9a-f]{8})$/.exec(
      currentBranch,
    );
    if (issue !== null) return `${type}/${issue[1]}-${slug}-${issue[2]}`;

    return undefined;
  }

  async function autoRename(worktreePath: string, candidate: string): Promise<string | null> {
    const here = await current(worktreePath);
    const target = autoRenameTarget(here, candidate);
    if (target === undefined || target === here) return null;
    if (!isValidBranchName(target)) return null;
    if (await hasUpstream(worktreePath)) return null;
    if (await branchExistsInWorktree(worktreePath, target)) return null;
    await git(['-C', worktreePath, 'branch', '-m', target]);
    return target;
  }

  async function resetToMergedBase(
    worktreePath: string,
    opts: { base?: string } = {},
  ): Promise<{ base: string; deletedBranch?: string }> {
    // The branch the merge actually landed on. It reaches argv of the commands
    // below, so an argument is checked against git's ref grammar first — every
    // argument, with no shortcut for one that happens to equal the configured base,
    // so what the check does never depends on the deployment it runs in. It is git's
    // grammar, not the naming policy for branches Verity mints: that one would reject
    // ordinary names GitHub accepts. Absent an argument the project's own base stands
    // as configured — a malformed one there is a provisioning bug, not input.
    let base = baseBranch;
    if (opts.base !== undefined) {
      if (!isSafeRefName(opts.base)) throw new InvalidBranchNameError(opts.base);
      base = opts.base;
    }
    // Capture the branch to delete BEFORE we move off it. A detached/preview HEAD
    // resolves to a remote name or short SHA (see `current`) — `branchExists`
    // below then finds no local branch and we skip the delete.
    const feature = await current(worktreePath);
    if (!isValidBranchName(feature)) return { base };
    const featureTip =
      feature !== base && feature !== baseBranch && (await branchExists(worktreePath, feature))
        ? (await git(['-C', worktreePath, 'rev-parse', `refs/heads/${feature}`])).trim()
        : undefined;
    // An idle observation can race a new turn. Refuse before changing HEAD when
    // tracked work has appeared, and let the unforced checkout below enforce the
    // same invariant across the remaining window.
    if (await hasTrackedChanges(worktreePath, git)) return { base };
    // Pull the merged base tip into this worktree's object store. Both refs are
    // fully qualified so nothing in the name can be read as syntax: a bare
    // `fetch origin +foo` would parse the `+` as the refspec's force marker and
    // fetch `foo` instead, and a bare `origin/foo` rev could be shadowed by a
    // local branch literally named that. The leading `+` on the refspec forces
    // the remote-tracking ref to follow a force-pushed base, as a clone's own
    // refspec does — plain `fetch origin <base>` updated it the same way.
    const remoteRef = `refs/remotes/origin/${base}`;
    await git([
      '-C',
      worktreePath,
      ...untrustedRepo(worktreePath),
      'fetch',
      'origin',
      `+refs/heads/${base}:${remoteRef}`,
    ]);
    // Detach onto the merged tip: never claims the `base` branch name (so it can't
    // block a parallel worktree), and `-f` discards the merged feature branch's now
    // stale working tree. `current()` still reports "<base>" for this detached HEAD
    // via its points-at lookup, so the cockpit shows the base.
    await git([
      '-C',
      worktreePath,
      ...untrustedRepo(worktreePath),
      'checkout',
      '--detach',
      remoteRef,
    ]);
    // Delete the merged local feature branch — only when it was a real local branch
    // (not a base, not a detached/preview label). Both bases are excluded: the merge
    // target because the worktree now sits on it, and the project base because it is
    // never a session's own branch to remove. `-D` (not `-d`): the operator explicitly
    // merged, and a squash/rebase merge leaves the local tip un-merged by git's
    // ancestry check, which `-d` would refuse.
    if (featureTip !== undefined) {
      const deleted = await git([
        '-C',
        worktreePath,
        ...untrustedRepo(worktreePath),
        'update-ref',
        '-d',
        `refs/heads/${feature}`,
        featureTip,
      ])
        .then(() => true)
        .catch(async (error: unknown) => {
          if (error instanceof SandboxUnavailableError) throw error;
          const currentTip = await git([
            '-C',
            worktreePath,
            'rev-parse',
            '--verify',
            `refs/heads/${feature}`,
          ]).catch(() => '');
          if (currentTip.trim() === featureTip) throw error;
          return false;
        });
      if (deleted) return { base, deletedBranch: feature };
    }
    return { base };
  }

  /** The branch the managed base checkout has attached, or undefined when it is
   *  detached / not a usable repository. */
  async function attachedBranch(repoPath: string, run: GitOutput): Promise<string | undefined> {
    try {
      const out = (
        await run(['-C', repoPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
      ).trim();
      return out.length > 0 ? out : undefined;
    } catch (error) {
      // A sandbox that cannot run the command tells us nothing about HEAD; reporting
      // "detached" here would surface a stopped container as a repository problem.
      if (error instanceof SandboxUnavailableError) throw error;
      // Detached HEAD (exit 1 under --quiet) or no repository at that path.
      return undefined;
    }
  }

  /** Uncommitted changes to TRACKED files. Deliberately narrower than {@link isDirty}:
   *  the project clone permanently carries the untracked `.verity-sessions/` directory
   *  its session worktrees live in, so counting untracked files would make every merge
   *  look blocked. Untracked files are also the ones not at risk here — `git merge`
   *  refuses on its own rather than clobbering one, and the post-merge checkout
   *  leaves them alone. */
  async function hasTrackedChanges(repoPath: string, run: GitOutput): Promise<boolean> {
    const out = await run([
      '-C',
      repoPath,
      ...untrustedRepo(repoPath),
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    return out.trim().length > 0;
  }

  /** Tail of the in-flight chain per base checkout path; pruned once it drains. */
  const baseQueues = new Map<string, Promise<void>>();

  /** Run `fn` after every task already queued for `basePath` has settled. */
  function queuedOnBase<T>(basePath: string, fn: () => Promise<T>): Promise<T> {
    const prior = baseQueues.get(basePath) ?? Promise.resolve();
    // `then(fn, fn)`: a predecessor's rejection must not skip or fail this task.
    const run = prior.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    baseQueues.set(basePath, settled);
    void settled.then(() => {
      // Only the tail clears the entry, so a task queued meanwhile keeps its chain.
      if (baseQueues.get(basePath) === settled) baseQueues.delete(basePath);
    });
    return run;
  }

  async function mergeIntoLocalBase(
    worktreePath: string,
    basePath: string,
    { git: run }: { git: GitOutput },
  ): Promise<{ base: string; branch: string; mergedTip: string; baseTip: string }> {
    // Serialize per base checkout: two sessions of the same project merging at once
    // would collide on git's index lock, and the loser's `merge --abort` could roll
    // back the winner's merge. The queue is per server process, which covers the
    // deployment — one Verity server owns a project's managed clone.
    return queuedOnBase(basePath, async () => {
      const base = await attachedBranch(basePath, run);
      if (base === undefined) {
        throw new BaseCheckoutUnavailableError(basePath, 'it is not attached to a branch');
      }
      // `symbolic-ref`, not `current`: `current` labels a DETACHED head with whatever
      // local branch happens to point at the same commit (that is what the #122 preview
      // UI wants). Merging on that label would let a detached session merge — and the
      // cleanup delete — a branch it is not on. Only a real attached branch qualifies.
      const branch = await attachedBranch(worktreePath, run);
      if (branch === undefined) throw new BranchNotFoundError('HEAD');
      if (branch === base) throw new NothingToMergeError(branch, base);
      // Both names come out of a repository the sandbox can write and go straight into
      // argv below. A session can create a ref named `-x`, which git reads as an option
      // rather than a ref. Reject the shape once here instead of relying on every call
      // site to terminate option parsing.
      assertPlainRef(branch);
      assertPlainRef(base);
      // An attached HEAD can still name an unborn branch (`git checkout -b` before the
      // first commit), which has no ref to merge. Resolved through the SESSION worktree,
      // not `opts.repoDir`: a dev checkout can configure both a global repo root and a
      // project clone root, and this branch only exists in the project's repository.
      if (!(await branchExistsInWorktree(worktreePath, branch, run))) {
        throw new BranchNotFoundError(branch);
      }
      // Uncommitted work on either side would be swept up by the merge or destroyed by
      // the post-merge reset. Refuse before touching anything.
      if (await hasTrackedChanges(worktreePath, run)) throw new DirtyWorktreeError(worktreePath);
      if (await hasTrackedChanges(basePath, run)) {
        throw new BaseCheckoutUnavailableError(basePath, 'it has uncommitted changes');
      }
      const alreadyMerged = await run(['-C', basePath, 'merge-base', '--is-ancestor', branch, base])
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof SandboxUnavailableError) throw error;
          return false;
        });
      if (alreadyMerged) throw new NothingToMergeError(branch, base);
      // The exact commit this merge absorbs. Handed back so the deferred cleanup can
      // tell whether the session has committed more work on the branch since, in which
      // case deleting it would strand those commits (see `resetToLocalBase`).
      const mergedTip = (await run(['-C', basePath, 'rev-parse', `refs/heads/${branch}`])).trim();
      try {
        // `--no-ff` keeps the session's work visible as one merge point, so a local
        // project's history reads like the pull-request one. The identity is pinned the
        // same way the initial `git init` commit pins it (see the provisioner): this is
        // Verity's commit, not the session's, so it does not borrow whichever identity
        // the container happens to have configured, and an unset `user.email` would
        // abort the merge commit outright. Signing is pinned off deliberately: the
        // sandbox's `commit.gpgsign=true` would route this through the signing broker,
        // making an operator-initiated merge fail on a broker hiccup, and a local
        // project has no remote to verify a signature against. (The rule that agent
        // commits are broker-signed is unaffected: those are the commits being merged,
        // and they keep their signatures.)
        await run([
          '-C',
          basePath,
          ...untrustedRepo(basePath),
          '-c',
          'user.name=Verity',
          '-c',
          'user.email=verity@localhost',
          '-c',
          'commit.gpgsign=false',
          'merge',
          '--no-ff',
          '--no-edit',
          '--', // belt and braces with assertPlainRef: nothing after this is an option
          branch,
        ]);
      } catch (error) {
        // The daemon says the container is not there. That is not the same as "the merge
        // never started": the sandbox can also go away with the merge half-applied — a
        // conflict written into the index, the project stopped a moment later — and the
        // daemon answers the same way in both cases. Only the base clone can tell them
        // apart, and with the sandbox gone the file git writes is the one way left to
        // ask. A merge left in progress is stranded: it cannot be rolled back from here
        // and must not be reported as "start the project and merge again".
        if (error instanceof SandboxUnavailableError) {
          if (mergeInProgress(basePath)) throw new BaseCheckoutStrandedError(branch, base, error);
          throw error;
        }
        // Everything below reads the state the failed merge left behind. A probe that
        // fails because the sandbox went away answers nothing, and the answer it would
        // otherwise stand in for ("no conflict", "no merge in progress") is exactly the
        // one that skips the rollback: from here on, sandbox loss means the base may be
        // sitting mid-merge with no way left to restore it.
        const probe = async (args: string[]): Promise<boolean> =>
          run(args)
            .then((out) => out.trim().length > 0)
            .catch((probeError: unknown) => {
              if (probeError instanceof SandboxUnavailableError) {
                throw new BaseCheckoutStrandedError(branch, base, probeError);
              }
              return false;
            });
        // A conflict is not the only way `git merge` exits non-zero — a hook, a full
        // disk, or a corrupt repository do too. Only a conflict is something the
        // operator can resolve in the session and retry, so classify before reporting:
        // conflicted paths in the index are what distinguishes one.
        const conflicted = await probe(['-C', basePath, 'ls-files', '--unmerged']);
        // Roll the base checkout back to its pre-merge state, but only when a merge is
        // actually in progress — `merge --abort` exits non-zero with nothing to abort,
        // which would otherwise mask the real failure.
        const midMerge = await probe([
          '-C',
          basePath,
          'rev-parse',
          '--verify',
          '--quiet',
          'MERGE_HEAD',
        ]);
        if (midMerge) {
          try {
            // Pinned like the merge itself: aborting rewinds the working tree and index,
            // and must behave the same way the merge did.
            await run(['-C', basePath, ...untrustedRepo(basePath), 'merge', '--abort']);
          } catch (abortError) {
            // The base checkout is stuck mid-merge and we could not restore it. Never
            // report that as a conflict to resolve and retry — it needs a human.
            throw new BaseCheckoutStrandedError(branch, base, abortError);
          }
        }
        if (conflicted) throw new MergeConflictError(branch, base);
        throw error; // unexpected git failure — the base is restored, surface it as one
      }
      // The commit this merge produced. Read while the per-base lock is still held, so
      // it is this merge's own tip and not one a sibling session added after it — the
      // deferred cleanup detaches the worktree onto exactly this commit.
      const baseTip = (await run(['-C', basePath, 'rev-parse', `refs/heads/${base}`])).trim();
      // Nothing else runs here: the worktree reset is a separate step so the caller can
      // hold it until the session is idle, and so a failure in it can never be confused
      // with a failed merge.
      return { base, branch, mergedTip, baseTip };
    });
  }

  async function resetToLocalBase(
    worktreePath: string,
    base: string,
    { branch, mergedTip, baseTip }: { branch: string; mergedTip: string; baseTip: string },
    { git: run }: { git: GitOutput },
  ): Promise<{ base: string; deletedBranch?: string; retainedBranch?: string; skipped?: true }> {
    // Mirrors `resetToMergedBase` minus the fetch: a session worktree shares the object
    // store and refs of the clone the merge just landed in, so the merge commit is
    // already here. Detach rather than check the branch out — the clone claims it.
    //
    // The caller defers this until the session is idle, but "idle" is only true at the
    // instant it is read: a turn can start while this runs. Neither step below may rely
    // on that, so both are made safe by git itself rather than by a pre-check —
    // `checkout` without `-f`, which refuses to overwrite modified files, and a
    // compare-and-delete of the branch ref, which refuses once the branch has moved.
    // The checks up front only give the common case a clean "nothing was touched"
    // answer instead of a half-done one.
    //
    // Both names reach argv below and are read out of a repository the sandbox can
    // write. Re-checked rather than trusted from the merge, but reported as "nothing
    // was touched" instead of thrown — the merge has already landed, and every other
    // refusal in this cleanup takes that shape.
    if (!isValidBranchName(base)) return { base, skipped: true };
    // The commit reaches argv as a ref, read out of that same repository. A full object
    // name is the only shape accepted: anything else is not something to hand `checkout`
    // (a name could be read as an option, a partial one could resolve elsewhere).
    if (!/^[0-9a-f]{40,64}$/.test(baseTip)) return { base, skipped: true };
    // `attachedBranch`, not `current`, for the same reason the merge uses it: on a
    // detached HEAD `current` names whatever branch points at the commit, and this
    // decides which branch gets DELETED. Detached means there is nothing to delete —
    // the worktree still detaches onto the base below.
    const feature = await attachedBranch(worktreePath, run);
    if (feature !== undefined && !isValidBranchName(feature)) return { base, skipped: true };
    // It has to be the branch this merge absorbed, not merely a branch whose tip matches:
    // a session can create or check out a second branch at the same commit, and the tip
    // comparison below would then read that one as "fully merged" and delete it. Whatever
    // the worktree moved to is something this merge never touched, so nothing is done to
    // it — not even the detach.
    if (feature !== undefined && feature !== base && feature !== branch) {
      return { base, skipped: true };
    }
    const isLocalBranch =
      feature !== undefined &&
      feature !== base &&
      (await branchExistsInWorktree(worktreePath, feature, run));
    if (isLocalBranch) {
      const tip = (await run(['-C', worktreePath, 'rev-parse', `refs/heads/${feature}`])).trim();
      // The branch carries commits the merge did not absorb — leave everything alone
      // and let the operator merge again to bring them across.
      if (tip !== mergedTip) return { base, skipped: true };
    }
    if (await hasTrackedChanges(worktreePath, run)) return { base, skipped: true };
    try {
      // The merge commit itself, not `refs/heads/<base>`: a sibling session merging into
      // the same base between the two calls would otherwise move the worktree onto ITS
      // merge, while the operator is told they are sitting on their own.
      await run([
        '-C',
        worktreePath,
        ...untrustedRepo(worktreePath),
        'checkout',
        '--detach',
        baseTip,
      ]);
    } catch (error) {
      // `skipped` is reported to the operator as "your worktree kept the branch because
      // it has moved on since", so it may only stand for the race this cleanup is built
      // around: uncommitted work appeared after the check above and git refused to
      // overwrite it. That refusal is the guarantee — nothing was lost, nothing was
      // changed. Anything else (a sandbox that went away, a broken repository) is not
      // that story and is surfaced, leaving the caller to say the cleanup did not
      // complete rather than to explain it away.
      if (error instanceof SandboxUnavailableError) throw error;
      if (!(await hasTrackedChanges(worktreePath, run))) throw error;
      return { base, skipped: true };
    }
    if (isLocalBranch) {
      // Compare-and-delete: `update-ref -d <ref> <oldvalue>` deletes only while the ref
      // still points at the merged commit, where `branch -D` would drop it regardless.
      // A commit that landed since therefore keeps its branch — the worktree is
      // detached on the base either way, so no commit becomes unreachable.
      const deleted = await run([
        '-C',
        worktreePath,
        ...untrustedRepo(worktreePath),
        'update-ref',
        '-d',
        `refs/heads/${feature}`,
        mergedTip,
      ])
        .then(() => true)
        .catch(async (error: unknown) => {
          // `false` here means "the branch moved on, so it was kept" — a fact about the
          // ref, which `update-ref` failing does not by itself establish: a lock it could
          // not take, a full disk or a corrupt repository fail the same way, and reading
          // those as the race would report a finished cleanup over a broken one. The ref
          // is what decides. A sandbox that could not run either command has established
          // nothing at all.
          if (error instanceof SandboxUnavailableError) throw error;
          const tip = await run(['-C', worktreePath, 'rev-parse', `refs/heads/${feature}`])
            .then((out) => out.trim())
            .catch((readError: unknown) => {
              if (readError instanceof SandboxUnavailableError) throw readError;
              return undefined;
            });
          if (tip === undefined || tip === mergedTip) throw error;
          return false;
        });
      // Reported separately from a clean delete: the worktree IS detached, so this half
      // landed, but the branch is still there with commits the merge did not absorb.
      // Collapsing it into the success shape would tell the operator the cleanup was
      // complete and hide the work left behind.
      return deleted ? { base, deletedBranch: feature } : { base, retainedBranch: feature };
    }
    return { base };
  }

  return {
    current,
    sessionBranches,
    isDirty,
    switchable,
    previewable,
    switch: doSwitch,
    autoRename,
    resetToMergedBase,
    mergeIntoLocalBase,
    resetToLocalBase,
  };
}
