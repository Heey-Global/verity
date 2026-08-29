import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SWEEP_GRACE_MS,
  isLiveArtifact,
  sweepOrphanArtifacts,
} from './session-artifact-sweep.js';

/**
 * The sweep deletes conversations. Every test here is therefore written from the
 * direction that matters: what must SURVIVE. A false orphan is unrecoverable data loss;
 * a missed orphan is only disk space.
 */

const NOW = 1_770_000_000_000;
const OLD = NOW - DEFAULT_SWEEP_GRACE_MS - 60_000;

/** `encodeCwd` of the sandbox cwd the claude helpers below write under by default. */
const CWD_DIR = '-work';

/**
 * The directory of a session that still exists. Passing it is what tells the sweep the
 * store it read is a store with sessions in it — an empty `liveCwdDirs` reads as an empty
 * or foreign database and stops the run before anything is deleted, so a test that wants
 * a deletion has to name one.
 */
const LIVE_CWD = '-work-live';

/**
 * Also put that live session's directory ON the volume, which is what a working guard 2
 * looks like from inside the walk: the store names a directory and the walk finds it.
 * Claude tests that expect a deletion need this — without a single match the sweep cannot
 * tell a dead backlog from a broken name derivation and holds everything.
 *
 * The parked session's own id is deliberately not live: the directory is skipped before
 * any id is consulted, and pinning that is worth more here than realism.
 */
async function parkLiveSession(project = 'proj-a'): Promise<void> {
  await transcript(project, 'parked-session', OLD, LIVE_CWD);
}

let runnersRoot: string;

beforeEach(async () => {
  // Realpath'd: the sweep resolves its scan roots and walks from the resolved path, so
  // an unresolved temp root would make every path it returns differ from the ones the
  // helpers below built.
  runnersRoot = await realpath(await mkdtemp(join(tmpdir(), 'verity-sweep-')));
});

afterEach(async () => {
  await rm(runnersRoot, { recursive: true, force: true });
});

/** A codex rollout under a project runtime, aged to `mtimeMs`. */
async function rollout(project: string, threadId: string, mtimeMs = OLD): Promise<string> {
  const dir = join(runnersRoot, project, 'codex-sessions', '2026', '07', '22');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-07-22T09-00-00-${threadId}.jsonl`);
  await writeFile(file, 'x'.repeat(1024), 'utf8');
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** A claude transcript under a project runtime, aged to `mtimeMs`. */
async function transcript(
  project: string,
  sessionId: string,
  mtimeMs = OLD,
  cwdDir = CWD_DIR,
): Promise<string> {
  const dir = join(runnersRoot, project, 'claude', 'projects', cwdDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, 'y'.repeat(2048), 'utf8');
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** A subagent transcript, which claude files under the OWNING session's directory but
 * names after the subagent. */
async function subagent(
  project: string,
  sessionId: string,
  agentId: string,
  mtimeMs = OLD,
  cwdDir = CWD_DIR,
): Promise<string> {
  const dir = join(runnersRoot, project, 'claude', 'projects', cwdDir, sessionId, 'subagents');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${agentId}.jsonl`);
  await writeFile(file, 'z'.repeat(512), 'utf8');
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

describe('isLiveArtifact', () => {
  it('matches a claude transcript by its whole name', () => {
    expect(isLiveArtifact('/r/claude/projects/-work/abc.jsonl', new Set(['abc']))).toBe(true);
  });

  it('matches a codex rollout by the id at the end of its name', () => {
    const file = '/r/codex-sessions/2026/07/22/rollout-2026-07-22T09-00-00-thread-9.jsonl';
    expect(isLiveArtifact(file, new Set(['thread-9']))).toBe(true);
  });

  it('does not match an id that is only a partial tail of the name', () => {
    // `hread-9` ends the stem as characters but not as a `-`-delimited id, so it must
    // not keep a file alive — otherwise a stale id could pin an unrelated rollout.
    const file = '/r/codex-sessions/rollout-2026-07-22T09-00-00-thread-9.jsonl';
    expect(isLiveArtifact(file, new Set(['hread-9']))).toBe(false);
  });

  it('reports no match against an empty live set', () => {
    expect(isLiveArtifact('/r/claude/projects/-work/abc.jsonl', new Set())).toBe(false);
  });
});

describe('sweepOrphanArtifacts', () => {
  it('removes transcripts of sessions the store no longer knows', async () => {
    const orphanRollout = await rollout('proj-a', 'dead-thread');
    const orphanTranscript = await transcript('proj-a', 'dead-session');
    await parkLiveSession();

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      // A store with a session in it, and that session's directory on the volume: both
      // self-checks are satisfied, so what is left is the backlog this sweep exists for.
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(orphanRollout)).toBe(false);
    expect(existsSync(orphanTranscript)).toBe(false);
    expect(result).toMatchObject({
      scanned: 2,
      removed: 2,
      failed: 0,
      liveKept: 0,
      claudeGuardUnproven: undefined,
    });
    expect(result.bytes).toBe(1024 + 2048);
  });

  it('keeps a rollout whose thread id the store still knows', async () => {
    const liveRollout = await rollout('proj-a', 'live-thread');
    const orphanRollout = await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(['live-thread']),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(liveRollout)).toBe(true);
    expect(existsSync(orphanRollout)).toBe(false);
    expect(result).toMatchObject({ scanned: 2, removed: 1, liveKept: 1 });
  });

  it('keeps a freshly written transcript even when no binding row names it yet', async () => {
    // The binding is persisted fire-and-forget after the backend reports its id, so a
    // just-spawned session has a rollout on disk that the store cannot vouch for. This
    // window is the one way the sweep could destroy a live conversation.
    const justSpawned = await rollout('proj-a', 'brand-new-thread', NOW - 5_000);

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(justSpawned)).toBe(true);
    expect(result).toMatchObject({ scanned: 1, removed: 0, graceKept: 1 });
  });

  it('sweeps every project runtime, not just the first', async () => {
    const a = await rollout('proj-a', 'dead-a');
    const b = await rollout('proj-b', 'dead-b');
    const kept = await rollout('proj-b', 'live-b');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(['live-b']),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(result).toMatchObject({ scanned: 3, removed: 2, liveKept: 1 });
  });

  it('leaves everything else in the runtime alone', async () => {
    // The runtime also holds the supervisor socket, turn scratch dirs and the codex
    // state index. A sweep that reached those would break a running project.
    const runtime = join(runnersRoot, 'proj-a');
    await mkdir(join(runtime, 'turns', 'turn-1'), { recursive: true });
    await writeFile(join(runtime, 'turns', 'turn-1', 'events.ndjson'), 'e', 'utf8');
    await writeFile(join(runtime, 'state_5.sqlite'), 'db', 'utf8');
    await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(join(runtime, 'turns', 'turn-1', 'events.ndjson'))).toBe(true);
    expect(existsSync(join(runtime, 'state_5.sqlite'))).toBe(true);
    expect(result).toMatchObject({ scanned: 1, removed: 1 });
  });

  it('keeps a LIVE session’s subagent transcripts, which carry no session id', async () => {
    // claude writes these as `<sessionId>/subagents/agent-<subagentId>.jsonl`. The file
    // name is the SUBAGENT id, which the store has never seen — so a sweep that read
    // ownership off the file name would delete the subagent history of a running
    // session. Ownership has to come from the parent directory.
    //
    // Here the unique parent id proves the explicit legacy mapping, so the whole
    // directory is skipped exactly like a current canonical cwd.
    const own = await transcript('proj-a', 'live-session');
    const sub = await subagent('proj-a', 'live-session', 'agent-aaf1f9539084e629e');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(['live-session']),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(own)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(result).toMatchObject({ removed: 0, liveKept: 0, liveCwdSkipped: 1 });
  });

  it('removes a dead session’s subagent transcripts along with its own', async () => {
    const own = await transcript('proj-a', 'dead-session');
    const sub = await subagent('proj-a', 'dead-session', 'agent-a296c7e9ee23c0eb7');
    await parkLiveSession();

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(sub)).toBe(false);
    expect(result).toMatchObject({ removed: 2, liveKept: 0 });
  });

  it('never touches the operator’s persistent memory directory', async () => {
    // `projects/<cwd>/memory/` sits beside the session entries but belongs to no
    // session, so by the sweep's own ownership rule its name would read as a dead
    // session id.
    const dir = join(runnersRoot, 'proj-a', 'claude', 'projects', CWD_DIR, 'memory');
    await mkdir(dir, { recursive: true });
    const md = join(dir, 'MEMORY.md');
    const stray = join(dir, 'notes.jsonl');
    await writeFile(md, '# Memory Index', 'utf8');
    await writeFile(stray, '{}', 'utf8');
    await utimes(stray, new Date(OLD), new Date(OLD));

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(md)).toBe(true);
    expect(existsSync(stray)).toBe(true);
    expect(result).toMatchObject({ scanned: 0, removed: 0 });
  });

  it('ignores a per-session subdirectory it does not recognise', async () => {
    // `memory/` was not special-cased; the rule is positive. Only `subagents/` is known
    // to hold a session's own transcripts, so anything else claude (or a future version
    // of it) files under `projects/<cwd>/` is left alone instead of being read as a dead
    // session id and deleted.
    const dir = join(runnersRoot, 'proj-a', 'claude', 'projects', CWD_DIR, 'shell-snapshots');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'snapshot.jsonl');
    await writeFile(file, '{}', 'utf8');
    await utimes(file, new Date(OLD), new Date(OLD));

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(file)).toBe(true);
    expect(result).toMatchObject({ scanned: 0, removed: 0 });
  });

  it('leaves a live session’s whole claude directory alone, dead ids included', async () => {
    // The case an id set cannot answer: switching a session to another backend drops the
    // row naming its claude id, so that id is not live — while the session is. Its
    // `subagents/` tree has no other copy in Verity, and the boot after the switch would
    // have deleted it out from under a running session.
    const displaced = await transcript('proj-a', 'displaced-by-a-switch');
    const displacedSub = await subagent('proj-a', 'displaced-by-a-switch', 'agent-1');
    const orphan = await transcript('proj-b', 'really-dead');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([CWD_DIR]),
      now: NOW,
    });

    expect(existsSync(displaced)).toBe(true);
    expect(existsSync(displacedSub)).toBe(true);
    // Only proj-a's directory is claimed by a live session — the same encoded name under
    // another runtime is protected too, which is the conservative direction.
    expect(existsSync(orphan)).toBe(true);
    expect(result).toMatchObject({
      removed: 0,
      liveCwdSkipped: 2,
      claudeCwdDirsSeen: 2,
      claudeGuardUnproven: undefined,
    });
  });

  it('sweeps a claude directory no live session owns', async () => {
    // The other half of the rule: once the session is deleted its worktree stops being
    // live, and the whole directory — transcript and subagent tree together — goes. The
    // live session parked in `-work-live` is what proves the guard is still matching, so
    // the self-check below stays quiet and the dead directory is actually collected.
    const own = await transcript('proj-a', 'dead-session');
    const sub = await subagent('proj-a', 'dead-session', 'agent-1');
    const live = await transcript('proj-a', 'live-session', OLD, LIVE_CWD);

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(own)).toBe(false);
    expect(existsSync(sub)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(result).toMatchObject({
      removed: 2,
      liveCwdSkipped: 1,
      claudeCwdDirsSeen: 2,
      claudeGuardUnproven: undefined,
      storeReportedNoSession: false,
      held: 0,
    });
  });

  it('uses a unique live id to prove a legacy cwd and collect a genuine orphan', async () => {
    const live = await transcript('proj-a', 'live-session');
    const liveSub = await subagent('proj-a', 'live-session', 'agent-1');
    const dead = await transcript('proj-a', 'dead-session', OLD, '-legacy-dead');
    // A directory the guard DID match, so the weaker check below is not what fires here.
    const parked = await transcript('proj-a', 'parked-session', OLD, LIVE_CWD);
    const deadRollout = await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(['live-session']),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(live)).toBe(true);
    expect(existsSync(liveSub)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(parked)).toBe(true);
    expect(existsSync(deadRollout)).toBe(false);
    expect(result).toMatchObject({
      removed: 2,
      liveKept: 0,
      liveCwdSkipped: 2,
      claudeCwdDirsSeen: 3,
      claudeGuardUnproven: undefined,
      storeReportedNoSession: false,
      held: 0,
    });
    expect(result.scanned).toBe(2);
  });

  it('holds every claude deletion when one live id appears in ambiguous cwd layouts', async () => {
    const first = await transcript('proj-a', 'live-session', OLD, '-legacy-host-path');
    const firstSub = await subagent('proj-a', 'live-session', 'agent-1', OLD, '-legacy-host-path');
    const duplicate = await transcript('proj-a', 'live-session', OLD, '-work-recreated');
    const dead = await transcript('proj-a', 'dead-session', OLD, '-dead');
    await parkLiveSession();
    const deadRollout = await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(['live-session']),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(existsSync(first)).toBe(true);
    expect(existsSync(firstSub)).toBe(true);
    expect(existsSync(duplicate)).toBe(true);
    expect(existsSync(dead)).toBe(true);
    expect(existsSync(deadRollout)).toBe(false);
    expect(result).toMatchObject({
      removed: 1,
      liveKept: 3,
      liveCwdSkipped: 1,
      claudeCwdDirsSeen: 4,
      claudeGuardUnproven: 'contradiction',
      held: 1,
    });
  });

  it('holds every claude deletion when no live worktree matched any directory on disk', async () => {
    // The weaker signal, for the deployment where every live session has switched away
    // from claude and so leaves no live id to contradict anything. The store named a live
    // directory, the volume has claude directories, and not one of them matched: either
    // all of them are genuinely dead, or the name derivation is broken. Refusing to tell
    // those apart costs a delayed sweep; guessing wrong costs a `subagents/` tree.
    const own = await transcript('proj-a', 'dead-session');
    const sub = await subagent('proj-a', 'dead-session', 'agent-1');
    const deadRollout = await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set(['-work-of-a-session-whose-directory-is-not-here']),
      now: NOW,
    });

    expect(existsSync(own)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(existsSync(deadRollout)).toBe(false);
    expect(result).toMatchObject({
      removed: 1,
      liveCwdSkipped: 0,
      claudeCwdDirsSeen: 1,
      claudeGuardUnproven: 'unmatched',
      storeReportedNoSession: false,
      held: 2,
    });
  });

  it('keeps every transcript, both backends, when the store knows of no session at all', async () => {
    // The worst boot this module can have: a server started against a fresh or simply
    // wrong control-plane database, pointed at a data volume full of live conversations.
    // Every id lookup misses and every directory is unclaimed, which reads from inside the
    // walk exactly like a volume of pure backlog — and the whole volume would go, subagent
    // trees included. Codex is held here too: the usual argument for collecting a rollout
    // is that the store can re-materialize it, and this is the one case where the store
    // demonstrably cannot.
    const deadRollout = await rollout('proj-a', 'some-thread');
    const own = await transcript('proj-a', 'some-session');
    const sub = await subagent('proj-a', 'some-session', 'agent-1');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set(),
      now: NOW,
    });

    expect(existsSync(deadRollout)).toBe(true);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(sub)).toBe(true);
    expect(result).toMatchObject({
      scanned: 3,
      removed: 0,
      bytes: 0,
      failed: 0,
      storeReportedNoSession: true,
      held: 3,
    });
  });

  it('reports a clean run when the store is empty and so is the volume', async () => {
    // The refusal above must not fire on a deployment that simply has no sessions yet:
    // there is nothing on the volume to lose, so an empty store is not evidence of
    // anything and the boot should read as the ordinary no-op it is.
    await mkdir(join(runnersRoot, 'proj-a', 'codex-sessions'), { recursive: true });

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set(),
      now: NOW,
    });

    expect(result).toMatchObject({
      scanned: 0,
      removed: 0,
      storeReportedNoSession: false,
      held: 0,
    });
  });

  it('stops where it stands when the signal aborts, and takes nothing after', async () => {
    // Shutdown reaching the walk. The server aborts and then waits for it, so what
    // matters is that the wait is short and that nothing is deleted once the caller has
    // been told the sweep is done — a signal that is already aborted is the strongest
    // form of that: not one file goes.
    const dead = await rollout('proj-a', 'dead-thread');
    await parkLiveSession();
    const controller = new AbortController();
    controller.abort();

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
      signal: controller.signal,
    });

    expect(existsSync(dead)).toBe(true);
    expect(result).toMatchObject({ aborted: true, removed: 0, scanned: 0, held: 0 });
  });

  it('counts the backlog it never reached as held when the abort lands mid-run', async () => {
    // The abort in the test above arrives before anything is collected, so it cannot say
    // whether a partial run reports what it did not get to. This one lands once the walk
    // has judged both rollouts — the live-id check is asked about each file, so firing on
    // the second answer puts the abort after discovery and before any delete, without the
    // test having to know how many times the sweep reads the signal.
    const first = await rollout('proj-a', 'dead-one');
    const second = await rollout('proj-a', 'dead-two');
    await parkLiveSession();
    const controller = new AbortController();
    let judged = 0;
    const liveIds = {
      has: () => {
        judged += 1;
        if (judged >= 2) controller.abort();
        return false;
      },
      [Symbol.iterator]: function* (): Generator<string> {},
    } as unknown as ReadonlySet<string>;

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds,
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
      signal: controller.signal,
    });

    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    // Scanned, not taken — the same reading the two refusals give, and the reason the
    // summary of a stopped run is not mistaken for a complete run that found less.
    expect(result).toMatchObject({ aborted: true, removed: 0, scanned: 2, held: 2 });
  });

  it('finishes normally when its signal never fires', async () => {
    // The other half of the pair: passing a signal must not be what stops a sweep. Only
    // aborting it is.
    const dead = await rollout('proj-a', 'dead-thread');
    await parkLiveSession();

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
      signal: new AbortController().signal,
    });

    expect(existsSync(dead)).toBe(false);
    expect(result).toMatchObject({ aborted: false, removed: 1 });
  });

  it('still sweeps when the runners root is reached through a symlink', async () => {
    // Containment is measured against the root, so the root cannot be measured against
    // itself. A data volume reached through a symlinked ancestor (`/data` -> `/mnt/data`,
    // a symlinked mount) is an ordinary deployment; comparing the resolved root to the
    // unresolved one rejects every child and turns the sweep into a no-op that reports
    // the same `scanned: 0` as a clean volume. Every OTHER test here realpaths its root,
    // so this is the only place that would notice.
    const linkDir = await mkdtemp(join(tmpdir(), 'verity-link-'));
    const link = join(linkDir, 'runners');
    try {
      const dead = await rollout('proj-a', 'dead-thread');
      await symlink(runnersRoot, link, 'dir');

      const result = await sweepOrphanArtifacts({
        runnersRoot: link,
        liveIds: new Set(),
        liveCwdDirs: new Set([LIVE_CWD]),
        now: NOW,
      });

      expect(result).toMatchObject({ scanned: 1, removed: 1 });
      expect(existsSync(dead)).toBe(false);
    } finally {
      // Unlink the link itself before the directory holding it, so no recursive remove
      // can be tempted through it into the real root.
      await rm(link, { force: true });
      await rm(linkDir, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked codex archive out of the runtime', async () => {
    // The runner runtime is written by the Sandbox. `readdir` follows a symlinked
    // directory, so without resolving the scan root a link planted at `codex-sessions`
    // would have aimed this sweep at any `.jsonl` on the host.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'verity-not-ours-')));
    try {
      const planted = join(outside, 'rollout-2026-07-22T09-00-00-dead-thread.jsonl');
      await writeFile(planted, 'x', 'utf8');
      await utimes(planted, new Date(OLD), new Date(OLD));
      await mkdir(join(runnersRoot, 'proj-a'), { recursive: true });
      await symlink(outside, join(runnersRoot, 'proj-a', 'codex-sessions'), 'dir');

      const result = await sweepOrphanArtifacts({
        runnersRoot,
        liveIds: new Set(),
        liveCwdDirs: new Set([LIVE_CWD]),
        now: NOW,
      });

      expect(existsSync(planted)).toBe(true);
      expect(result).toMatchObject({ scanned: 0, removed: 0 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not follow a symlinked subagents directory out of the runtime', async () => {
    // Same hole one level deeper: the session directory is a real directory the sweep
    // read from a dirent, but the `subagents/` name inside it is one this module builds.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'verity-not-ours-')));
    try {
      const planted = join(outside, 'agent-1.jsonl');
      await writeFile(planted, 'x', 'utf8');
      await utimes(planted, new Date(OLD), new Date(OLD));
      const sessionDir = join(runnersRoot, 'proj-a', 'claude', 'projects', CWD_DIR, 'dead-session');
      await mkdir(sessionDir, { recursive: true });
      await symlink(outside, join(sessionDir, 'subagents'), 'dir');

      const result = await sweepOrphanArtifacts({
        runnersRoot,
        liveIds: new Set(),
        liveCwdDirs: new Set([LIVE_CWD]),
        now: NOW,
      });

      expect(existsSync(planted)).toBe(true);
      expect(result).toMatchObject({ scanned: 0, removed: 0 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('counts without deleting under dryRun', async () => {
    const orphan = await rollout('proj-a', 'dead-thread');

    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
      dryRun: true,
    });

    expect(existsSync(orphan)).toBe(true);
    expect(result).toMatchObject({ scanned: 1, removed: 1, bytes: 1024 });
  });

  it('returns an empty result when no runner runtime exists', async () => {
    const result = await sweepOrphanArtifacts({
      runnersRoot: join(runnersRoot, 'missing'),
      liveIds: new Set(),
      liveCwdDirs: new Set([LIVE_CWD]),
      now: NOW,
    });

    expect(result).toMatchObject({ scanned: 0, removed: 0, failed: 0 });
  });
});
