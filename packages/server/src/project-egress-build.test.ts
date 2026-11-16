import { describe, expect, it, vi } from 'vitest';
import { ProtectedBuildStageError } from './project-egress-build-error.js';
import { ProjectFenceTransactionError } from './project-egress-fence.js';
import {
  ProtectedBuildHost,
  protectedBuildRequest,
  type ProtectedBuildEvent,
  type ProtectedBuildRecord,
  type ProtectedBuildRuntime,
} from './project-egress-build.js';
const request = {
  projectId: 'project-one',
  attemptId: '11111111-1111-4111-8111-111111111111',
  snapshot: 'attempt-abc/verity-build-def',
  image: 'verity-devc-example-repo:0123456789ab',
  noCache: false,
};
function fixture(now?: () => number) {
  const calls: string[] = [];
  const runtime: ProtectedBuildRuntime = {
    ready: vi.fn(async () => true),
    prepare: vi.fn(async () => {
      calls.push('prepare');
    }),
    renew: vi.fn(async () => {
      calls.push('renew');
    }),
    start: vi.fn(async () => {
      calls.push('start');
    }),
    status: vi.fn(async () => 'running' as const),
    deny: vi.fn(async () => {
      calls.push('deny');
    }),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
    ended: vi.fn(async () => true),
    remove: vi.fn(async () => {
      calls.push('remove');
    }),
  };
  const persist = vi.fn(async (_record: ProtectedBuildRecord | undefined) => {
    void _record;
    calls.push('persist');
  });
  return { host: new ProtectedBuildHost(runtime, persist, now), runtime, persist, calls };
}
describe('protected build ownership', () => {
  it('persists ownership and establishes inspected packet authority before executing project input', async () => {
    const { host, calls } = fixture();
    expect((await host.begin(request)).phase).toBe('running');
    expect(calls).toEqual(['persist', 'prepare', 'renew', 'start', 'persist']);
  });
  it('contains an abandoned worker without renewing its packet authority', async () => {
    let time = 0;
    const { host, runtime } = fixture(() => time);
    await host.begin(request);
    time = 5001;
    await host.revalidate();
    expect(runtime.renew).toHaveBeenCalledTimes(1);
    expect(runtime.deny).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
    });
  });
  it('collects terminal orphaned work so another attempt can own the slot', async () => {
    const { host, runtime } = fixture(() => 0);
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValue('succeeded');
    await host.revalidate();
    await host.begin({ ...request, attemptId: '22222222-2222-4222-8222-222222222222' });
    expect(runtime.remove).toHaveBeenCalledTimes(1);
  });
  it('rejects extra command fields, arbitrary paths and invalid identities', () => {
    for (const changed of [
      { command: 'id' },
      { snapshot: '../../etc' },
      { projectId: '../other' },
      { image: 'busybox:latest' },
      { attemptId: 'x' },
    ])
      expect(() => protectedBuildRequest.parse({ ...request, ...changed })).toThrow();
  });
  it('a duplicate request is idempotent but cannot change project, snapshot or rebuild semantics', async () => {
    const { host, runtime } = fixture();
    const original = await host.begin(request);
    expect(await host.begin(request)).toEqual(original);
    for (const change of [
      { projectId: 'other' },
      { snapshot: 'attempt-a/verity-build-b' },
      { noCache: true },
    ])
      await expect(host.begin({ ...request, ...change })).rejects.toThrow('attempt_changed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
  it('preserves its slot when stop fails or remote execution has not ended', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    vi.mocked(runtime.ended).mockResolvedValue(false);
    expect((await host.cancel(request.projectId, request.attemptId)).ended).toBe(false);
    await expect(
      host.begin({ ...request, attemptId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('slot_busy');
    expect(runtime.remove).not.toHaveBeenCalled();
  });
  it('revokes and stops after failed renewal, including when persistence fails', async () => {
    const { host, runtime, persist, calls } = fixture();
    await host.begin(request);
    calls.length = 0;
    vi.mocked(runtime.renew).mockRejectedValue(Error('authority disappeared'));
    persist.mockRejectedValue(Error('disk full'));
    await expect(host.heartbeat(request.projectId, request.attemptId)).rejects.toThrow();
    expect(calls).toContain('deny');
    expect(calls).toContain('stop');
    expect(calls.indexOf('deny')).toBeLessThan(calls.indexOf('stop'));
  });
  it('contains a partially started attempt and never falls back to another runner', async () => {
    const { host, runtime, calls } = fixture();
    vi.mocked(runtime.start).mockRejectedValue(Error('startup failed'));
    await expect(host.begin(request)).rejects.toThrow('launch_failed');
    expect(calls.slice(-6)).toEqual(['persist', 'deny', 'stop', 'persist', 'remove', 'persist']);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
  it('reads do not renew admission and successful CLI exit does not imply remote termination', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    await host.status(request.projectId, request.attemptId);
    expect(runtime.renew).toHaveBeenCalledTimes(1);
    vi.mocked(runtime.status).mockResolvedValue('succeeded');
    vi.mocked(runtime.ended).mockResolvedValue(false);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'stopping',
      ended: false,
    });
  });
  it('rejects cross-project heartbeat, status and cancellation', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    await expect(host.heartbeat('other', request.attemptId)).rejects.toThrow('unknown_attempt');
    await expect(host.status('other', request.attemptId)).rejects.toThrow('unknown_attempt');
    await expect(host.cancel('other', request.attemptId)).rejects.toThrow('unknown_attempt');
    expect(runtime.stop).not.toHaveBeenCalled();
  });
  it('restoration fences old work instead of resuming its access', async () => {
    const { host, runtime, calls } = fixture();
    await host.restore({ request, phase: 'running', ended: false });
    expect(calls).toEqual(['persist', 'deny', 'stop', 'persist', 'remove', 'persist']);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.renew).not.toHaveBeenCalled();
  });
  it('shutdown closes future admission and contains the active attempt', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    await host.close();
    await expect(host.begin(request)).rejects.toThrow('closed');
    expect(runtime.deny).toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalled();
  });
});

describe('protected build terminal cleanup and receipts', () => {
  const next = { ...request, attemptId: '22222222-2222-4222-8222-222222222222' };
  const later = { ...request, attemptId: '33333333-3333-4333-8333-333333333333' };
  /** Cleanup retries back off; tests advance this clock past the retry delay. */
  function clock() {
    let value = 0;
    return { now: () => value, advance: (ms: number) => void (value += ms) };
  }
  const refusal = (value: typeof request) => ({
    request: value,
    phase: 'failed',
    ended: true,
    cleaned: true,
  });
  function journal() {
    const values = new Map<string, ProtectedBuildRecord>();
    return {
      save: vi.fn(async (record: ProtectedBuildRecord) => {
        if (!record.ended || !['succeeded', 'failed'].includes(record.phase))
          throw new Error('Protected build receipt is not terminal');
        values.set(record.request.projectId + record.request.attemptId, structuredClone(record));
      }),
      load: vi.fn(async (projectId: string, attemptId: string) =>
        values.get(projectId + attemptId),
      ),
    };
  }
  it.each(['preparing', 'running', 'stopping'] as const)(
    'contains an interrupted %s record before saving its terminal receipt on startup',
    async (phase) => {
      const { runtime, persist, calls } = fixture();
      const receipts = journal();
      const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
      await host.restore({ request, phase, ended: true });
      expect(calls).toEqual(['persist', 'deny', 'stop', 'persist', 'remove', 'persist']);
      expect(receipts.save).toHaveBeenCalledWith({
        request,
        phase: 'failed',
        ended: true,
        cleaned: false,
      });
      const recovered = { request, phase: 'failed', ended: true, cleaned: true };
      expect(await host.status(request.projectId, request.attemptId)).toEqual(recovered);
      const restarted = new ProtectedBuildHost(runtime, persist, undefined, receipts);
      await restarted.restore(recovered);
      await restarted.revalidate();
      expect(runtime.remove).toHaveBeenCalledTimes(1);
      expect(runtime.start).not.toHaveBeenCalled();
      expect(runtime.renew).not.toHaveBeenCalled();
      expect(await restarted.begin(next)).toMatchObject({ phase: 'running', ended: false });
    },
  );
  it('retains an interrupted startup allocation until termination and cleanup are proven', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const time = clock();
    const host = new ProtectedBuildHost(runtime, persist, time.now, receipts, () => undefined);
    vi.mocked(runtime.ended).mockResolvedValue(false);
    await host.restore({ request, phase: 'running', ended: true, cleaned: true });
    expect(await host.execute({ operation: 'slot' })).toMatchObject({ idle: false });
    await expect(host.begin(next)).rejects.toThrow('slot_busy');
    // The refused attempt never started; only it receives a terminal receipt.
    expect(receipts.save).toHaveBeenCalledExactlyOnceWith(refusal(next));
    expect(runtime.remove).not.toHaveBeenCalled();
    vi.mocked(runtime.ended).mockResolvedValue(true);
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('cleanup unavailable'));
    await host.revalidate();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
      cleaned: false,
    });
    time.advance(1000);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
    expect(await host.begin(later)).toMatchObject({ phase: 'running', ended: false });
  });
  it.each(['succeeded', 'failed'] as const)(
    'preserves a proven %s outcome during startup cleanup',
    async (phase) => {
      const { runtime, persist } = fixture();
      const receipts = journal();
      const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
      await host.restore({ request, phase, ended: true });
      expect(receipts.save).toHaveBeenCalledWith({ request, phase, ended: true });
      expect(await host.status(request.projectId, request.attemptId)).toEqual({
        request,
        phase,
        ended: true,
        cleaned: true,
      });
      expect(runtime.deny).not.toHaveBeenCalled();
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.remove).toHaveBeenCalledExactlyOnceWith(request);
    },
  );
  it.each(['prepare', 'renew', 'start'] as const)(
    'removes a failed %s attempt before another begin',
    async (step) => {
      const { runtime, persist } = fixture();
      const host = new ProtectedBuildHost(runtime, persist);
      vi.mocked(runtime[step]).mockRejectedValueOnce(new Error('partial preparation failed'));
      await expect(host.begin(request)).rejects.toThrow(
        step === 'prepare' ? 'prepare_failed' : step === 'renew' ? 'renew_failed' : 'launch_failed',
      );
      expect(runtime.remove).toHaveBeenCalledWith(request);
      expect(await host.begin(next)).toMatchObject({ phase: 'running', ended: false });
      expect(runtime.remove).toHaveBeenCalledTimes(1);
    },
  );
  it('retries failed cleanup in the sweep while retaining termination proof', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const time = clock();
    const host = new ProtectedBuildHost(runtime, persist, time.now, receipts, () => undefined);
    await host.begin(request);
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    // Termination is proven, so cancel confirms it; removal is the sweep's retry.
    const cancelled = await host.cancel(request.projectId, request.attemptId);
    expect(cancelled).toMatchObject({ phase: 'failed', ended: true });
    expect(cancelled.cleaned).not.toBe(true);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({ ended: true });
    expect(await host.cancel(request.projectId, request.attemptId)).toMatchObject({ ended: true });
    expect(receipts.save).toHaveBeenCalledTimes(1);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    time.advance(1000);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      cleaned: true,
    });
  });
  it('blocks replacement until ended resources can be removed', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts, () => undefined);
    await host.begin(request);
    vi.mocked(runtime.remove).mockRejectedValue(new Error('unavailable'));
    await host.cancel(request.projectId, request.attemptId);
    await expect(host.begin(next)).rejects.toThrow('cleanup_failed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
    // The refused attempt is answered from its receipt; it can never start later.
    for (const operation of ['status', 'cancel'] as const)
      expect(await host[operation](next.projectId, next.attemptId)).toEqual(refusal(next));
    vi.mocked(runtime.remove).mockResolvedValue(undefined);
    expect(await host.begin(next)).toEqual(refusal(next));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    await host.begin(later);
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });
  it('restores and cleans an ended partially prepared previous attempt before begin', async () => {
    const { runtime, persist } = fixture();
    const host = new ProtectedBuildHost(runtime, persist);
    await host.restore({ request, phase: 'failed', ended: true });
    expect(runtime.remove).toHaveBeenCalledWith(request);
    expect(runtime.stop).not.toHaveBeenCalled();
    await host.begin(next);
    expect(runtime.remove).toHaveBeenCalledTimes(1);
  });
  it('preserves terminal status across later builds and host restart', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValueOnce('succeeded');
    await host.status(request.projectId, request.attemptId);
    await host.begin(next);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      request,
      phase: 'succeeded',
      ended: true,
    });
    const restored = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    expect(await restored.cancel(request.projectId, request.attemptId)).toMatchObject({
      phase: 'succeeded',
      ended: true,
    });
    await expect(restored.status('other', request.attemptId)).rejects.toThrow('unknown_attempt');
    expect(await restored.begin(request)).toMatchObject({ phase: 'succeeded', ended: true });
    await expect(restored.begin({ ...request, noCache: true })).rejects.toThrow('attempt_changed');
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });
  it('does not rewrite a cleaned successful record as failed on restoration', async () => {
    const { runtime, persist } = fixture();
    const host = new ProtectedBuildHost(runtime, persist);
    await host.restore({ request, phase: 'succeeded', ended: true, cleaned: true });
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'succeeded',
    });
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
  });
  it('reports a succeeded build as succeeded when host cleanup fails afterwards', async () => {
    // A cleanup hiccup after proven termination must not turn a built image into a
    // failed build; the sweep owns the removal retry.
    const { runtime, persist } = fixture();
    const time = clock();
    const host = new ProtectedBuildHost(runtime, persist, time.now, journal(), () => undefined);
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValueOnce('succeeded');
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'succeeded',
      ended: true,
    });
    time.advance(1000);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      cleaned: true,
    });
  });
  it('refuses replacement after a status-path cleanup failure until removal succeeds', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValueOnce('failed');
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({ ended: true });
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(host.begin(next)).rejects.toThrow('cleanup_failed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
    await host.begin(later);
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(receipts.save).toHaveBeenCalled();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
    });
  });
  it('maps receipt persistence failures to a retryable cleanup refusal', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const time = clock();
    const host = new ProtectedBuildHost(runtime, persist, time.now, receipts, () => undefined);
    await host.begin(request);
    receipts.save.mockRejectedValueOnce(new Error('ENOSPC /private/receipts/path'));
    // The live record still proves termination; the missing receipt only keeps
    // cleanup pending, and removal never runs before the receipt is durable.
    const cancelled = await host.cancel(request.projectId, request.attemptId);
    expect(cancelled).toMatchObject({ ended: true });
    expect(cancelled.cleaned).not.toBe(true);
    expect(runtime.remove).not.toHaveBeenCalled();
    time.advance(1000);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(await host.begin(next)).toMatchObject({ phase: 'running' });
  });
  describe('a previous attempt whose removal keeps failing', () => {
    // Observed: begin failed with cleanup_failed because the previous attempt's
    // removal failed in its fence denial; the following cancel answered
    // unknown_attempt, so the Server kept the new attempt's storage reservation
    // although nothing had started for it.
    const fenceFailure = () =>
      new ProtectedBuildStageError('authority.deny', {
        cause: new ProjectFenceTransactionError({
          exitCode: 1,
          signal: null,
          durationMs: 12,
          timedOut: false,
          diagnostics: ['line 1: No such file or directory'],
          statements: ['delete table inet verity_egress_0123'],
          stderrBytes: 120,
        }),
      });
    function failing() {
      const f = fixture();
      const receipts = journal();
      const events: ProtectedBuildEvent[] = [];
      const time = clock();
      const host = new ProtectedBuildHost(f.runtime, f.persist, time.now, receipts, (event) =>
        events.push(event),
      );
      vi.mocked(f.runtime.remove).mockRejectedValue(fenceFailure());
      return { ...f, receipts, events, time, host };
    }
    it('confirms that a refused begin never started, for cancel and status', async () => {
      const { host, runtime, events } = failing();
      await host.begin(request);
      await host.cancel(request.projectId, request.attemptId);
      await expect(host.begin(next)).rejects.toThrow('cleanup_failed');
      expect(runtime.prepare).toHaveBeenCalledTimes(1);
      expect(await host.cancel(next.projectId, next.attemptId)).toEqual(refusal(next));
      expect(await host.status(next.projectId, next.attemptId)).toEqual(refusal(next));
      // The previous attempt keeps its slot and its own termination proof.
      expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
        phase: 'failed',
        ended: true,
      });
      expect(await host.execute({ operation: 'slot' })).toEqual({ version: 1, idle: false });
      expect(events.find((event) => event.event === 'begin_refused')).toMatchObject({
        attemptId: next.attemptId,
        blockingAttemptId: request.attemptId,
        reason: 'cleanup_failed',
        failure: {
          stage: 'authority.deny',
          evidence: [
            expect.objectContaining({
              exitCode: 1,
              statements: ['delete table inet verity_egress_0123'],
            }),
          ],
        },
      });
    });
    it('correlates each failure to its attempt and stage and backs off sweep retries', async () => {
      const { host, runtime, events, time } = failing();
      await host.begin(request);
      await host.cancel(request.projectId, request.attemptId);
      for (let i = 0; i < 50; i++) await host.revalidate();
      expect(runtime.remove).toHaveBeenCalledTimes(1);
      const delays: number[] = [];
      for (let i = 0; i < 12; i++) {
        time.advance(10 * 60_000);
        await host.revalidate();
        delays.push(events.at(-1)!.retryInMs!);
      }
      expect(runtime.remove).toHaveBeenCalledTimes(13);
      expect(delays.slice(0, 3)).toEqual([2000, 4000, 8000]);
      expect(Math.max(...delays)).toBe(5 * 60_000);
      expect(events.at(-1)).toMatchObject({
        event: 'cleanup_failed',
        attemptId: request.attemptId,
        operation: 'revalidate',
        failures: 13,
        failure: { stage: 'authority.deny' },
      });
      vi.mocked(runtime.remove).mockResolvedValue(undefined);
      time.advance(10 * 60_000);
      await host.revalidate();
      expect(events.at(-1)).toMatchObject({ event: 'cleanup_recovered', failures: 13 });
      expect(await host.begin(later)).toMatchObject({ phase: 'running' });
    });
    it('starts after a restart and recovers once removal succeeds', async () => {
      const { runtime, persist, receipts, events, time } = failing();
      const restarted = new ProtectedBuildHost(runtime, persist, time.now, receipts, (event) =>
        events.push(event),
      );
      await expect(
        restarted.restore({ request, phase: 'failed', ended: true }),
      ).resolves.toBeUndefined();
      expect(events.at(-1)).toMatchObject({ event: 'cleanup_failed', operation: 'restore' });
      // An ended previous record proves that every earlier attempt ended.
      expect(await restarted.execute({ operation: 'slot' })).toEqual({ version: 1, idle: true });
      vi.mocked(runtime.remove).mockResolvedValue(undefined);
      expect(await restarted.begin(next)).toMatchObject({ phase: 'running' });
      expect(await restarted.status(request.projectId, request.attemptId)).toMatchObject({
        phase: 'failed',
        ended: true,
      });
    });
    it('keeps a restart fail-closed when an unended record cannot be contained', async () => {
      const { runtime, persist } = fixture();
      vi.mocked(runtime.stop).mockRejectedValue(new Error('systemd unavailable'));
      vi.mocked(runtime.ended).mockResolvedValue(false);
      const host = new ProtectedBuildHost(runtime, persist, undefined, journal(), () => undefined);
      await expect(host.restore({ request, phase: 'running', ended: false })).rejects.toThrow(
        'containment_failed',
      );
      expect(await host.execute({ operation: 'slot' })).toEqual({ version: 1, idle: false });
    });
  });
  it('reports the slot idle only while no build with unproven termination holds it', async () => {
    const { runtime, persist } = fixture();
    const host = new ProtectedBuildHost(runtime, persist);
    const slot = async () => host.execute({ operation: 'slot' });
    // Before persisted state is loaded, an empty slot proves nothing about earlier builds.
    expect(await slot()).toEqual({ version: 1, idle: false });
    await host.restore({ request: next, phase: 'failed', ended: true, cleaned: true });
    expect(await slot()).toEqual({ version: 1, idle: true });
    await host.begin(request);
    expect(await slot()).toEqual({ version: 1, idle: false });
    vi.mocked(runtime.ended).mockResolvedValueOnce(false);
    await host.cancel(request.projectId, request.attemptId).catch(() => undefined);
    expect(await slot()).toEqual({ version: 1, idle: false });
    await host.revalidate();
    expect(await slot()).toEqual({ version: 1, idle: true });
  });
  it('never reports idle when no persisted state existed at startup', async () => {
    // Missing state (fresh or wiped directory) cannot prove that builds from before
    // it ended, even after a new build on this host has ended.
    const { runtime, persist } = fixture();
    const host = new ProtectedBuildHost(runtime, persist);
    await host.restore(undefined);
    expect(await host.execute({ operation: 'slot' })).toEqual({ version: 1, idle: false });
    await host.begin(request);
    await host.cancel(request.projectId, request.attemptId);
    expect(await host.execute({ operation: 'slot' })).toEqual({ version: 1, idle: false });
  });
  it('refuses mismatched or nonterminal durable receipts', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    receipts.load.mockResolvedValue({ request: next, phase: 'failed', ended: true });
    await expect(host.status(request.projectId, request.attemptId)).rejects.toThrow(
      'unknown_attempt',
    );
    receipts.load.mockResolvedValue({ request, phase: 'running', ended: false });
    await expect(host.cancel(request.projectId, request.attemptId)).rejects.toThrow(
      'unknown_attempt',
    );
    expect(runtime.remove).not.toHaveBeenCalled();
  });
});

describe('bounded containment recovery', () => {
  it('retries a failed stop on sweeps with bounded backoff and no new authority', async () => {
    let time = 0;
    const { host, runtime } = fixture(() => time);
    await host.begin(request);
    vi.mocked(runtime.ended).mockResolvedValue(false);
    vi.mocked(runtime.stop).mockRejectedValueOnce(new Error('transient stop failure'));
    await expect(host.cancel(request.projectId, request.attemptId)).rejects.toThrow(
      'containment_failed',
    );
    for (let attempt = 0; attempt < 12; attempt++) {
      const count = vi.mocked(runtime.stop).mock.calls.length;
      await host.revalidate();
      expect(runtime.stop).toHaveBeenCalledTimes(count);
      const delay = Math.min(300_000, 1000 * 2 ** attempt);
      time += delay;
      await host.revalidate();
      expect(runtime.stop).toHaveBeenCalledTimes(count + 1);
      expect((await host.status(request.projectId, request.attemptId)).ended).toBe(false);
      expect(runtime.remove).not.toHaveBeenCalled();
    }
    vi.mocked(runtime.stop).mockImplementation(async () => {
      vi.mocked(runtime.ended).mockResolvedValue(true);
    });
    time += 300_000;
    await host.revalidate();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      ended: true,
      phase: 'failed',
      cleaned: true,
    });
    expect(runtime.renew).toHaveBeenCalledTimes(1);
  });

  it('keeps admission and receipts protected while stop and termination proof keep failing', async () => {
    let time = 0;
    const { runtime, persist } = fixture(() => time);
    const receipts = { save: vi.fn(async () => {}), load: vi.fn(async () => undefined) };
    const host = new ProtectedBuildHost(
      runtime,
      persist,
      () => time,
      receipts,
      () => {},
    );
    await host.begin(request);
    vi.mocked(runtime.stop).mockRejectedValue(new Error('stop unavailable'));
    vi.mocked(runtime.ended).mockRejectedValue(new Error('proof unavailable'));
    await expect(host.cancel(request.projectId, request.attemptId)).rejects.toThrow(
      'containment_failed',
    );
    time = 1000;
    await expect(host.revalidate()).rejects.toThrow('containment_failed');
    expect(receipts.save).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
    expect(await host.execute({ operation: 'slot' })).toMatchObject({ idle: false });
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'stopping',
      ended: false,
    });
  });

  it('publishes terminal proof despite denial failure while keeping cleanup pending', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValue('succeeded');
    vi.mocked(runtime.deny).mockRejectedValue(new Error('nft unavailable'));
    vi.mocked(runtime.remove).mockRejectedValue(new Error('cleanup denied'));
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'succeeded',
      ended: true,
    });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.ended).toHaveBeenCalledOnce();
    expect(runtime.remove).toHaveBeenCalledOnce();
  });

  it('retries an interrupted stop immediately after restart without renewing authority', async () => {
    const { runtime, persist } = fixture();
    vi.mocked(runtime.deny).mockRejectedValue(new Error('nft unavailable'));
    vi.mocked(runtime.remove).mockRejectedValue(new Error('cleanup pending'));
    const host = new ProtectedBuildHost(
      runtime,
      persist,
      () => 0,
      undefined,
      () => {},
    );
    await host.restore({ request, phase: 'stopping', ended: false });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.renew).not.toHaveBeenCalled();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
    });
  });
});
