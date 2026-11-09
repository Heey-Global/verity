import { describe, expect, it, vi } from 'vitest';
import {
  ProtectedBuildHost,
  protectedBuildRequest,
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
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    vi.mocked(runtime.ended).mockResolvedValue(false);
    await host.restore({ request, phase: 'running', ended: true, cleaned: true });
    expect(await host.execute({ operation: 'slot' })).toMatchObject({ idle: false });
    await expect(host.begin(next)).rejects.toThrow('slot_busy');
    expect(receipts.save).not.toHaveBeenCalled();
    expect(runtime.remove).not.toHaveBeenCalled();
    vi.mocked(runtime.ended).mockResolvedValue(true);
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('cleanup unavailable'));
    await host.revalidate();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
      cleaned: false,
    });
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
    expect(await host.begin(next)).toMatchObject({ phase: 'running', ended: false });
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
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    await host.begin(request);
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    await expect(host.cancel(request.projectId, request.attemptId)).rejects.toThrow(
      'cleanup_failed',
    );
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({ ended: true });
    expect(await host.cancel(request.projectId, request.attemptId)).toMatchObject({ ended: true });
    expect(receipts.save).toHaveBeenCalledTimes(1);
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(2);
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      cleaned: true,
    });
  });
  it('blocks replacement until ended resources can be removed', async () => {
    const { runtime, persist } = fixture();
    const host = new ProtectedBuildHost(runtime, persist);
    await host.begin(request);
    vi.mocked(runtime.remove).mockRejectedValue(new Error('unavailable'));
    await expect(host.cancel(request.projectId, request.attemptId)).rejects.toThrow(
      'cleanup_failed',
    );
    await expect(host.begin(next)).rejects.toThrow('cleanup_failed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
    vi.mocked(runtime.remove).mockResolvedValue(undefined);
    await host.begin(next);
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
    const host = new ProtectedBuildHost(runtime, persist, undefined, journal());
    await host.begin(request);
    vi.mocked(runtime.status).mockResolvedValueOnce('succeeded');
    vi.mocked(runtime.remove).mockRejectedValueOnce(new Error('daemon unavailable'));
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'succeeded',
      ended: true,
    });
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
    await host.begin(next);
    expect(receipts.save).toHaveBeenCalled();
    expect(await host.status(request.projectId, request.attemptId)).toMatchObject({
      phase: 'failed',
      ended: true,
    });
  });
  it('maps receipt persistence failures to a retryable cleanup refusal', async () => {
    const { runtime, persist } = fixture();
    const receipts = journal();
    const host = new ProtectedBuildHost(runtime, persist, undefined, receipts);
    await host.begin(request);
    receipts.save.mockRejectedValueOnce(new Error('ENOSPC /private/receipts/path'));
    const refused = await host
      .cancel(request.projectId, request.attemptId)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ reason: 'cleanup_failed' });
    expect(runtime.remove).not.toHaveBeenCalled();
    await host.revalidate();
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(await host.begin(next)).toMatchObject({ phase: 'running' });
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
