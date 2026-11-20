import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddedRunnerRecovery } from './embedded-runner-wiring.js';

type RecoveryContext = Parameters<typeof startEmbeddedRunnerRecovery>[0];

function context() {
  return {
    config: { runnerSupervisor: true, runnerSupervisorReconcileIntervalMs: 100 },
    provisioner: {
      reconcileRunnerSupervisors: vi.fn<
        NonNullable<RecoveryContext['provisioner']>['reconcileRunnerSupervisors']
      >(async () => undefined),
    },
    eventStore: {
      listProjects: vi.fn<RecoveryContext['eventStore']['listProjects']>(async () => []),
    },
    log: { warn: vi.fn() },
    hasClaudeEgressIdentity: false,
  };
}

const stops: (() => Promise<void>)[] = [];
async function start(ctx: RecoveryContext) {
  const stop = await startEmbeddedRunnerRecovery(ctx);
  stops.push(stop);
  return stop;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.useRealTimers();
});

describe('embedded runner recovery', () => {
  it.each(['no provisioner', 'disabled'] as const)(
    'does not schedule recovery when %s',
    async (mode) => {
      const ctx: RecoveryContext = context();
      if (mode === 'no provisioner') ctx.provisioner = undefined;
      else ctx.config.runnerSupervisor = false;
      await start(ctx);
      expect(ctx.eventStore.listProjects).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('recovers egress identities even when the supervisor flag is disabled', async () => {
    const ctx = context();
    ctx.config.runnerSupervisor = false;
    ctx.hasClaudeEgressIdentity = true;
    await start(ctx);
    expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenCalledOnce();
  });

  it('awaits initial recovery before scheduling and reads all projects afresh on each pass', async () => {
    const ctx = context();
    let release!: () => void;
    ctx.provisioner.reconcileRunnerSupervisors.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const starting = start(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    release();
    const stop = await starting;
    await vi.advanceTimersByTimeAsync(99);
    expect(ctx.eventStore.listProjects).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.eventStore.listProjects).toHaveBeenCalledTimes(2);
    expect(ctx.eventStore.listProjects).toHaveBeenNthCalledWith(1, { includeHidden: true });
    expect(ctx.eventStore.listProjects).toHaveBeenNthCalledWith(2, { includeHidden: true });
    expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenNthCalledWith(2, []);
    await stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctx.eventStore.listProjects).toHaveBeenCalledTimes(2);
  });

  it.each(['listing', 'reconciliation'] as const)(
    'reports an initial %s failure and continues periodic recovery',
    async (mode) => {
      const ctx = context();
      const error = new Error('temporarily unavailable');
      if (mode === 'listing') ctx.eventStore.listProjects.mockRejectedValueOnce(error);
      else ctx.provisioner.reconcileRunnerSupervisors.mockRejectedValueOnce(error);
      await start(ctx);
      expect(ctx.log.warn).toHaveBeenCalledWith(
        { err: error },
        'Runner supervisor reconciliation failed',
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(ctx.eventStore.listProjects).toHaveBeenCalledTimes(2);
      expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenLastCalledWith([]);
    },
  );

  it('drains an active pass on stop without overlapping it or starting another', async () => {
    const ctx = context();
    const stop = await start(ctx);
    let release!: () => void;
    ctx.provisioner.reconcileRunnerSupervisors.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenCalledTimes(2);
    const drained = vi.fn();
    const stopping = stop().then(drained);
    await vi.advanceTimersByTimeAsync(500);
    expect(drained).not.toHaveBeenCalled();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(500);
    expect(drained).toHaveBeenCalledOnce();
    expect(ctx.provisioner.reconcileRunnerSupervisors).toHaveBeenCalledTimes(2);
  });
});
