import { execFile, execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Provisions a real git worktree per spawned agent (concept §8). A spawned agent
 * runs `claude` in this worktree — a fresh checkout of the project repo on its
 * own branch — so it can edit, commit, push, and open a PR in isolation, without
 * touching the operator's main checkout or other agents' work.
 *
 * Replaces the throwaway empty scratch dir of the A1 spawn slice.
 */
export interface WorktreeProvisioner {
  /** Create a worktree on a NEW branch off the base; resolves its absolute path. */
  add(branch: string): Promise<string>;
  /** Remove a worktree (best-effort cleanup of a failed/finished start). */
  remove(worktreePath: string): Promise<void>;
}

/** Runs a `git` invocation. Injected so tests can assert args without a real
 * repo; defaults to `execFile('git', …)`. Rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[]) => Promise<void>;

const defaultGitRunner: GitRunner = async (args) => {
  await execFileAsync('git', [...args]);
};

export interface GitWorktreeOptions {
  /** The source repository to branch from (e.g. /work — the Verity repo). */
  repoDir: string;
  /** Directory the worktrees are created under (e.g. /work/.verity-sessions). */
  worktreeRoot: string;
  /** Ref the new worktree branches off. Default `HEAD` (the repo's checked-out default). */
  baseBranch?: string;
  /**
   * Before branching, `git fetch origin <baseBranch>` and branch off the
   * just-fetched tip (`FETCH_HEAD`) instead of the possibly-stale local ref —
   * so every new session starts from the latest integration branch (e.g. an
   * up-to-date `main`) rather than whatever the clone last synced. A repo with
   * no `origin` remote (a scratch/offline clone) falls back to the local
   * `baseBranch`; but when `origin` DOES exist and the fetch fails (network,
   * VPN, auth), the spawn hard-fails instead of silently branching off a
   * possibly-stale local ref. Off by default (tests / scratch); production
   * spawns turn it on. */
  refreshBase?: boolean;
  /**
   * Resolves the git `http.extraheader` value (e.g. `Authorization: Basic
   * <base64(x-access-token:<token>)>`) used to authenticate the `refreshBase`
   * fetch against `origin`. Called FRESH per fetch so a rotated short-TTL token
   * is always current. Returns `undefined`/empty → the fetch runs tokenless
   * (the server's own `/work` repo, which authenticates via the container's git
   * credential helper). A project session clone whose private repo is outside
   * the container's global token scope needs this so the fetch authenticates
   * with the project-scoped token rather than falling through to the narrow
   * global credential (which yields `remote: Repository not found`). The
   * resolved header NEVER appears in a thrown error — {@link redactAuthHeader}
   * strips it from any git error before it reaches `provision_error`/the client. */
  fetchAuthHeader?: (() => Promise<string | undefined>) | undefined;
  /** Injected git runner (tests); defaults to the real `git`. */
  git?: GitRunner;
}

/**
 * Strip a git `http.extraheader` credential out of a message before it can be
 * surfaced (thrown error → `provision_error` → mobile app). Mirrors
 * `provisioner.ts`'s `redactSensitive`: removes the exact `header` value AND the
 * generic `Authorization: (Basic|Bearer) …` shapes, so even a git error echoing
 * the full `http.extraheader=Authorization: Basic <base64>` never carries the
 * token onward.
 */
export function redactAuthHeader(message: string, header: string | undefined): string {
  let redacted = message;
  if (header !== undefined && header.length > 0) {
    redacted = redacted.split(header).join('[redacted]');
  }
  redacted = redacted.replace(
    /Authorization: Basic [A-Za-z0-9+/=._-]+/g,
    'Authorization: Basic [redacted]',
  );
  redacted = redacted.replace(
    /Authorization: Bearer [A-Za-z0-9._-]+/g,
    'Authorization: Bearer [redacted]',
  );
  return redacted;
}

// A worktree directory name derived from the branch: a single path segment, so
// `agent/foo` → `agent-foo` (no nested dirs, no `.`/`..` traversal). Drops `.`
// too so a branch can never sanitize to `.`/`..`/empty (which would resolve to
// the root or its parent under `join`).
function dirNameFor(branch: string): string {
  const name = branch.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (name.length === 0)
    throw new Error(`branch "${branch}" has no usable worktree directory name`);
  return name;
}

function slashPath(path: string): string {
  return path.split('\\').join('/');
}

/**
 * Point the worktree's own `.git` file at its admin dir by a RELATIVE path, so
 * the checkout stays valid when a project clone is bind-mounted into a session
 * container at a different absolute prefix (#207): git, run inside the worktree,
 * resolves the `gitdir:` link relative to the worktree dir.
 *
 * The reverse link — `.git/worktrees/<name>/gitdir`, pointing back at the
 * worktree — is deliberately LEFT ABSOLUTE (as `git worktree add` wrote it). It
 * is only ever read host-side from `repoDir` (the real `/work`), and git (at
 * least through 2.39) does NOT resolve a relative value there the way it resolves
 * the worktree-side link: it treats the worktree as living at that literal
 * relative path, finds nothing, and marks the worktree `prunable`. The next
 * `git worktree add` (each session spawn runs an implicit prune), `git worktree
 * prune`, or `gc` then silently deregisters a still-live session worktree — its
 * directory is orphaned from git, so `git rev-parse HEAD` fails and the session's
 * PR/Issue chip disappears while commits/pushes from it break. Keeping this side
 * absolute is what avoids that; only the worktree-side link needs to be relative
 * for bind-mount portability.
 */
function relativizeWorktreeGitdir(
  repoDir: string,
  worktreePath: string,
  worktreeName: string,
): void {
  const worktreeGitFile = join(worktreePath, '.git');
  const adminDir = join(repoDir, '.git', 'worktrees', worktreeName);
  if (!existsSync(worktreeGitFile) || !existsSync(adminDir)) return;

  const relativeAdminDir = slashPath(relative(dirname(worktreeGitFile), adminDir));
  writeFileSync(worktreeGitFile, `gitdir: ${relativeAdminDir}\n`);
}

/**
 * Index every session checkout under `worktreeRoots` by the admin dir its own
 * `.git` link resolves to, so {@link repairAdminGitdirs} can invert that link.
 * The forward link is the trustworthy side: it is relative (see
 * {@link relativizeWorktreeGitdir}), so it resolves correctly under any mount
 * prefix. A missing root, an entry without a readable `.git` file, and a `.git`
 * that is a real directory (a nested clone, not a worktree) are skipped.
 *
 * One repo's checkouts live under SEVERAL roots — project sessions under
 * `<repo>/.verity-sessions`, spawned sessions under their own session dir — and
 * a spawn into one root must still be able to heal a live session in another.
 * Earlier roots win, so the caller's own root takes precedence on a collision.
 */
function adminDirToWorktreeGitFile(worktreeRoots: readonly string[]): Map<string, string> {
  const byAdminDir = new Map<string, string>();
  for (const worktreeRoot of worktreeRoots) {
    let entries: string[];
    try {
      entries = readdirSync(worktreeRoot);
    } catch {
      continue; // no session root — nothing to invert
    }
    for (const entry of entries) {
      const gitFile = join(worktreeRoot, entry, '.git');
      let link: string;
      try {
        link = readFileSync(gitFile, 'utf8').trim();
      } catch {
        continue; // absent, unreadable, or a directory — not a worktree link
      }
      if (!link.startsWith('gitdir:')) continue;
      const target = link.slice('gitdir:'.length).trim();
      if (target.length === 0) continue;
      const adminDir = resolve(dirname(gitFile), target);
      if (!byAdminDir.has(adminDir)) byAdminDir.set(adminDir, gitFile);
    }
  }
  return byAdminDir;
}

/** Verity-owned copy of the admin facts, stored INSIDE the checkout. */
const WORKTREE_SIDECAR = '.verity-worktree.json';

/** A commit id, as git writes it into a detached `HEAD` — SHA-1 or SHA-256. */
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

interface WorktreeSidecar {
  /** Directory name under `.git/worktrees` this checkout is registered as. */
  adminName: string;
  /**
   * Where the checkout's `HEAD` pointed: a branch as a full ref (`refs/heads/…`)
   * or, when it is detached, the commit id itself. Verity detaches a worktree as
   * part of post-merge housekeeping, so a checkout with no branch is a normal
   * end state here, not a corrupt one.
   */
  headRef: string;
  /**
   * The commit `headRef` resolved to when this was recorded. What a rebuild aims
   * at once the branch itself is gone — which the same housekeeping does, one
   * step after the detach.
   */
  headSha?: string;
}

/**
 * Record what it takes to re-register this checkout, in a file `git worktree
 * prune` cannot reach.
 *
 * {@link repairAdminGitdirs} heals a link that ROTTED. It cannot help once the
 * admin entry is DELETED, and deletion is the likelier accident here: host and
 * container see this repo under different absolute prefixes, so a `git worktree
 * prune` run from either side considers every entry belonging to the other side
 * dead and removes it — one agent can deregister every live session at once.
 * The sidecar lives in the checkout, which no prune touches, so the entry can be
 * rebuilt exactly instead of guessed at from branch names.
 */
function writeWorktreeSidecar(worktreePath: string, sidecar: WorktreeSidecar): void {
  const file = join(worktreePath, WORKTREE_SIDECAR);
  // Written beside it and renamed over it: this file is the only copy of what a
  // rebuild needs, and a process killed mid-write would otherwise leave half a
  // JSON object — unreadable, and unrecoverable once the entry is pruned.
  const staging = `${file}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(sidecar)}\n`);
    renameSync(staging, file);
  } catch {
    // Best-effort: a checkout without a sidecar is only *less* recoverable, and
    // failing the spawn over it would be the worse trade.
    rmSync(staging, { force: true });
  }
}

/**
 * One directory name under `.git/worktrees`, never a way out of it.
 *
 * Both sources of this name — the checkout's own `.git` link and the sidecar
 * beside it — are writable from inside a session, and the rebuild creates,
 * writes into, and (when it backs out) recursively removes the directory it
 * names. `.` or `..` would aim all of that at `.git/worktrees` or `.git`
 * itself, taking every other session's entry with it.
 */
function isAdminName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/u.test(name);
}

function readWorktreeSidecar(worktreePath: string): WorktreeSidecar | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(worktreePath, WORKTREE_SIDECAR), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { adminName, headRef, headSha } = parsed as Partial<WorktreeSidecar>;
  if (typeof adminName !== 'string' || !isAdminName(adminName)) return undefined;
  // A detached record read by an older Server (a self-update rollback) fails
  // this test and the rebuild is refused — which is the safe direction: a
  // checkout left visibly unregistered, not one silently moved onto a branch it
  // had already left.
  if (
    typeof headRef !== 'string' ||
    !(headRef.startsWith('refs/heads/') || COMMIT_ID.test(headRef))
  )
    return undefined;
  if (headSha !== undefined && (typeof headSha !== 'string' || !COMMIT_ID.test(headSha)))
    return undefined;
  return { adminName, headRef, ...(headSha === undefined ? {} : { headSha }) };
}

/**
 * Back up the admin facts of every healthy checkout, and rebuild the entry of
 * every checkout whose admin dir was pruned out from under it.
 *
 * Backfill first, so a checkout that predates the sidecar gains one while its
 * admin dir is still intact — that is what makes the NEXT prune survivable.
 * Reconstruction writes the four files git needs to consider the entry live and
 * to read the checkout truthfully: `gitdir`, `commondir`, `HEAD`, and an index
 * restored from that HEAD — unless an index outlived it (see
 * {@link restoreWorktreeIndex}).
 *
 * @returns the admin names it rebuilt, for the caller to log.
 */
export function reregisterPrunedWorktrees(
  repoDir: string,
  worktreeRoots: string | readonly string[] = join(repoDir, '.verity-sessions'),
): readonly string[] {
  const roots = typeof worktreeRoots === 'string' ? [worktreeRoots] : worktreeRoots;
  const rebuilt: string[] = [];
  for (const root of roots) {
    for (const entry of safeReaddir(root)) {
      if (!entry.isDirectory()) continue;
      try {
        if (rebuildWorktreeAdminDir(repoDir, join(root, entry.name))) rebuilt.push(entry.name);
      } catch {
        // ignore — one unrecoverable checkout must not stop the rest
      }
    }
  }
  return rebuilt;
}

/** @returns true when a missing admin entry was rebuilt from the sidecar. */
function rebuildWorktreeAdminDir(repoDir: string, worktreePath: string): boolean {
  const gitFile = join(worktreePath, '.git');
  if (!existsSync(gitFile) || lstatSync(gitFile).isDirectory()) return false;
  const adminName = adminNameFor(worktreePath, gitFile);
  if (adminName === undefined) return false;
  const worktreesDir = join(repoDir, '.git', 'worktrees');
  const adminDir = join(worktreesDir, adminName);
  // Belt and braces around {@link isAdminName}: whatever the name looked like,
  // what gets written and possibly removed has to be one level down from here.
  if (dirname(resolve(adminDir)) !== resolve(worktreesDir)) return false;
  const headFile = join(adminDir, 'HEAD');

  if (existsSync(headFile)) {
    // Healthy: keep the sidecar current so a later prune stays recoverable.
    refreshWorktreeSidecar(repoDir, worktreePath, adminName, headFile);
    return false;
  }

  const sidecar = readWorktreeSidecar(worktreePath);
  // Never invent an entry: without the recorded facts the branch is unknowable
  // from here, and a wrong HEAD would silently move the checkout's work.
  if (sidecar === undefined || sidecar.adminName !== adminName) return false;
  const head = rebuiltHead(repoDir, sidecar);
  if (head === undefined) return false;

  // A prune takes the whole admin dir, but a half-deleted one is possible too —
  // and there an index may have outlived HEAD. Staged work is the one thing
  // `read-tree HEAD` cannot reproduce, so a surviving index is kept as it is and
  // only the missing baseline gets supplied.
  const keepIndex = existsSync(join(adminDir, 'index'));
  // Undo is per file, so backing out of a half-deleted entry cannot take the
  // parts of it that were still there. (The three files below are derived from
  // the checkout, not recovered state, so rewriting them costs nothing.)
  const written: string[] = [];
  const put = (file: string, content: string): void => {
    if (!existsSync(file)) written.push(file);
    writeFileSync(file, content);
  };
  const dirIsOurs = !existsSync(adminDir);

  mkdirSync(adminDir, { recursive: true });
  put(join(adminDir, 'gitdir'), `${gitFile}\n`);
  put(join(adminDir, 'commondir'), '../..\n');
  put(headFile, `${head}\n`);
  relativizeWorktreeGitdir(repoDir, worktreePath, adminName);
  if (!keepIndex && !restoreWorktreeIndex(worktreePath)) {
    // Back out rather than hand back a live entry with an empty index — the
    // very state this rebuild exists to avoid. A checkout left unregistered is
    // loud (the session reports its workspace as gone) and loses nothing: every
    // file is still on disk, and the next sweep tries again.
    if (dirIsOurs) rmSync(adminDir, { recursive: true, force: true });
    else for (const file of [...written, join(adminDir, 'index')]) rmSync(file, { force: true });
    return false;
  }
  return true;
}

/**
 * Record where a healthy checkout stands, so a later rebuild can put it back
 * there.
 *
 * Both halves of `HEAD` are kept, because neither survives on its own: the
 * branch is what the session goes on committing to, and the commit id is all
 * that is left to aim at once that branch is gone. Verity's own post-merge
 * housekeeping produces exactly that state — it detaches the worktree onto the
 * branch the PR merged into and then deletes the feature branch — so a record
 * that could hold nothing but a branch name was frozen on a deleted ref from
 * the merge onwards, and stayed that way for the rest of the session.
 *
 * The commit has to be re-resolved on every sweep, not only when the branch
 * NAME changes: a session commits under the same ref all day, and a record kept
 * on first sight would aim a rebuild at whatever the branch stood on when the
 * session started.
 */
function refreshWorktreeSidecar(
  repoDir: string,
  worktreePath: string,
  adminName: string,
  headFile: string,
): void {
  let head: string;
  try {
    head = readFileSync(headFile, 'utf8')
      .trim()
      .replace(/^ref:\s*/u, '');
  } catch {
    return; // unreadable HEAD — leave the last good record in place
  }
  if (!head.startsWith('refs/heads/') && !COMMIT_ID.test(head)) return;
  const recorded = readWorktreeSidecar(worktreePath);
  // A commit that could not be resolved this time is not a commit that moved:
  // the ref store may just have been mid-update. Downgrading a good record to
  // no commit at all would take the fallback away exactly when the branch is
  // next deleted, so the last known one stays until a newer one replaces it.
  const headSha =
    (COMMIT_ID.test(head) ? head : resolveRefSha(repoDir, head)) ??
    (recorded?.headRef === head ? recorded.headSha : undefined);
  const sidecar: WorktreeSidecar = {
    adminName,
    headRef: head,
    ...(headSha === undefined ? {} : { headSha }),
  };
  // Nothing moved: skip the write rather than rewrite the same bytes under every
  // checkout in the repo on every spawn.
  if (
    recorded !== undefined &&
    recorded.adminName === sidecar.adminName &&
    recorded.headRef === sidecar.headRef &&
    recorded.headSha === sidecar.headSha
  )
    return;
  writeWorktreeSidecar(worktreePath, sidecar);
}

/**
 * A branch ref this code is willing to touch the ref store with. Git itself
 * forbids `..` in a ref name, so a record carrying one was hand-written into a
 * checkout — and it is not going to be followed back out of `.git`.
 */
function isBranchRef(ref: string): boolean {
  return ref.startsWith('refs/heads/') && !ref.includes('..');
}

/**
 * The commit a branch points at, read from the repository's own ref storage —
 * the loose file first, then the packed table, and git itself only if neither
 * knows the ref.
 *
 * File reads rather than `git rev-parse`, because this runs for every checkout
 * on every sweep and a subprocess apiece would tax each spawn in proportion to
 * how many sessions the repo has accumulated. The subprocess is kept as the
 * last resort so a repo on a ref backend these two reads cannot see still
 * resolves, at the cost of one call for a ref that is usually simply gone.
 */
function resolveRefSha(repoDir: string, ref: string): string | undefined {
  if (!isBranchRef(ref)) return undefined;
  try {
    const loose = readFileSync(join(repoDir, '.git', ref), 'utf8').trim();
    if (COMMIT_ID.test(loose)) return loose;
  } catch {
    // not a loose ref — the packed table below is the other place it can live
  }
  let packed = '';
  try {
    packed = readFileSync(join(repoDir, '.git', 'packed-refs'), 'utf8');
  } catch {
    // no packed table either — ask git itself below
  }
  for (const line of packed.split('\n')) {
    // `^<sha>` lines annotate the preceding tag with its target; no branch there.
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, name] = line.trim().split(/\s+/u);
    if (name === ref && sha !== undefined && COMMIT_ID.test(sha)) return sha;
  }
  // Neither place holds it. Either the branch is genuinely gone, or the repo
  // keeps its refs somewhere this reader does not know about — `reftable`, say.
  // Only then is a subprocess worth it; on the normal path above it never runs.
  try {
    const shown = execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
    return COMMIT_ID.test(shown) ? shown : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a rebuilt `HEAD` gets to hold.
 *
 * The recorded branch comes first — it is the ref the session commits to — but
 * only while it still exists. Pointing `ref:` at a deleted branch makes the
 * rebuilt checkout an UNBORN one: git reports no commits at all, the whole tree
 * reads as untracked, and a commit from the session would start that branch
 * over from nothing instead of continuing it. The recorded commit is the honest
 * fallback, and detached is where the post-merge cleanup leaves a worktree
 * anyway. With neither we refuse, as before.
 */
function rebuiltHead(repoDir: string, sidecar: WorktreeSidecar): string | undefined {
  if (COMMIT_ID.test(sidecar.headRef)) return sidecar.headRef;
  if (!isBranchRef(sidecar.headRef)) return sidecar.headSha;
  // Existence, not resolvability: a branch stored in a form this reader cannot
  // follow is still a branch the session is on, and keeping it is the smaller
  // claim than detaching the checkout out from under it.
  const stillThere =
    existsSync(join(repoDir, '.git', sidecar.headRef)) ||
    resolveRefSha(repoDir, sidecar.headRef) !== undefined;
  return stillThere ? `ref: ${sidecar.headRef}` : sidecar.headSha;
}

/**
 * Give the rebuilt entry its index back.
 *
 * A missing index is not a blank slate git refills on demand — it IS an empty
 * index, so every tracked file reads as staged for deletion: `git status` shows
 * the entire repository as `D`, and `git commit -a` would record precisely that
 * tree. `read-tree` restores the baseline from HEAD without touching a single
 * file, so what shows up afterwards is what the session actually changed.
 *
 * Work that was staged but not committed died with the index and cannot come
 * back; it reappears as unstaged, which is the truthful reading of the files on
 * disk.
 *
 * @returns false when git refused, which fails the whole rebuild: an entry is
 * only worth registering if it can be read truthfully.
 */
function restoreWorktreeIndex(worktreePath: string): boolean {
  try {
    // Synchronous because the sweep is: both the startup repair and the
    // pre-spawn heal have to finish before a worktree is handed out.
    execFileSync('git', ['-C', worktreePath, 'read-tree', 'HEAD'], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The admin dir this checkout claims, read from its own `.git` link. Falls back
 *  to the sidecar when the link was rewritten to an unusable prefix. */
function adminNameFor(worktreePath: string, gitFile: string): string | undefined {
  let link: string;
  try {
    link = readFileSync(gitFile, 'utf8').trim();
  } catch {
    return undefined;
  }
  const target = link.startsWith('gitdir:') ? link.slice('gitdir:'.length).trim() : '';
  const name = slashPath(target).split('/').filter(Boolean).pop();
  return name !== undefined && isAdminName(name)
    ? name
    : readWorktreeSidecar(worktreePath)?.adminName;
}

/**
 * Heal worktree admin links that git cannot follow, so a `git worktree
 * prune`/`gc` can no longer silently deregister a still-live session (its
 * checkout is then orphaned from git: `git rev-parse HEAD` fails, the session's
 * PR/Issue chip disappears, commits and pushes from it break). Two shapes rot:
 *
 * - RELATIVE, as an earlier version of {@link relativizeWorktreeGitdir} wrote
 *   it. Git (through at least 2.39) does not resolve this side relative to the
 *   admin dir — it takes the literal path, finds nothing, and marks the worktree
 *   `prunable`. The value was written relative to its own admin dir, so we
 *   resolve it there.
 * - ABSOLUTE but pointing at a path that does not exist from here — a
 *   CONTAINER-side prefix (`/work/.verity-sessions/<id>/.git`) written by a
 *   worktree created inside a session container, while this side is only ever
 *   read host-side from `repoDir`. `isAbsolute` alone let these through, so they
 *   stayed prunable and a gc swept 30 session worktrees in one pass. We recover
 *   the real location by inverting the worktree's own (relative, mount-portable)
 *   forward link rather than guessing: the admin dir name is a mangled form of
 *   the directory name (a leading `.` becomes `-`), so it is not a safe source.
 *
 * An entry whose absolute path exists, an empty/missing/unreadable `gitdir`, a
 * stale entry no checkout claims, and a repo with no worktrees are all no-ops —
 * we never invent a path. Best-effort per entry so one bad link never blocks the
 * rest. Called at startup ({@link module:embedded} — for every project clone
 * when the multi-project runner leaves `repoDir` empty, see
 * {@link repairProjectAdminGitdirs}) AND on every spawn (see
 * {@link createGitWorktreeProvisioner}). Startup alone is not enough: links rot
 * while the server is up and stay `prunable` until a prune/gc sweeps the live
 * session they belong to.
 */
export function repairAdminGitdirs(
  repoDir: string,
  worktreeRoots: string | readonly string[] = join(repoDir, '.verity-sessions'),
): void {
  const worktreesDir = join(repoDir, '.git', 'worktrees');
  if (!existsSync(worktreesDir)) return;
  const roots = typeof worktreeRoots === 'string' ? [worktreeRoots] : worktreeRoots;
  let claimedBy: Map<string, string> | undefined;
  for (const name of readdirSync(worktreesDir)) {
    const adminDir = join(worktreesDir, name);
    const gitdirFile = join(adminDir, 'gitdir');
    let content: string;
    try {
      content = readFileSync(gitdirFile, 'utf8').trim();
    } catch {
      continue; // no gitdir file (or unreadable) — nothing to heal
    }
    if (content.length === 0) continue;
    if (isAbsolute(content) && existsSync(content)) continue; // git can follow it
    // Built on first miss only: a healthy repo never reads the session root.
    claimedBy ??= adminDirToWorktreeGitFile(roots);
    const healed = isAbsolute(content)
      ? claimedBy.get(resolve(adminDir))
      : resolve(adminDir, content);
    if (healed === undefined || healed === content) continue;
    writeFileSync(gitdirFile, `${healed}\n`);
  }
}

/**
 * Heal every project clone under `cloneRoot` ({@link repairAdminGitdirs} per
 * repo). The multi-project runner deliberately runs with an empty
 * `VERITY_REPO_DIR` and resolves git per project clone instead, so the
 * single-repo startup heal never fired for ANY project — the fix shipped, and
 * every project kept its landmines. A clone whose `.git` is a file (a worktree,
 * not a repo) or that has no `.git/worktrees` is skipped by the heal itself.
 * Best-effort per clone so one unreadable project never blocks the others.
 */
export function repairProjectAdminGitdirs(cloneRoot: string): void {
  for (const entry of safeReaddir(cloneRoot)) {
    if (!entry.isDirectory()) continue;
    try {
      repairAdminGitdirs(join(cloneRoot, entry.name));
    } catch {
      // ignore — one bad clone must not stop the rest from being healed
    }
  }
}

/**
 * Build a {@link WorktreeProvisioner} backed by `git worktree`. `add` runs
 * `git -C <repo> worktree add <path> -b <branch> <base>`; `remove` runs
 * `git -C <repo> worktree remove <path> --force`. The worktree path is always a
 * direct child of `worktreeRoot` (the branch is sanitized to one segment).
 *
 * With {@link GitWorktreeOptions.refreshBase}, `add` first `git fetch origin
 * <baseBranch>` and branches off the freshly-fetched `FETCH_HEAD`, so a new
 * session starts from the latest remote integration branch instead of a stale
 * local ref (falls back to the local `baseBranch` only when there's no `origin`
 * remote; a fetch failure against an existing `origin` hard-fails the spawn).
 */
/**
 * Resolve the ref a `refreshBase` spawn should branch off. When an `origin`
 * remote exists, its `<baseBranch>` MUST be fetched successfully — otherwise we
 * refuse to proceed rather than silently branch off a possibly-stale local ref
 * (the failure mode that left sessions dozens of commits behind `main` when a
 * fetch failed on a flaky/VPN'd host). Only a repo with no `origin` remote — a
 * scratch/offline clone — legitimately falls back to the local base. The fetch
 * gets one retry to ride out a transient network blip before we give up.
 */
async function refreshedBase(
  git: GitRunner,
  repoDir: string,
  baseBranch: string,
  fetchAuthHeader?: () => Promise<string | undefined>,
): Promise<string> {
  try {
    await git(['-C', repoDir, 'remote', 'get-url', 'origin']);
  } catch {
    // No `origin` remote — nothing to refresh from; branch off the local base.
    return baseBranch;
  }
  // Resolve the auth header FRESH per call so a rotated short-TTL project token
  // is always current. Empty/undefined → tokenless fetch (the server's own
  // `/work` repo path, which authenticates via the container credential helper).
  const header = fetchAuthHeader ? await fetchAuthHeader() : undefined;
  const fetchArgs =
    header !== undefined && header.length > 0
      ? ['-C', repoDir, '-c', `http.extraheader=${header}`, 'fetch', 'origin', baseBranch]
      : ['-C', repoDir, 'fetch', 'origin', baseBranch];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `git fetch origin <base>` points FETCH_HEAD at the fetched tip (works
      // for a named branch and for the literal `HEAD`); we branch off that.
      await git(fetchArgs);
      return 'FETCH_HEAD';
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    await git(['-C', repoDir, 'rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new RepositoryHasNoCommitsError();
  }
  // Redact the auth header from the surfaced cause so a git error echoing
  // `http.extraheader=Authorization: Basic <base64>` never leaks the token.
  throw new Error(
    `refreshBase: 'git fetch origin ${baseBranch}' failed after retry; refusing to branch ` +
      `off a possibly-stale local '${baseBranch}'. Cause: ${redactAuthHeader(String(lastErr), header)}`,
  );
}

/** Safe, user-facing failure for a managed checkout whose HEAD is still unborn. */
export class RepositoryHasNoCommitsError extends Error {
  constructor() {
    super('repository has no commits yet; initialize its default branch before starting a session');
    this.name = 'RepositoryHasNoCommitsError';
  }
}

/**
 * The branch a worktree has checked out, read from git's on-disk metadata (the
 * same admin files {@link relativizeWorktreeGitdir} authors): `<worktree>/.git`
 * points at the admin dir, whose `HEAD` holds `ref: refs/heads/<branch>`. Read
 * BEFORE `git worktree remove` deletes that admin dir. Best-effort: returns
 * `undefined` for a detached HEAD or any unreadable/unexpected layout, so a
 * failed read simply skips the follow-up branch deletion rather than throwing.
 */
function branchOfWorktree(worktreePath: string): string | undefined {
  try {
    const gitFile = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    const gitdir = gitFile.replace(/^gitdir:\s*/, '');
    const adminDir = resolve(worktreePath, gitdir);
    const head = readFileSync(join(adminDir, 'HEAD'), 'utf8').trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Give a freshly-added worktree its OWN first-party workspace symlinks, so an
 * `@verity/*` (or other workspace) import resolves to THIS worktree's `packages/*`
 * rather than leaking to the source repo's copy.
 *
 * The bug this fixes: a worktree has no `node_modules` of its own, so Node walks
 * up and resolves every workspace package through the source repo's hoisted
 * `<repoDir>/node_modules/@verity/* -> ../../packages/*` symlinks — i.e. to
 * `<repoDir>/packages/*`, whatever branch the source checkout happens to be on.
 * A session's cross-package typecheck/`require.resolve` then reads a DIFFERENT
 * worktree's sources, and switching the source checkout's branch silently shifts
 * every session's resolution. True isolation of the git working tree wasn't
 * matched by isolation of module resolution.
 *
 * The fix mirrors the source repo's workspace links into the worktree, verbatim.
 * Those links are already RELATIVE (`../../packages/foo`) and the worktree has the
 * same internal layout, so the identical target resolves within the worktree
 * (`<worktree>/packages/foo`) — and stays bind-mount portable (#207). Only
 * first-party workspace packages are linked; third-party deps keep resolving up
 * to the shared `<repoDir>/node_modules` (branch-independent, no install needed).
 *
 * Best-effort and self-scoping: a repo that is not an npm-workspace monorepo (no
 * `<repoDir>/node_modules/<name>` links to mirror) yields nothing to do, so this
 * is a no-op for arbitrary project checkouts. Never throws — a link that can't be
 * created is skipped rather than failing the spawn.
 */
export function linkWorkspacePackages(repoDir: string, worktreePath: string): void {
  // Guard: without a real worktree dir (e.g. a mocked git runner in tests) there
  // is nothing to link into.
  if (!existsSync(worktreePath)) return;
  const rootModules = join(repoDir, 'node_modules');
  if (!existsSync(rootModules)) return;
  for (const glob of ['packages', 'apps']) {
    const dir = join(repoDir, glob);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      let name: string;
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(dir, entry, 'package.json'), 'utf8'));
        const pkgName = (pkg as { name?: unknown }).name;
        if (typeof pkgName !== 'string' || pkgName.length === 0) continue;
        name = pkgName;
      } catch {
        continue; // not a package (no/invalid package.json)
      }
      // Only mirror packages the source repo actually links (hoisted workspace
      // symlink). A non-symlink or missing entry means this package isn't part of
      // the resolvable workspace tree — leave resolution as-is.
      let target: string;
      try {
        target = readlinkSync(join(rootModules, name));
      } catch {
        continue;
      }
      const dst = join(worktreePath, 'node_modules', name);
      try {
        mkdirSync(dirname(dst), { recursive: true }); // creates the scope dir (e.g. @verity)
        rmSync(dst, { force: true, recursive: true }); // replace any stale entry
        symlinkSync(target, dst); // same relative target → resolves inside the worktree
      } catch {
        // A single unlinkable package must not fail the spawn.
      }
    }
  }
}

/** Scan depth for nested `node_modules`. Deep enough for the usual layouts
 * (`platform/`, `apps/web/`), shallow enough to stay a cheap directory walk. */
const MAX_NESTED_MODULES_DEPTH = 3;

/**
 * Mirror the source repo's NESTED `node_modules` into a fresh worktree, so a
 * project whose app lives in a subdirectory can resolve its dependencies at all.
 *
 * `linkWorkspacePackages` (above) leaves third-party deps to Node walking UP from
 * the worktree to the shared `<repoDir>/node_modules`. That only holds when the
 * deps are hoisted to the repo ROOT, because `<repoDir>/node_modules` is then an
 * ancestor of the worktree (`<repoDir>/.verity-sessions/<name>`) and the walk
 * finds it.
 *
 * It silently fails for the common non-monorepo layout: a repo whose app sits in
 * a subdirectory with its own manifest (`platform/package.json` +
 * `platform/node_modules`) and no root manifest at all. From `<worktree>/platform`
 * the walk goes `<worktree>/platform` → `<worktree>` → `<repoDir>/.verity-sessions`
 * → `<repoDir>`, and never sees `<repoDir>/platform/node_modules` — a SIBLING, not
 * an ancestor. Every session then has to run its own install, and under the
 * sandbox's `ignore-scripts=true` hardening that install skips native builds: the
 * dep tree looks complete, but packages like `better-sqlite3` carry no compiled
 * binding and the app dies at boot.
 *
 * This keeps the existing sharing model and only extends its reach — each entry of
 * `<repoDir>/<sub>/node_modules` is mirrored into `<worktree>/<sub>/node_modules`.
 * Compiled bindings come along for free, since the source checkout already built
 * them.
 *
 * Deliberately PER-PACKAGE rather than one link for the whole directory: should a
 * session run its own install later, npm replaces individual entries inside the
 * worktree instead of writing through into the source checkout's tree.
 *
 * Package directories are copied with copy-on-write reflinks when supported, not symlinked. A symlink resolves to a
 * realpath in the SOURCE checkout, outside the worktree, and bundlers that
 * canonicalize before deciding what they may compile then refuse the dependency
 * outright — Turbopack (the Next 16 default) fails the build with "We couldn't
 * find the Next.js package (next/package.json) from the project directory", so a
 * session preview of a Next app dies at startup while the same code serves fine
 * from the main checkout. A real copied tree keeps every dependency path inside the
 * worktree. A hardlink is not an isolation boundary: an in-place write by an agent
 * mutates the source checkout and every sibling worktree. Reflinks retain the cheap
 * initial sharing while copy-on-write gives each worktree its own inode; ordinary
 * copies are the portable fallback.
 *
 * Symlinked entries are still reproduced with their RELATIVE targets (like the
 * workspace links above) so the result stays bind-mount portable (#207): the
 * server writes them as host paths, the agent reads them as `/work/...` inside
 * its container.
 *
 * Skips the repo ROOT `node_modules` — the up-walk already covers it and
 * `linkWorkspacePackages` owns the first-party links there — any subdirectory
 * where the worktree already carries its own `node_modules`, and any destination
 * that is not a real directory inside the worktree (see {@link containedDir}).
 * Best-effort and never throws: dependency resolution must not fail a spawn.
 */
export function mirrorNestedNodeModules(repoDir: string, worktreePath: string): void {
  // Guard: without a real worktree dir (e.g. a mocked git runner in tests) there
  // is nothing to mirror into.
  if (!existsSync(worktreePath)) return;
  for (const sub of nestedModuleDirs(repoDir)) {
    // Only mirror into a subdirectory this worktree actually checked out, as a
    // REAL directory — see containedDir() for why following a symlink here would
    // write outside the worktree.
    if (!containedDir(worktreePath, sub)) continue;
    const dst = join(worktreePath, sub, 'node_modules');
    // Anything already at the destination owns resolution — its own install, or a
    // link the branch put there. lstat, so a dangling symlink still counts.
    if (pathExists(dst)) continue;
    mirrorModuleEntries(join(repoDir, sub, 'node_modules'), dst);
  }
}

/**
 * True when `sub` names a real directory INSIDE `base`. Every segment is lstat'd,
 * so a symlink anywhere along the path is rejected rather than followed.
 *
 * The branch a worktree checks out decides what is on disk there, and it is free
 * to ship `platform` as a symlink to any path the server can write. Resolving the
 * destination with a plain `existsSync` would follow it and plant a `node_modules`
 * tree wherever it points — outside the worktree entirely.
 */
function containedDir(base: string, sub: string): boolean {
  let current = base;
  for (const segment of sub.split('/')) {
    current = join(current, segment);
    try {
      if (!lstatSync(current).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** `existsSync` that does NOT follow symlinks, so a dangling link reads as
 * present rather than absent. */
function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Repo-relative subdirectories (never the root) that carry their own
 * `node_modules`. Dot-directories are skipped, which is what keeps the scan out of
 * `.verity-sessions/` — other sessions' worktrees carry `node_modules` too, and
 * mirroring one session into the next is exactly the leak this whole file exists
 * to prevent. */
function nestedModuleDirs(repoDir: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_NESTED_MODULES_DEPTH) return;
    for (const entry of safeReaddir(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const child = join(dir, entry.name);
      if (existsSync(join(child, 'node_modules'))) {
        found.push(relative(repoDir, child).split(sep).join('/'));
      }
      visit(child, depth + 1);
    }
  };
  visit(repoDir, 1);
  return found;
}

/**
 * Recreate one `node_modules` level in the worktree. Real package directories
 * become isolated copied trees of the source copy (see {@link copyModuleTree}); entries
 * that are ALREADY symlinks (npm's `.bin` shims, hoisted workspace links) are
 * reproduced verbatim so their relative targets resolve inside the worktree;
 * `.bin` and `@scope` directories are recreated as real directories so their
 * members can be linked individually.
 *
 * Plain files at a package level — notably npm's `.package-lock.json` install
 * state — are left out on purpose: without it, a later `npm install` in the
 * worktree performs a full, self-contained install rather than trusting a tree it
 * does not own. Inside `.bin` the opposite applies (`linkFiles`): npm writes its
 * shims as symlinks, but pnpm and yarn write real shell scripts, and dropping
 * those would leave every dependency's CLI off the `npm run` PATH — the exact
 * `next: not found` failure this mirroring exists to prevent.
 */
function mirrorModuleEntries(srcDir: string, dstDir: string, linkFiles = false): void {
  for (const entry of safeReaddir(srcDir)) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(src);
        // An absolute target would not survive the bind mount into the sandbox.
        if (isAbsolute(target)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        symlinkSync(target, dst);
      } else if (entry.isDirectory() && (entry.name === '.bin' || entry.name.startsWith('@'))) {
        mirrorModuleEntries(src, dst, entry.name === '.bin');
      } else if (entry.isDirectory()) {
        mkdirSync(dirname(dst), { recursive: true });
        if (!copyModuleTree(src, dst)) {
          // Nothing partial may survive. Do not fall back to a package symlink:
          // that would restore the cross-worktree write primitive this isolation
          // boundary exists to remove.
          rmSync(dst, { force: true, recursive: true });
        }
      } else if (linkFiles && entry.isFile()) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst, constants.COPYFILE_FICLONE);
      }
    } catch {
      // A single unlinkable package must not fail the spawn.
    }
  }
}

/**
 * Reproduce one package directory under `dst` as real directories with isolated
 * file inodes. COPYFILE_FICLONE requests a copy-on-write reflink; filesystems that
 * do not support it transparently fall back to an ordinary copy.
 *
 * Returns false when the tree cannot be reproduced faithfully, leaving the caller
 * to omit that package rather than breach isolation. That covers a source we may
 * not read and, deliberately, an entry we cannot
 * reproduce exactly: an ABSOLUTE internal symlink (which would not survive the
 * bind mount) or anything that is not a file, directory, or symlink. Half a
 * package is worse than a symlinked one, so an incomplete tree is never kept.
 *
 * Directory modes are carried over, so a package the source checkout keeps
 * private does not become world-readable in the worktree.
 */
function copyModuleTree(src: string, dst: string, sourceRoot = resolve(src)): boolean {
  try {
    mkdirSync(dst, { recursive: true, mode: lstatSync(src).mode & 0o7777 });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(from);
        if (isAbsolute(target)) return false;
        const resolvedTarget = resolve(dirname(from), target);
        if (resolvedTarget !== sourceRoot && !resolvedTarget.startsWith(`${sourceRoot}${sep}`)) {
          return false;
        }
        symlinkSync(target, to);
      } else if (entry.isDirectory()) {
        if (!copyModuleTree(from, to, sourceRoot)) return false;
      } else if (entry.isFile()) {
        copyFileSync(from, to, constants.COPYFILE_FICLONE);
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function createGitWorktreeProvisioner(opts: GitWorktreeOptions): WorktreeProvisioner {
  const baseBranch = opts.baseBranch ?? 'HEAD';
  const git = opts.git ?? defaultGitRunner;
  return {
    add: async (branch) => {
      mkdirSync(opts.worktreeRoot, { recursive: true });
      // Heal the whole repo's admin links on every spawn, not just at startup: a
      // `gitdir` rots WHILE the server is up (a worktree created container-side
      // writes a `/work/...` path we cannot follow host-side), and it then sits
      // `prunable` until some `git worktree prune`/gc — ours or an agent's —
      // deregisters that still-live session. A spawn is the frequent, natural
      // moment to sweep the landmines back up. Heal across both roots this repo's
      // checkouts live under, so a spawn into a session dir also covers project
      // sessions. Best-effort: a heal failure must never block a spawn.
      const healRoots = [...new Set([opts.worktreeRoot, join(opts.repoDir, '.verity-sessions')])];
      try {
        repairAdminGitdirs(opts.repoDir, healRoots);
        // A rotted link is only half the failure mode: once a prune has run, the
        // entry is gone and there is no link left to repair. Rebuild those from
        // the sidecar, and back the sidecar up for every checkout that is still
        // healthy — the same sweep that makes the next prune survivable.
        reregisterPrunedWorktrees(opts.repoDir, healRoots);
      } catch {
        // ignore — the spawn itself is unaffected; only rotted links stay
      }
      const worktreeName = dirNameFor(branch);
      const worktreePath = join(opts.worktreeRoot, worktreeName);
      // Sync the base from origin so the spawn branches off the latest tip.
      let base = baseBranch;
      if (opts.refreshBase) {
        base = await refreshedBase(git, opts.repoDir, baseBranch, opts.fetchAuthHeader);
      }
      await git(['-C', opts.repoDir, 'worktree', 'add', worktreePath, '-b', branch, base]);
      relativizeWorktreeGitdir(opts.repoDir, worktreePath, worktreeName);
      // Give the worktree its own first-party workspace symlinks so cross-package
      // resolution stays isolated to this checkout instead of leaking to the
      // source repo's `packages/*` (whatever branch it's on).
      linkWorkspacePackages(opts.repoDir, worktreePath);
      // Repos that keep their app (and its deps) in a subdirectory get no help
      // from the up-walk to `<repoDir>/node_modules` — link those trees in too.
      mirrorNestedNodeModules(opts.repoDir, worktreePath);
      // When we branched off a freshly-fetched tip (`base === 'FETCH_HEAD'`), FF
      // the LOCAL base ref up to it too, so a later `main...HEAD` review scope /
      // status chip / `git diff main...` isn't measured against a stale local
      // `main` that drags already-merged foreign commits into the diff. The
      // `git fetch origin <base>` above also advanced the remote-tracking ref
      // `refs/remotes/origin/<base>`, so we FF from THAT — a local fetch (`.`, no
      // network), FF-only (plain refspec, no `+`) so a diverged local base is
      // refused, and git refuses to write a currently-checked-out branch (the
      // intended guard when the source checkout itself sits on the base). Done
      // after the worktree add (which needs FETCH_HEAD intact) and best-effort —
      // the worktree already exists, so a refusal must never fail the spawn.
      if (base === 'FETCH_HEAD' && baseBranch !== 'HEAD') {
        await git([
          '-C',
          opts.repoDir,
          'fetch',
          '.',
          `refs/remotes/origin/${baseBranch}:refs/heads/${baseBranch}`,
        ]).catch(() => undefined);
      }
      // Back up THIS checkout's admin facts too, not just its siblings' — the
      // sweep above ran before it existed, and a prune can hit it within the
      // minute. The backfill branch reads the admin dir git just wrote.
      try {
        reregisterPrunedWorktrees(opts.repoDir, dirname(worktreePath));
      } catch {
        // ignore — an unrecorded checkout is only less recoverable, never broken
      }
      return worktreePath;
    },
    remove: async (worktreePath) => {
      const rel = relative(resolve(opts.worktreeRoot), resolve(worktreePath));
      if (
        rel === '' ||
        rel.startsWith('..') ||
        isAbsolute(rel) ||
        (existsSync(worktreePath) && lstatSync(worktreePath).isSymbolicLink())
      ) {
        throw new Error('refusing to remove an invalid or symlinked worktree path');
      }
      // Read the branch before removal — `worktree remove` deletes the admin
      // dir we read it from.
      const branch = branchOfWorktree(worktreePath);
      // Unlock first: `git worktree remove` refuses a locked worktree (would
      // need `--force` twice), so drop any lock before removing. Best-effort —
      // an unlocked worktree makes `unlock` error, which we ignore.
      await git(['-C', opts.repoDir, 'worktree', 'unlock', worktreePath]).catch(() => undefined);
      await git(['-C', opts.repoDir, 'worktree', 'remove', worktreePath, '--force']);
      // A session's branch outlives its worktree, so merged branches pile up in
      // the source repo. Drop it once the worktree is gone — `-d` (safe) only
      // deletes a branch already merged into its upstream/HEAD, so unmerged work
      // and the base branch itself survive. Best-effort: a refusal (unmerged,
      // still checked out elsewhere) must not fail teardown.
      if (branch !== undefined && branch !== baseBranch) {
        await git(['-C', opts.repoDir, 'branch', '-d', branch]).catch(() => undefined);
      }
    },
  };
}

/**
 * A degenerate {@link WorktreeProvisioner} that just makes an empty scratch
 * directory (no git) — the A1 behavior, kept as the default when no real git
 * provisioner is injected (tests, or a deployment without a project repo). A
 * spawned agent there starts on an empty dir rather than the real codebase.
 */
export function createScratchProvisioner(opts: { worktreeRoot: string }): WorktreeProvisioner {
  return {
    // Sync fs under the hood, but the interface is async (the git provisioner is)
    // — return resolved promises rather than marking these `async` with no await.
    add: (branch) => {
      const worktreePath = join(opts.worktreeRoot, dirNameFor(branch));
      mkdirSync(worktreePath, { recursive: true });
      return Promise.resolve(worktreePath);
    },
    remove: (worktreePath) => {
      const rel = relative(resolve(opts.worktreeRoot), resolve(worktreePath));
      if (
        rel === '' ||
        rel.startsWith('..') ||
        isAbsolute(rel) ||
        (existsSync(worktreePath) && lstatSync(worktreePath).isSymbolicLink())
      ) {
        return Promise.reject(
          new Error('refusing to remove an invalid or symlinked worktree path'),
        );
      }
      rmSync(worktreePath, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}
