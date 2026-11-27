import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { EmbeddedServer, EmbeddedServerConfig } from './embedded-types.js';
import type { createEmbeddedSessionCleanup } from './embedded-session-cleanup.js';
import { SWEEP_SHUTDOWN_WAIT_MS } from './embedded-support.js';
import { startOrphanTranscriptSweep, type SweepResult } from './orphan-transcript-sweep.js';

type SweepContext = Parameters<typeof startOrphanTranscriptSweep>[0];
type CleanupContext = ReturnType<typeof createEmbeddedSessionCleanup>;

/** Own boot-only transcript collection and bounded session maintenance shutdown. */
export function createEmbeddedSessionMaintenance(ctx: {
  config: Pick<EmbeddedServerConfig, 'transcriptSweep'>;
  dataVolumeRoot: string | undefined;
  eventStore: SweepContext['store'];
  sessionSandboxCwd: SweepContext['sessionSandboxCwd'];
  log: SweepContext['log'];
  cleanupAbort: CleanupContext['cleanupAbort'];
  sessionCleanupWorker: CleanupContext['sessionCleanupWorker'];
}) {
  // One-time reconciliation of backend transcripts left by sessions that no longer
  // exist (see `session-artifact-sweep.ts`). Deleting a session now takes its
  // transcripts with it, but everything deleted BEFORE that fix left its files behind
  // and no future delete can reach them — those sessions are gone from the store. It is
  // also the backstop for the one case the delete path cannot cover: a backend switch
  // leaves claude's `subagents/` tree in place (it is the only copy while the session
  // lives), so the tree of a displaced binding is collected once the session it belongs
  // to is deleted and its worktree stops being live.
  //
  // Not awaited into the boot: a start must not wait on a directory walk, and nothing
  // downstream depends on the outcome. What IS handed back on the server object is the
  // store-read phase alone ({@link EmbeddedServer.transcriptSweep}), so a caller that
  // closes immediately — a test, a one-shot CLI run — settles those two queries before
  // `destroy()` without also waiting out the walk behind them. Blocking a SIGTERM on a
  // full walk of a large volume is how a graceful shutdown becomes a SIGKILL, and the
  // walk touches nothing that shutdown tears down. Not on a timer either: the ongoing
  // case is handled at the delete itself, so once per start is enough.
  const sweepMode = ctx.config.transcriptSweep ?? 'on';
  let transcriptSweep: Promise<void> | undefined;
  let transcriptSweepWalk: Promise<SweepResult | undefined> | undefined;
  // Aborted by `close()`, which then waits for the walk to notice. Without it a caller
  // that closes the server and tears its data root down is racing a delete loop over that
  // same root — `main.ts` never sees it because it exits immediately after, but this is a
  // public entry point and not every caller does.
  const sweepAbort = new AbortController();
  /**
   * Started only once the rest of the build has succeeded — see the call site.
   *
   * Nothing here depends on where it is defined; what matters is that the walk is not
   * running while `buildEmbeddedServer` can still throw. A rejected build hands the caller
   * no server, so nobody holds {@link sweepAbort} or the walk promise, and a delete loop
   * over `runners/` would carry on under a boot that failed.
   */
  const startTranscriptSweep = (): void => {
    if (ctx.dataVolumeRoot === undefined || sweepMode === 'off') return;
    const sweep = startOrphanTranscriptSweep({
      runnersRoot: join(ctx.dataVolumeRoot, 'runners'),
      dryRun: sweepMode === 'dry',
      store: ctx.eventStore,
      sessionSandboxCwd: ctx.sessionSandboxCwd,
      signal: sweepAbort.signal,
      log: ctx.log,
    });
    transcriptSweep = sweep.storeReads;
    transcriptSweepWalk = sweep.walk;
  };

  return {
    // The composition root calls this only after every awaited startup step succeeds.
    start(): Pick<EmbeddedServer, 'transcriptSweep' | 'transcriptSweepWalk'> {
      startTranscriptSweep();
      return {
        ...(transcriptSweep !== undefined ? { transcriptSweep } : {}),
        ...(transcriptSweepWalk !== undefined ? { transcriptSweepWalk } : {}),
      };
    },
    async close(): Promise<void> {
      // The sweep, settled before the database goes: a short-lived process (a test, a
      // one-shot run) can otherwise reach `destroy()` with its two store reads still in
      // flight — and, worse, hand control back to a caller that tears down the data root
      // while the walk is still calling `rm` inside it.
      //
      // So the walk is told to stop rather than left to run: it checks between directory
      // entries and between deletes, and returns a partial result the next boot's sweep
      // completes. Waiting for it then costs one in-flight `fs` call, not a full volume
      // walk — blocking a SIGTERM on THAT is how a graceful shutdown becomes a SIGKILL.
      //
      // Bounded even so, and the bound is what makes this a strong guarantee only in the
      // normal case: if the timer wins, `close` resolves with the walk still somewhere
      // inside a call that never came back, so a caller that then removes the data root
      // is back to racing it. That is the wedged-volume case, where every other option —
      // waiting forever, and the SIGKILL that follows — is worse. The store reads are
      // full-table scans issued at boot and get the same treatment: giving up and
      // destroying under them costs at worst one logged query error on a process that is
      // exiting anyway. `ref: false` so the losing timer cannot itself hold the process
      // open for the rest of the window.
      sweepAbort.abort();
      ctx.cleanupAbort.abort();
      ctx.sessionCleanupWorker?.stop();
      await Promise.race([
        Promise.all([transcriptSweep, transcriptSweepWalk, ctx.sessionCleanupWorker?.settled()]),
        delay(SWEEP_SHUTDOWN_WAIT_MS, undefined, { ref: false }),
      ]);
    },
  };
}
