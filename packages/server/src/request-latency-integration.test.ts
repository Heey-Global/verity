import { performance } from 'node:perf_hooks';
import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

describe('overview latency diagnostic wiring', () => {
  it('measures the registered project and session handlers', async () => {
    const ctx = await createTestDb();
    let advance: (() => void) | undefined;
    let delayBeforeHandler = false;
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      logger: true,
      listProjects: async () => {
        advance?.();
        return [];
      },
    });
    const warned = vi.fn();
    app.addHook('onRequest', (request, _reply, done) => {
      vi.spyOn(request.log, 'warn').mockImplementation(warned);
      if (delayBeforeHandler) advance?.();
      done();
    });
    try {
      await app.ready();
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      advance = () => {
        clock.mockReturnValue(4_000);
      };
      expect((await app.inject('/projects')).statusCode).toBe(200);
      // If the hook or the real handler's phase wrapper disappears, a synthetic
      // Fastify test still passes while production loses its discriminating signal.
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          route: '/projects',
          phases: expect.objectContaining({
            project_list: expect.objectContaining({ calls: 1, totalMs: 4_000 }),
          }),
        }),
        'slow backend read diagnostic',
      );
      warned.mockClear();
      clock.mockReturnValue(0);
      const list = ctx.store.listSessions.bind(ctx.store);
      vi.spyOn(ctx.store, 'listSessions').mockImplementation(async () => {
        advance?.();
        return list();
      });
      expect((await app.inject('/sessions?envelope=1')).statusCode).toBe(200);
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          route: '/sessions',
          phases: expect.objectContaining({
            session_list: expect.objectContaining({ calls: 1, totalMs: 4_000 }),
            session_projection: expect.objectContaining({ calls: 1 }),
            session_links: expect.objectContaining({ calls: 1 }),
            session_summaries: expect.objectContaining({ calls: 1 }),
            session_attention: expect.objectContaining({ calls: 1 }),
          }),
        }),
        'slow backend read diagnostic',
      );
      warned.mockClear();
      clock.mockReturnValue(0);
      delayBeforeHandler = true;
      // Preview routes use a different parameter name from the session routes.
      // Match the real registration so a probe cannot silently miss discovery.
      expect((await app.inject('/sessions/missing/dev-servers')).statusCode).toBe(503);
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          route: expect.stringContaining('/dev-servers'),
          statusCode: 503,
        }),
        'slow backend read diagnostic',
      );
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await ctx.close();
    }
  });
});
