import { get } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { measureLatencyPhase, recordRequestQuery } from '@verity/store';
import type { PostgresPool } from 'kysely';
import { instrumentPostgresPool } from '../../store/src/request-latency.js';
import * as cpuProfile from './latency-cpu-profile.js';
import { registerRequestLatencyDiagnostics } from './request-latency.js';

afterEach(() => vi.restoreAllMocks());

describe('slow backend read diagnostics', () => {
  it.each(['/projects', '/sessions/:id/events'])(
    'attributes slow reads on %s and detects a block before the timer can fire',
    async (route) => {
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
      app.get(route, async () =>
        measureLatencyPhase('project_list', async () => {
          recordRequestQuery(30, false);
          clock.mockReturnValue(5_000);
          return [];
        }),
      );
      try {
        const response = await app.inject(`${route.replace(':id', 'test')}?private=secret`);
        expect(response.statusCode, response.body).toBe(200);
        const diagnostic = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((entry) => entry.msg === 'slow backend read diagnostic');
        expect(diagnostic).toMatchObject({
          route,
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
    },
  );

  it('does not report ordinary reads or install probes on streaming routes', async () => {
    const app = Fastify();
    const warned = vi.spyOn(app.log, 'warn');
    const interval = vi.spyOn(globalThis, 'setInterval');
    registerRequestLatencyDiagnostics(app);
    app.get('/sessions', async () => []);
    app.get('/live', async () => 'stream');
    try {
      await app.inject('/sessions');
      const afterRead = interval.mock.calls.length;
      await app.inject('/live');
      expect(interval.mock.calls.length).toBe(afterRead);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('starts optional CPU sampling on a delay observed at completion and closes it', async () => {
    const app = Fastify();
    const trigger = vi.fn();
    const close = vi.fn(async () => undefined);
    const factory = vi
      .spyOn(cpuProfile, 'createLatencyCpuProfiler')
      .mockReturnValue({ trigger, close });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    registerRequestLatencyDiagnostics(app);
    app.get('/projects/:id/dev-servers', async () => {
      clock.mockReturnValue(4_000);
      return [];
    });
    try {
      await app.inject('/projects/private-id/dev-servers');
      // An entirely synchronous stall can finish before the sampling timer runs.
      expect(trigger).toHaveBeenCalledWith(3_900);
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('identifies a write request holding a connection without leaking its URL', async () => {
    const app = Fastify();
    const warned = vi.spyOn(app.log, 'warn');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let checkouts = 0;
    const pool = instrumentPostgresPool(
      {
        connect: async () => {
          if (++checkouts === 2) clock.mockReturnValue(4_000);
          return { release: vi.fn() };
        },
        end: async () => undefined,
      } as unknown as PostgresPool,
      () => ({ waiting: 1, total: 2 }),
    );
    registerRequestLatencyDiagnostics(app);
    app.post('/sessions/:id/seen', async () => {
      const connection = await pool.connect();
      entered();
      await held;
      connection.release();
      return {};
    });
    app.get('/projects', async () => {
      const connection = await pool.connect();
      connection.release();
      return [];
    });
    const pending = app.inject({ method: 'POST', url: '/sessions/private-id/seen?secret=hidden' });
    try {
      // A write route must retain its origin even though only selected GETs log diagnostics.
      void pending.then(() => undefined);
      await ready;
      await app.inject('/projects');
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          poolAcquire: expect.objectContaining({
            holders: [
              expect.objectContaining({
                owner: expect.stringMatching(/^POST \/sessions\/:id\/seen \(req-/),
                heldMs: 4_000,
              }),
            ],
          }),
        }),
        'slow backend read diagnostic',
      );
      expect(JSON.stringify(warned.mock.calls)).not.toMatch(/private-id|secret|hidden/);
    } finally {
      release();
      await pending;
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
