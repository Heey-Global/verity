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
      await expect(host.begin({ ...request, ...change })).rejects.toThrow('attempt changed');
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
  it('preserves its slot when stop fails or remote execution has not ended', async () => {
    const { host, runtime } = fixture();
    await host.begin(request);
    vi.mocked(runtime.ended).mockResolvedValue(false);
    expect((await host.cancel(request.projectId, request.attemptId)).ended).toBe(false);
    await expect(
      host.begin({ ...request, attemptId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('owns the host slot');
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
    await expect(host.begin(request)).rejects.toThrow('startup failed');
    expect(calls.slice(-4)).toEqual(['persist', 'deny', 'stop', 'persist']);
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
    await expect(host.heartbeat('other', request.attemptId)).rejects.toThrow('Unknown');
    await expect(host.status('other', request.attemptId)).rejects.toThrow('Unknown');
    await expect(host.cancel('other', request.attemptId)).rejects.toThrow('Unknown');
    expect(runtime.stop).not.toHaveBeenCalled();
  });
  it('restoration fences old work instead of resuming its access', async () => {
    const { host, runtime, calls } = fixture();
    await host.restore({ request, phase: 'running', ended: false });
    expect(calls).toEqual(['persist', 'deny', 'stop', 'persist']);
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
