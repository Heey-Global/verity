import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { setImmediate } from 'node:timers';
import { createEmbeddedSessionMaintenance } from './embedded-session-maintenance.js';
import { startOrphanTranscriptSweep } from './orphan-transcript-sweep.js';
import { SWEEP_SHUTDOWN_WAIT_MS } from './embedded-support.js';

vi.mock('./orphan-transcript-sweep.js', () => ({ startOrphanTranscriptSweep: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));

type Context = Parameters<typeof createEmbeddedSessionMaintenance>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const reads = deferred<void>();
  const walk = deferred<undefined>();
  const cleanup = deferred<void>();
  const deadline = deferred<void>();
  vi.mocked(startOrphanTranscriptSweep).mockReturnValue({
    storeReads: reads.promise,
    walk: walk.promise,
  });
  vi.mocked(delay).mockReturnValue(deadline.promise);
  const ctx: Context = {
    config: {},
    dataVolumeRoot: '/volume',
    eventStore: {
      listLiveBackendSessionIds: vi.fn(),
      listSessionWorktrees: vi.fn(),
    },
    sessionSandboxCwd: (worktree) => worktree,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cleanupAbort: new AbortController(),
    sessionCleanupWorker: {
      start: vi.fn(),
      run: vi.fn(),
      stop: vi.fn(),
      settled: () => cleanup.promise,
    },
  };
  return { ctx, reads, walk, cleanup, deadline };
}

describe('embedded session maintenance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does no collection until successful startup explicitly starts it', () => {
    const { ctx, reads, walk } = fixture();
    const maintenance = createEmbeddedSessionMaintenance(ctx);
    expect(startOrphanTranscriptSweep).not.toHaveBeenCalled();
    expect(maintenance.start()).toEqual({
      transcriptSweep: reads.promise,
      transcriptSweepWalk: walk.promise,
    });
    expect(startOrphanTranscriptSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        runnersRoot: '/volume/runners',
        dryRun: false,
        store: ctx.eventStore,
        sessionSandboxCwd: ctx.sessionSandboxCwd,
        log: ctx.log,
      }),
    );
  });

  it.each(['off', 'missing-volume', 'dry'] as const)('preserves %s startup behavior', (mode) => {
    const { ctx } = fixture();
    if (mode === 'missing-volume') ctx.dataVolumeRoot = undefined;
    else ctx.config.transcriptSweep = mode;
    const exposed = createEmbeddedSessionMaintenance(ctx).start();
    if (mode === 'dry') {
      expect(startOrphanTranscriptSweep).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
      expect(exposed.transcriptSweepWalk).toBeDefined();
    } else {
      expect(exposed).toEqual({});
      expect(startOrphanTranscriptSweep).not.toHaveBeenCalled();
    }
  });

  it.each(['reads', 'walk', 'cleanup'] as const)(
    'aborts in order and waits for %s before close settles',
    async (held) => {
      const { ctx, reads, walk, cleanup } = fixture();
      const order: string[] = [];
      const maintenance = createEmbeddedSessionMaintenance(ctx);
      maintenance.start();
      const sweepSignal = vi.mocked(startOrphanTranscriptSweep).mock.calls[0]![0].signal;
      sweepSignal.addEventListener('abort', () => order.push('sweep abort'));
      ctx.cleanupAbort.signal.addEventListener('abort', () => order.push('cleanup abort'));
      vi.mocked(ctx.sessionCleanupWorker!.stop).mockImplementation(() => order.push('worker stop'));
      const closed = vi.fn();
      const closing = maintenance.close().then(closed);
      expect(order).toEqual(['sweep abort', 'cleanup abort', 'worker stop']);
      const phases = { reads, walk, cleanup };
      for (const [name, phase] of Object.entries(phases)) {
        if (name !== held) phase.resolve(undefined);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).not.toHaveBeenCalled();
      phases[held].resolve(undefined);
      await closing;
      expect(closed).toHaveBeenCalledOnce();
    },
  );

  it('bounds shutdown even when collection and cleanup never settle, without keeping the process alive', async () => {
    const { ctx, deadline } = fixture();
    const maintenance = createEmbeddedSessionMaintenance(ctx);
    maintenance.start();
    const closing = maintenance.close();
    expect(delay).toHaveBeenCalledWith(SWEEP_SHUTDOWN_WAIT_MS, undefined, { ref: false });
    deadline.resolve(undefined);
    await closing;
    expect(ctx.cleanupAbort.signal.aborted).toBe(true);
    expect(ctx.sessionCleanupWorker!.stop).toHaveBeenCalledOnce();
  });
});
