import { get } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { measureLatencyPhase, recordRequestQuery } from '@verity/store';
import { registerRequestLatencyDiagnostics } from './request-latency.js';

afterEach(() => vi.restoreAllMocks());

describe('slow backend read diagnostics', () => {
  it('attributes handler phases after auth and detects a block before the timer can fire', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        stream: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      },
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    registerRequestLatencyDiagnostics(app);
    app.addHook('onRequest', async () => {
      clock.mockReturnValue(200);
    });
    app.get('/projects', async () =>
      measureLatencyPhase('project_list', async () => {
        recordRequestQuery(30, false);
        clock.mockReturnValue(5_000);
        return [];
      }),
    );
    try {
      const response = await app.inject('/projects?private=secret');
      expect(response.statusCode, response.body).toBe(200);
      const diagnostic = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.msg === 'slow backend read diagnostic');
      expect(diagnostic).toMatchObject({
        route: '/projects',
        statusCode: 200,
        beforeHandlerMs: 200,
        eventLoopDelayMaxMs: 4_900,
        phases: { project_list: { calls: 1, totalMs: 4_800 } },
        queries: { calls: 1, totalMs: 30 },
      });
      expect(JSON.stringify(diagnostic)).not.toContain('secret');
      expect(JSON.stringify(diagnostic)).not.toContain('private');
    } finally {
      await app.close();
    }
  });

  it('does not report ordinary reads or install probes on streaming routes', async () => {
    const app = Fastify();
    const warned = vi.spyOn(app.log, 'warn');
    const interval = vi.spyOn(globalThis, 'setInterval');
    registerRequestLatencyDiagnostics(app);
    app.get('/sessions', async () => []);
    app.get('/sessions/:id/stream', async () => 'stream');
    try {
      await app.inject('/sessions');
      const afterRead = interval.mock.calls.length;
      await app.inject('/sessions/s1/stream');
      expect(interval.mock.calls.length).toBe(afterRead);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops probing a disconnected client even while its handler is waiting', async () => {
    const app = Fastify();
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const scheduled = vi.spyOn(globalThis, 'setInterval');
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerRequestLatencyDiagnostics(app);
    app.get('/projects', async () => {
      started();
      await waiting;
      return [];
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    scheduled.mockClear();
    const client = get(`${origin}/projects`);
    client.on('error', () => undefined);
    try {
      await entered;
      expect(scheduled).toHaveBeenCalledOnce();
      const timer = scheduled.mock.results[0]!.value as ReturnType<typeof setInterval>;
      client.destroy();
      // Waiting for the upstream to return would leak a timer for every abandoned poll.
      await vi.waitFor(() => expect(cleared).toHaveBeenCalledWith(timer));
    } finally {
      client.destroy();
      release();
      await app.close();
    }
  });

  it('keeps failed reads observable and releases their timer', async () => {
    const app = Fastify();
    const warned = vi.spyOn(app.log, 'warn');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    registerRequestLatencyDiagnostics(app);
    app.get('/sessions', async () =>
      measureLatencyPhase('session_list', async () => {
        clock.mockReturnValue(4_000);
        throw new Error('database failed');
      }),
    );
    try {
      expect((await app.inject('/sessions')).statusCode).toBe(500);
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          phases: { session_list: expect.objectContaining({ calls: 1 }) },
        }),
        'slow backend read diagnostic',
      );
      expect(cleared).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
