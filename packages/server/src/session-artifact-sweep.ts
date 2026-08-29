import type { Dirent } from 'node:fs';
import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CLAUDE_PROJECTS_DIRNAME } from '@verity/session';
import { RUNNER_CLAUDE_HOME_DIRNAME, RUNNER_CODEX_SESSIONS_DIRNAME } from './runner-transcript.js';
import { isWithinRealPath } from './session-artifacts.js';

/**
 * Sweep backend transcripts whose session no longer exists.
 *
 * `session-artifacts.ts` closes the leak going forward: deleting a session now deletes
 * its transcripts too. This module exists for what leaked BEFORE that — those sessions
 * are already gone from the store, so no future delete will ever revisit their files.
 * They would sit on the data volume forever. In the project this was found on that is
 * 2444 codex rollouts (730 MB) and 483 claude transcripts (302 MB), reaching back weeks.
 *
 * Runs ONCE at startup, not on a timer. A directory walk is cheap, the backlog is a
 * one-off, and the ongoing case is already handled at the delete itself — so a standing
 * garbage collector would be machinery earning nothing. It does double as a safety net:
 * a purge that failed at delete time (the runner runtime is not the Server's to write
 * freely) gets picked up at the next restart instead of leaking silently.
 *
 * # Why this cannot delete a live conversation
 *
 * Three independent guards, any one of which alone would spare a file:
 *
 *  1. **Id match.** A file is kept when its name carries an id the store still knows —
 *     see {@link isLiveArtifact}. The match is by suffix, exactly the rule
 *     `codexRolloutFiles` uses to find a thread's rollouts, so any id that is live
 *     necessarily matches. The failure direction is therefore "keeps a file it could
 *     have deleted", never "deletes a file it should have kept".
 *  2. **Owning worktree.** For claude, an id alone is not enough. A session that switches
 *     backend loses the `session_backend_state` row naming its claude id, so that id
 *     stops being live while the session does not — and its `subagents/` tree, which
 *     nothing in Verity can reproduce, would be swept out from under it at the next boot.
 *     Claude files everything under `projects/<encoded-cwd>/`, and the cwd is the
 *     session's own worktree, so that directory answers the question the id cannot:
 *     {@link SweepOptions.liveCwdDirs} names the ones a live session still owns and the
 *     sweep does not enter them. When the session is deleted its worktree stops being
 *     live too, and the whole directory becomes collectible in one go.
 *
 *     Because that guard is a name match against a name derived somewhere else
 *     (`sessionSandboxCwd` in `embedded.ts`), it can fail by matching NOTHING, which from
 *     inside the walk looks the same as a volume with no live sessions. So the claude half
 *     runs in two passes: it collects its verdicts, checks them for the two signs a broken
 *     derivation leaves behind, and deletes nothing at all for that run if it finds one
 *     ({@link SweepResult.claudeGuardUnproven}). Failing to collect a backlog for one
 *     boot is recoverable; collecting a live session's subagents is not.
 *
 *     For pre-convention artifacts, a live backend id found in exactly one encoded-cwd
 *     directory proves that explicit legacy mapping and protects the whole directory.
 *     The sweep never guesses from a worktree basename. If the same live id occurs under
 *     more than one cwd, the mapping is ambiguous and the contradiction refusal remains.
 *
 *     The other check is deliberately weaker than a proof, and on a deployment
 *     whose live sessions have never run claude — all codex, say — while dead claude
 *     directories remain on the volume, it holds that claude backlog on every boot with no
 *     way to clear itself except a live session finally writing a claude directory. That is
 *     the intended reading of an unproven guard, but it is not a fault, so the two checks
 *     report differently: the contradiction is proof and logs at `error`, the weak check is
 *     a suspicion and logs at `warn` rather than parking a permanent error line in a
 *     deployment that is behaving. An operator certain the held files are dead can remove
 *     them from the volume by hand; the sweep will not be talked into it.
 *
 *     The same reasoning has a blunter case underneath it. Both guards read "the store
 *     knows of no session" and "the store the sweep is reading is not the one that wrote
 *     this volume" the same way — as permission to delete everything. A server booted
 *     against an empty or foreign control-plane database, pointed at a populated data
 *     volume, would collect the whole volume in one pass, subagent trees included. So an
 *     empty {@link SweepOptions.liveCwdDirs} — which means the `sessions` table itself is
 *     empty — combined with anything at all found to collect stops the run before a single
 *     file is taken, in BOTH backends ({@link SweepResult.storeReportedNoSession}). The
 *     codex half is included here even though a rollout is normally reproducible from the
 *     store, because in precisely this case the store does not have it: if the database is
 *     the wrong one, the rollout on disk is the only copy of that conversation too.
 *  3. **Grace window.** A file modified within {@link SweepOptions.graceMs} is kept
 *     regardless. The binding row is written fire-and-forget after the backend reports
 *     its session id (`Conductor.persistBackendSessionState`), so a rollout briefly
 *     exists while the store has no row naming it. Without this window a sweep racing a
 *     just-spawned session would delete the conversation it is still writing.
 *
 * # Containment
 *
 * The runner runtime is written by the Sandbox, so any directory in it may have been
 * replaced with a symlink. `readdir` follows one; the dirent checks below refuse to
 * descend into one; and every scan root the sweep constructs is resolved and re-checked
 * against the runners root before it is read ({@link realDirWithin}). Without that a link
 * planted at `codex-sessions` or `projects` would have aimed this at any `.jsonl` on the
 * host.
 *
 * The boundary is the runners root as `realpath` reports it, resolved once at the top.
 * Comparing children against the path the caller passed instead would be a check on
 * strings: a deployment whose data volume is reached through a symlinked ancestor
 * (`/data` → `/mnt/data`) resolves every child outside the unresolved root and the sweep
 * would refuse its own runtime and silently collect nothing.
 */

/** Files newer than this are spared no matter what the store says. One day is far
 * beyond the seconds-long window between a backend reporting its id and the binding
 * row landing, and costs only a delayed cleanup of genuinely dead files. */
export const DEFAULT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** `<dataVolumeRoot>/runners` — one subdirectory per project runtime. */
  runnersRoot: string;
  /** Ids the store still knows; see `EventStore.listLiveBackendSessionIds`. */
  liveIds: ReadonlySet<string>;
  /**
   * `projects/<encoded-cwd>` directory names belonging to sessions that still exist —
   * `encodeCwd(sandboxCwd)` of every live session's worktree. Claude's whole tree under
   * such a directory is left alone, including ids no binding row names any more; see
   * guard 2 in the module header.
   *
   * Required, and an empty set means the store's `sessions` table is empty — which is
   * either a deployment with no sessions at all or one reading the wrong database, and
   * the sweep refuses to tell those apart (see {@link SweepResult.storeReportedNoSession}).
   * Not optional: this is the only guard standing between a switched-away session and
   * the loss of its `subagents/` tree, and a caller that simply forgot to pass it would
   * get the unprotected behaviour without ever saying so.
   *
   * Flat, and matched against every runtime rather than against the one the session
   * belongs to. That is not a shortcut but the same conservatism as everything else here:
   * `runnerSandboxPath` maps a worktree to `/work/<rest>`, dropping the repo directory,
   * so two projects whose worktrees share a session directory name encode to the same
   * `projects/` name and the sweep cannot tell whose is whose. It keeps both. The cost is
   * real and worth stating: a dead directory in one runtime stays on the volume for as
   * long as a live session in another happens to collide with its name, so on a
   * multi-project deployment the backlog this sweep exists to reclaim may include files
   * it will never take. Keeping a dead file forever is the recoverable half of that
   * trade; taking a live session's `subagents/` tree is not.
   */
  liveCwdDirs: ReadonlySet<string>;
  /** Spare anything modified within this window. Defaults to {@link DEFAULT_SWEEP_GRACE_MS}. */
  graceMs?: number | undefined;
  /** Injected for tests; defaults to the wall clock. */
  now?: number | undefined;
  /**
   * Stop the walk where it stands — checked before each runtime, each directory entry the
   * listing visits, and each delete.
   *
   * The sweep runs behind the boot rather than inside it, so it is still deleting when a
   * short-lived process decides to shut down. `buildEmbeddedServer` is a public entry
   * point: a caller that closes the server and then tears its data root down would
   * otherwise be racing a live `rm` loop over that same root. Aborting between files
   * rather than mid-file: the unit of work is one `rm`, and a run that stops halfway
   * leaves the volume in a state the next boot's sweep reads correctly anyway.
   */
  signal?: AbortSignal | undefined;
  /** Report what would go without removing anything. */
  dryRun?: boolean | undefined;
}

export interface SweepResult {
  /** Transcript files examined across every project runtime. */
  scanned: number;
  /** Files removed (or, under `dryRun`, that would have been). */
  removed: number;
  /** Bytes those files held. */
  bytes: number;
  /** Files kept because the store still knows their id. */
  liveKept: number;
  /** Files kept only because they fall inside the grace window. */
  graceKept: number;
  /** Files that could not be removed — a genuine leak worth logging. */
  failed: number;
  /** Claude directories skipped because a live session still owns that worktree. */
  liveCwdSkipped: number;
  /** `projects/<encoded-cwd>` directories seen across every runtime, protected or not. */
  claudeCwdDirsSeen: number;
  /**
   * Which of guard 2's self-checks refused this run, if either. Claude deletion was
   * skipped for the whole run in both cases (see {@link held}), but they do not carry the
   * same weight: `contradiction` means a live id has ambiguous directory ownership and
   * wants someone to look at it, while `unmatched` is a suspicion that
   * a deployment can sit in legitimately — so the caller logs them at different levels.
   */
  claudeGuardUnproven: 'contradiction' | 'unmatched' | undefined;
  /**
   * True when the store named no session at all while the volume held files to collect —
   * an empty or foreign control-plane database against a populated data volume. Nothing
   * is deleted in either backend for that run. See guard 2 in the module header.
   */
  storeReportedNoSession: boolean;
  /**
   * Files left in place by a refusal or an abort — scanned, judged collectible, not taken.
   *
   * An upper bound, not a promise: a run that stops returns before the per-file `stat` that
   * applies the grace window, so a file young enough to have been kept anyway is counted
   * here too. Deliberate — the alternative is to stat the whole backlog to produce a
   * prettier number on a run that has already decided to touch nothing — and it errs the
   * safe way, since the point of the number is how much a wrong guard would have taken.
   */
  held: number;
  /**
   * True when {@link SweepOptions.signal} stopped the run before it was done, so every
   * count above is a partial. Nothing is lost by it: what this run did not reach, the
   * next boot's sweep reaches.
   */
  aborted: boolean;
}

/**
 * Whether a transcript file belongs to a session the store still knows.
 *
 * Codex names a rollout `rollout-<ISO>-<thread>.jsonl` and claude names its transcript
 * `<id>.jsonl`, so the id is either the whole stem or its trailing `-`-delimited tail.
 * Rather than parse the timestamp — a format Codex owns and may change — this asks the
 * question from the other side: does any live id sit at the end of this name? That is
 * the same suffix rule the delete path matches on, so the two agree by construction.
 */
export function isLiveArtifact(file: string, liveIds: ReadonlySet<string>): boolean {
  const stem = basename(file).replace(/\.jsonl$/u, '');
  if (liveIds.has(stem)) return true;
  // A linear pass over the live ids: the set is one entry per session, the scan runs
  // only for names that are not already an exact hit, and correctness here matters more
  // than shaving a few milliseconds off a once-per-boot walk.
  for (const id of liveIds) {
    if (id.length > 0 && stem.endsWith(`-${id}`)) return true;
  }
  return false;
}

async function listDirs(dir: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(dir, { encoding: 'utf8', withFileTypes: true });
  } catch {
    // A runtime that was never provisioned, or one the Server may not traverse. Both
    // mean "nothing to sweep here", not a failed boot.
    return [];
  }
}

/**
 * A directory this sweep may read, or `undefined`.
 *
 * Every scan root is a path this module CONSTRUCTS (`<runtime>/codex-sessions`,
 * `<claude-home>/projects`, `<id>/subagents`) rather than one it read from a dirent, so
 * none of the `isDirectory()` checks elsewhere apply to it — and `readdir` follows a
 * symlink. Resolving it and demanding it still be inside `root` is what keeps a link
 * planted in the Sandbox-writable runtime from aiming the walk, and therefore the `rm`
 * at the end of it, somewhere else entirely.
 *
 * `root` must ALREADY be real — see the containment note in the module header for what
 * comparing against an unresolved one would cost.
 */
async function realDirWithin(dir: string, root: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(dir);
    return isWithinRealPath(root, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every `.jsonl` under `dir`, recursively.
 *
 * `stop` is checked per dirent rather than only per directory: on a runtime with a large
 * codex archive this recursion is where most of a run's time goes, and an abort that is
 * only read between runtimes would leave a shutdown waiting out the walk it just told to
 * stop. Returning what it has found so far is safe — the caller's own check turns a short
 * list into a halt, and a partial list only ever means fewer files considered.
 */
async function transcriptFiles(dir: string, stop?: () => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDirs(dir)) {
    if (stop?.() === true) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await transcriptFiles(path, stop)));
      continue;
    }
    // Symlinks are skipped rather than followed: the runner runtime is writable by the
    // sandbox, and a link planted there must not steer a delete outside the tree.
    if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

/**
 * The only subdirectory of `projects/<encoded-cwd>/<id>/` this sweep will descend into.
 * See {@link claudeGroups} for why the rule is stated positively.
 */
const CLAUDE_SESSION_SUBDIR = 'subagents';

/** One session's claude artifacts under a single `projects/<encoded-cwd>/` directory. */
interface ClaudeArtifactGroup {
  /** The id that decides whether the whole group lives or dies. */
  sessionId: string;
  files: string[];
}

/**
 * Group the claude transcripts under one encoded-cwd directory by owning session.
 *
 * claude writes a session's own transcript as `<id>.jsonl` but its subagents' as
 * `<id>/subagents/agent-<subagentId>.jsonl` — named by SUBAGENT id, which the store has
 * never heard of. Reading ownership off the file name would therefore classify every
 * subagent transcript as an orphan and delete it, including for a session that is alive
 * and running. Ownership comes from the depth-1 entry name instead: the file's stem, or
 * the directory it sits under.
 *
 * That makes the depth-1 name load-bearing, so what counts as a session directory is an
 * ALLOWLIST of claude's actual layout — a `subagents/` child — and not a list of names
 * to skip. `projects/<encoded-cwd>/` also holds `memory/`, the operator's persistent
 * memory, which under a skip-list would read as a dead session id and lose its files;
 * and the next directory some backend version writes there would too. Stated this way an
 * unrecognised directory is simply not swept, which costs disk space rather than data.
 */
async function claudeGroups(
  encodedCwdDir: string,
  root: string,
  stop?: () => boolean,
): Promise<ClaudeArtifactGroup[]> {
  const groups: ClaudeArtifactGroup[] = [];
  for (const entry of await listDirs(encodedCwdDir)) {
    if (stop?.() === true) break;
    const path = join(encodedCwdDir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      groups.push({ sessionId: entry.name.replace(/\.jsonl$/u, ''), files: [path] });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const subagents = await realDirWithin(join(path, CLAUDE_SESSION_SUBDIR), root);
    if (subagents === undefined) continue;
    const files = await transcriptFiles(subagents, stop);
    if (files.length > 0) groups.push({ sessionId: entry.name, files });
  }
  return groups;
}

/** Session owners visible at depth one, without walking a live session's subagents. */
async function claudeSessionIds(
  encodedCwdDir: string,
  root: string,
  stop?: () => boolean,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of await listDirs(encodedCwdDir)) {
    if (stop?.() === true) break;
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      ids.add(entry.name.replace(/\.jsonl$/u, ''));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const subagents = await realDirWithin(
      join(encodedCwdDir, entry.name, CLAUDE_SESSION_SUBDIR),
      root,
    );
    if (subagents !== undefined) ids.add(entry.name);
  }
  return ids;
}

/**
 * Remove every transcript on the runner runtimes whose session the store no longer
 * knows. Never throws: a boot must not fail because a directory was unreadable.
 */
export async function sweepOrphanArtifacts(options: SweepOptions): Promise<SweepResult> {
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const cutoff = (options.now ?? Date.now()) - graceMs;
  const result: SweepResult = {
    scanned: 0,
    removed: 0,
    bytes: 0,
    liveKept: 0,
    graceKept: 0,
    failed: 0,
    liveCwdSkipped: 0,
    claudeCwdDirsSeen: 0,
    claudeGuardUnproven: undefined,
    storeReportedNoSession: false,
    held: 0,
    aborted: false,
  };
  /** Set on the result as it is read, so a caller cannot mistake a stopped run's counts
   * for a complete one's. */
  const stopped = (): boolean => {
    if (options.signal?.aborted !== true) return false;
    result.aborted = true;
    return true;
  };
  /**
   * Stop, counting what the run never got to the way a refusal counts it: judged
   * collectible, left in place. A shutdown that reported only what it had already deleted
   * would describe a partial run as a complete one that found less.
   */
  const halt = (...remaining: number[]): SweepResult => {
    const rest = remaining.reduce((sum, count) => sum + count, 0);
    result.scanned += rest;
    result.held = rest;
    return result;
  };
  // Resolved once, and NOT through `realDirWithin`: the root is what containment is
  // measured against, so it cannot be measured against itself. A data volume reached
  // through a symlinked ancestor (`/data` -> `/mnt/data`) is an ordinary deployment
  // choice, and checking the resolved root against the unresolved one would reject it —
  // turning the whole sweep into a silent no-op that logs the same `scanned: 0` as a
  // clean volume. An unreadable root is the only reason to stop here.
  let root: string;
  try {
    root = await realpath(options.runnersRoot);
  } catch {
    return result;
  }

  /** Weigh one file whose owning session is already known to be gone. */
  const consider = async (file: string): Promise<void> => {
    result.scanned += 1;
    let size: number;
    try {
      const stats = await stat(file);
      if (stats.mtimeMs > cutoff) {
        result.graceKept += 1;
        return;
      }
      size = stats.size;
    } catch {
      // Vanished between listing and stat — someone else already cleaned it up.
      return;
    }
    if (options.dryRun === true) {
      result.removed += 1;
      result.bytes += size;
      return;
    }
    try {
      // Files only, never directories: `projects/<cwd>/` also holds `memory/`, whose
      // contents belong to no session. Sweeping files alone means a non-transcript can
      // never be caught by this, at the price of leaving an empty directory behind — a
      // swept session's `<id>/subagents/` outlives every file that was in it. The cost is
      // a dirent and one `readdir` per boot: `claudeGroups` drops a group with no files,
      // so an emptied tree is never re-considered, only re-listed.
      await rm(file, { force: true });
      result.removed += 1;
      result.bytes += size;
    } catch {
      result.failed += 1;
    }
  };

  /**
   * Files judged collectible, held back until the whole walk is done.
   *
   * Guard 2 is a NAME match, and a name match that has quietly stopped matching is
   * indistinguishable, from inside the walk, from a volume that simply has no live
   * sessions on it: both leave `liveCwdSkipped` at zero and both let every directory
   * through. Since what it protects — a switched-away session's `subagents/` tree — has
   * no second copy anywhere in Verity, the walk collects its verdicts first and only
   * acts on them once the checks below have found no sign that the guard is broken.
   * Bounded by the number of orphaned files, which is the backlog this sweep exists to
   * clear, not the size of the volume.
   *
   * Codex is deferred too, though nothing about a rollout's own guard is in doubt: the
   * empty-store check below can only be answered after the whole walk, and it decides
   * for both backends. Kept in its own list because the claude-only refusal does not
   * apply to it — a run that holds claude still collects codex.
   */
  const codexCollectible: string[] = [];
  const claudeCollectible: string[] = [];
  const claudeDirectories: Array<{
    directory: string;
    canonical: boolean;
    sessionIds: ReadonlySet<string>;
    groups?: Awaited<ReturnType<typeof claudeGroups>>;
  }> = [];

  for (const project of await listDirs(root)) {
    if (stopped()) return halt(codexCollectible.length, claudeCollectible.length);
    if (!project.isDirectory()) continue;
    const runtimeDir = join(root, project.name);

    // Codex: one flat archive of dated rollouts, each named for its own thread. Guard 2
    // does not apply here — a rollout carries its own thread id — so the id check is the
    // whole verdict; it is only the empty-store check that makes it wait.
    const codexRoot = await realDirWithin(join(runtimeDir, RUNNER_CODEX_SESSIONS_DIRNAME), root);
    for (const file of codexRoot === undefined ? [] : await transcriptFiles(codexRoot, stopped)) {
      if (isLiveArtifact(file, options.liveIds)) {
        result.scanned += 1;
        result.liveKept += 1;
        continue;
      }
      codexCollectible.push(file);
    }

    // Claude: grouped per session, because a subagent transcript is named for the
    // subagent and only its parent directory says which session it belongs to.
    const projectsRoot = await realDirWithin(
      join(runtimeDir, RUNNER_CLAUDE_HOME_DIRNAME, CLAUDE_PROJECTS_DIRNAME),
      root,
    );
    if (projectsRoot === undefined) continue;
    for (const encodedCwd of await listDirs(projectsRoot)) {
      if (stopped()) return halt(codexCollectible.length, claudeCollectible.length);
      if (!encodedCwd.isDirectory()) continue;
      result.claudeCwdDirsSeen += 1;
      // Guard 2: a live session's own directory is not entered at all. Its displaced
      // claude ids are indistinguishable from a dead session's by name alone, and one of
      // the files under them — the `subagents/` tree — has no second copy anywhere.
      const directory = join(projectsRoot, encodedCwd.name);
      claudeDirectories.push({
        directory,
        canonical: options.liveCwdDirs.has(encodedCwd.name),
        sessionIds: await claudeSessionIds(directory, root, stopped),
        ...(options.liveCwdDirs.has(encodedCwd.name)
          ? {}
          : { groups: await claudeGroups(directory, root, stopped) }),
      });
    }
  }

  // Compatibility proof for sessions created before the current sandbox path convention.
  // A live Claude id is stronger evidence than a host-path reconstruction: it is the
  // backend's own durable identity, stored in the exact directory Claude selected. Accept
  // that mapping only when the id occurs in ONE encoded-cwd directory across the runtime.
  // This covers old host-absolute paths and a worktree recreated under a new host root
  // without guessing from a basename. A duplicate is ambiguous and preserves the original
  // contradiction refusal for every Claude candidate.
  const directoriesByLiveId = new Map<string, Set<string>>();
  for (const entry of claudeDirectories) {
    for (const sessionId of entry.sessionIds) {
      if (!options.liveIds.has(sessionId)) continue;
      const directories = directoriesByLiveId.get(sessionId) ?? new Set<string>();
      directories.add(entry.directory);
      directoriesByLiveId.set(sessionId, directories);
    }
  }
  const ambiguousDirectories = new Set<string>();
  const provenLegacyDirectories = new Set<string>();
  for (const directories of directoriesByLiveId.values()) {
    if (directories.size === 1) provenLegacyDirectories.add([...directories][0]!);
    else for (const directory of directories) ambiguousDirectories.add(directory);
  }
  if (ambiguousDirectories.size > 0) result.claudeGuardUnproven = 'contradiction';
  for (const entry of claudeDirectories) {
    if (
      entry.canonical ||
      (provenLegacyDirectories.has(entry.directory) && !ambiguousDirectories.has(entry.directory))
    ) {
      result.liveCwdSkipped += 1;
      continue;
    }
    for (const group of entry.groups ?? []) {
      if (options.liveIds.has(group.sessionId)) {
        result.scanned += group.files.length;
        result.liveKept += group.files.length;
        result.claudeGuardUnproven = 'contradiction';
      } else {
        claudeCollectible.push(...group.files);
      }
    }
  }

  // Nothing in the store to compare against, and something on the volume to lose. An
  // empty `liveCwdDirs` is an empty `sessions` table, and the honest readings of that are
  // "a deployment that has never had a session" and "the wrong database" — the first has
  // nothing to collect anyway, so anything found means the second is live enough to
  // matter. Both halves are held: with a foreign store, the codex rollouts on disk are no
  // more reproducible than the claude trees beside them.
  if (options.liveCwdDirs.size === 0 && codexCollectible.length + claudeCollectible.length > 0) {
    result.storeReportedNoSession = true;
    result.scanned += codexCollectible.length + claudeCollectible.length;
    result.held = codexCollectible.length + claudeCollectible.length;
    return result;
  }

  for (const [index, file] of codexCollectible.entries()) {
    if (stopped()) return halt(codexCollectible.length - index, claudeCollectible.length);
    await consider(file);
  }

  // The weaker second check, for the case the first cannot see: a deployment whose live
  // sessions have all switched away from claude has no live group to contradict anything,
  // and is exactly where guard 2 is doing its real work. If the store named live
  // directories and the volume has claude directories, but not one of them matched, then
  // either every claude directory on disk is genuinely dead — plausible, and costing only
  // a delayed sweep — or the names never had a chance of matching. Refusing to tell those
  // two apart is the safe reading.
  if (options.liveCwdDirs.size > 0 && result.claudeCwdDirsSeen > 0 && result.liveCwdSkipped === 0) {
    result.claudeGuardUnproven ??= 'unmatched';
  }

  if (result.claudeGuardUnproven !== undefined) {
    result.scanned += claudeCollectible.length;
    result.held = claudeCollectible.length;
    return result;
  }
  for (const [index, file] of claudeCollectible.entries()) {
    if (stopped()) return halt(claudeCollectible.length - index);
    await consider(file);
  }
  return result;
}
