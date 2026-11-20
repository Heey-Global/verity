import type { EventStore } from '@verity/store';

import { encodeCwd } from '@verity/session';
import { sweepOrphanArtifacts, type SweepResult } from './session-artifact-sweep.js';

export type { SweepResult };

type SweepLog = Record<
  'info' | 'warn' | 'error',
  (fields: Record<string, unknown>, message: string) => void
>;

/**
 * Remove backend transcripts no session names any more from the runner runtimes, once
 * per boot. `storeReads` settles once the store has been read (a close waits on it);
 * `walk` settles with the result, or `undefined` when the sweep failed. Every outcome
 * is logged: this deletes conversations, so what a boot did has to be answerable.
 */
export function startOrphanTranscriptSweep(deps: {
  runnersRoot: string;
  dryRun: boolean;
  store: Pick<EventStore, 'listLiveBackendSessionIds' | 'listSessionWorktrees'>;
  /** The worktree's path inside the sandbox, shared with the delete path. */
  sessionSandboxCwd: (worktree: string) => string;
  signal: AbortSignal;
  log: SweepLog;
}): { storeReads: Promise<void>; walk: Promise<SweepResult | undefined> } {
  const { runnersRoot, dryRun, sessionSandboxCwd } = deps;
  const eventStore = deps.store;
  const app = { log: deps.log };
  const sweepAbort = { signal: deps.signal };
  let storeReadsDone!: () => void;
  const storeReads = new Promise<void>((resolve) => {
    storeReadsDone = resolve;
  });
  const walk = (async () => {
    let liveIds: string[];
    let worktrees: string[];
    try {
      [liveIds, worktrees] = await Promise.all([
        eventStore.listLiveBackendSessionIds(),
        eventStore.listSessionWorktrees(),
      ]);
    } finally {
      storeReadsDone();
    }
    const result = await sweepOrphanArtifacts({
      runnersRoot,
      liveIds: new Set(liveIds),
      // The claude directory name of every session that still exists. `encodeCwd` is
      // claude's own naming rule, applied to the cwd as the SANDBOX saw it — the same
      // derivation the delete path uses, so the two agree on which directory belongs
      // to which session.
      liveCwdDirs: new Set(worktrees.map((worktree) => encodeCwd(sessionSandboxCwd(worktree)))),
      dryRun,
      signal: sweepAbort.signal,
    });
    // Logged unconditionally, at info: this deletes conversations, so what it did on
    // a given boot has to be answerable afterwards — including "nothing".
    const summary = {
      dryRun,
      scanned: result.scanned,
      // Under `dry` nothing was deleted, so the count goes out under a name that
      // says so: a dashboard summing `removed` must not be fed files that are still
      // there by a run whose whole point was not to touch them.
      ...(dryRun ? { wouldRemove: result.removed } : { removed: result.removed }),
      megabytes: Number((result.bytes / 1024 / 1024).toFixed(1)),
      liveKept: result.liveKept,
      graceKept: result.graceKept,
      liveCwdSkipped: result.liveCwdSkipped,
      claudeCwdDirsSeen: result.claudeCwdDirsSeen,
      failed: result.failed,
    };
    if (result.aborted) {
      // Shutdown reached the walk before the walk was done. Its own line rather than the
      // ordinary one, because every count in the summary is a partial and the ordinary
      // line is what someone reads to answer "what did this boot delete".
      app.log.info(
        { ...summary, aborted: true },
        'verity: orphaned backend transcript sweep stopped by shutdown',
      );
      return result;
    }
    if (result.storeReportedNoSession) {
      // The bluntest of the two refusals, and the one that catches a server pointed at
      // the wrong control-plane database: the store named no session at all, the volume
      // was full of transcripts, and both readings of that — a deployment with no
      // sessions, or a database that is not this volume's — end with nothing deleted.
      // If the store really is this volume's and really is empty, the held files are
      // dead and can be removed from the volume directly; the sweep will not do it on a
      // store it cannot corroborate.
      app.log.error(
        { ...summary, held: result.held },
        'verity: orphaned transcript sweep removed nothing — the store knows of no session at all',
      );
      return result;
    }
    if (result.claudeGuardUnproven !== undefined) {
      // Either way the sweep collected no claude file this boot, and either way the count
      // it did NOT take goes out with it. The level splits on how much the sweep actually
      // knows. A contradiction means one live backend id appeared under multiple cwd
      // directories, so no legacy mapping is unique; this line is then the only warning
      // before a session's unreproducible `subagents/` tree would have gone. The weaker check only
      // says nothing matched, which a deployment whose live sessions have never run claude
      // sits in legitimately and indefinitely — an error line that never clears teaches
      // people to ignore error lines.
      const level = result.claudeGuardUnproven === 'contradiction' ? 'error' : 'warn';
      app.log[level](
        { ...summary, held: result.held, signal: result.claudeGuardUnproven },
        'verity: orphaned transcript sweep kept every claude file — live-worktree guard unproven',
      );
      return result;
    }
    app.log.info(
      summary,
      dryRun
        ? 'verity: orphaned backend transcript sweep (dry run, nothing removed)'
        : 'verity: orphaned backend transcript sweep',
    );
    return result;
  })().catch((error: unknown) => {
    // Covers the store reads too, which is why `storeReadsDone` resolves from a
    // `finally` — a close waiting on that promise must not hang on a failed query.
    app.log.warn({ err: error }, 'verity: orphaned transcript sweep failed');
    return undefined;
  });
  return { storeReads, walk };
}
