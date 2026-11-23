import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  createDockerExecDiagnostics,
  getDockerExecDiagnostics,
} from './docker-exec-diagnostics.js';
import { installEmbeddedDockerExecDiagnostics } from './embedded-runtime-diagnostics.js';

vi.mock('./docker-exec-diagnostics.js', async (original) => {
  const actual = await original<typeof import('./docker-exec-diagnostics.js')>();
  return { ...actual, getDockerExecDiagnostics: vi.fn() };
});

it('reports only changed activity counters, unrefs the timer, and stops sampling on close', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const app = Fastify();
  const info = vi.spyOn(app.log, 'info');
  const counters = createDockerExecDiagnostics();
  vi.mocked(getDockerExecDiagnostics).mockImplementation(counters.snapshot);
  const interval = vi.spyOn(globalThis, 'setInterval');
  try {
    installEmbeddedDockerExecDiagnostics(app);
    const timer = interval.mock.results[0]!.value as ReturnType<typeof setInterval>;
    expect(timer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).not.toHaveBeenCalled();
    const finished = counters.begin('runtime');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenLastCalledWith(
      { dockerExec: counters.snapshot() },
      'verity: docker exec activity diagnostic',
    );
    expect(info).toHaveBeenCalledTimes(1);
    finished();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledTimes(2);
    await app.close();
    const sampled = vi.mocked(getDockerExecDiagnostics).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getDockerExecDiagnostics).toHaveBeenCalledTimes(sampled);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await app.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
