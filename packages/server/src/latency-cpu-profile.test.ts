import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLatencyCpuProfiler, type LatencyCpuProfilerOptions } from './latency-cpu-profile.js';

afterEach(() => vi.useRealTimers());
function setup(overrides: Partial<LatencyCpuProfilerOptions> = {}) {
  vi.useFakeTimers();
  const post = vi.fn(async (method: string): Promise<{ profile?: unknown }> =>
    method === 'Profiler.stop' ? { profile: { nodes: [] } } : {},
  );
  const disconnect = vi.fn();
  const connect = vi.fn();
  const createSession = vi.fn(() => ({ post, disconnect, connect }));
  const log = vi.fn();
  const mkdir = vi.fn().mockResolvedValue(undefined);
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const profiler = createLatencyCpuProfiler({
    directory: '/private/profiles',
    createSession,
    log,
    mkdir,
    writeFile,
    ...overrides,
  });
  return { profiler, post, disconnect, connect, createSession, log, mkdir, writeFile };
}

describe('bounded latency CPU profiles', () => {
  it('is disabled without a directory and ignores small delays', async () => {
    const disabled = setup({ directory: undefined });
    disabled.profiler.trigger(2_000);
    await disabled.profiler.close();
    expect(disabled.createSession).not.toHaveBeenCalled();
    const small = setup();
    small.profiler.trigger(499);
    await small.profiler.close();
    expect(small.createSession).not.toHaveBeenCalled();
  });
  it('captures one private file and enforces concurrency and cooldown', async () => {
    const s = setup();
    s.profiler.trigger(500);
    s.profiler.trigger(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.createSession).toHaveBeenCalledTimes(1);
    expect(s.mkdir).toHaveBeenCalledWith('/private/profiles', { recursive: true, mode: 0o700 });
    expect(s.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.cpuprofile$/),
      '{"nodes":[]}',
      { mode: 0o600, flag: 'wx' },
    );
    expect(s.post.mock.calls.map(([method]) => method)).toEqual([
      'Profiler.enable',
      'Profiler.start',
      'Profiler.stop',
      'Profiler.disable',
    ]);
    expect(s.disconnect).toHaveBeenCalledOnce();
    s.profiler.trigger(1_000);
    expect(s.createSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    s.profiler.trigger(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.createSession).toHaveBeenCalledTimes(2);
    await s.profiler.close();
  });
  it('stops before disconnecting on close and does not write a partial capture', async () => {
    const s = setup();
    s.profiler.trigger(700);
    await vi.advanceTimersByTimeAsync(1);
    await s.profiler.close();
    expect(s.post).toHaveBeenCalledWith('Profiler.stop');
    expect(s.disconnect).toHaveBeenCalledOnce();
    expect(s.writeFile).not.toHaveBeenCalled();
    expect(s.post.mock.invocationCallOrder.at(-1)).toBeLessThan(
      s.disconnect.mock.invocationCallOrder[0]!,
    );
    s.profiler.trigger(1_000);
    expect(s.createSession).toHaveBeenCalledTimes(1);
  });
  it.each(['Profiler.enable', 'Profiler.start', 'Profiler.stop'])(
    'cleans up after %s fails without logging arbitrary error content',
    async (failure) => {
      const s = setup();
      s.post.mockImplementation(async (method) => {
        if (method === failure) throw new Error('private secret');
        return {};
      });
      s.profiler.trigger(700);
      await vi.advanceTimersByTimeAsync(5_000);
      await s.profiler.close();
      expect(s.disconnect).toHaveBeenCalledOnce();
      expect(s.log).toHaveBeenCalledWith({
        event: 'failed',
        stage: failure === 'Profiler.stop' ? 'stop' : 'start',
      });
      expect(JSON.stringify(s.log.mock.calls)).not.toContain('private secret');
    },
  );
  it('caps failed attempts at three per process', async () => {
    const s = setup();
    s.writeFile.mockRejectedValue(new Error('failed'));
    for (let attempt = 0; attempt < 5; attempt++) {
      s.profiler.trigger(700);
      await vi.advanceTimersByTimeAsync(305_000);
    }
    expect(s.createSession).toHaveBeenCalledTimes(3);
    await s.profiler.close();
  });
  it('rejects profiles above the file size cap', async () => {
    const s = setup();
    s.post.mockResolvedValue({ profile: { nodes: 'x'.repeat(8 * 1024 * 1024) } });
    s.profiler.trigger(700);
    await vi.advanceTimersByTimeAsync(5_000);
    await s.profiler.close();
    expect(s.writeFile).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith({ event: 'failed', stage: 'size' });
  });
  it('cleans up after file output fails', async () => {
    const s = setup();
    s.writeFile.mockRejectedValue(new Error('private secret'));
    s.profiler.trigger(700);
    await vi.advanceTimersByTimeAsync(5_000);
    await s.profiler.close();
    expect(s.log).toHaveBeenCalledWith({ event: 'failed', stage: 'write' });
    expect(s.disconnect).toHaveBeenCalledOnce();
  });
});
