import { performance } from 'node:perf_hooks';
import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { describe, expect, it, vi } from 'vitest';
import { createAuthTokenRegistry } from './auth.js';
import { buildServer } from './server.js';

describe('overview latency diagnostic wiring', () => {
  it('attributes authenticated route authorization before the handler', async () => {
    const ctx = await createTestDb();
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const token = await registry.mint('latency test');
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      authRegistry: registry,
      logger: true,
      listProjects: async () => [],
    });
    let now = 0;
    const warned = vi.fn();
    app.addHook('onRequest', (request, _reply, done) => {
      vi.spyOn(request.log, 'warn').mockImplementation(warned);
      done();
    });
    try {
      await app.ready();
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.spyOn(ctx.store, 'isActiveLocalUser').mockImplementation(async () => {
        now += 4_000;
        return true;
      });
      expect(
        (
          await app.inject({
            url: '/projects',
            headers: { authorization: `Bearer ${token.token}` },
          })
        ).statusCode,
      ).toBe(200);
      // Handler-only phases otherwise hide the permission lookup that queues before every read.
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          route: '/projects',
          statusCode: 200,
          beforeHandlerMs: 4_000,
          phases: expect.objectContaining({
            request_authorization: expect.objectContaining({ calls: 1, totalMs: 4_000 }),
          }),
        }),
        'slow backend read diagnostic',
      );
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await ctx.close();
    }
  });

  it('separates cold release refresh, persistence and overview settings in the real route', async () => {
    const ctx = await createTestDb();
    await ctx.store.upsertProject({
      id: 'release-project',
      owner: 'test',
      repo: 'release',
      containerName: 'release-project',
      state: 'active',
    });
    await ctx.store.updateVeritySettings({ advancedModeEnabled: true });
    const app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      logger: true,
      latestRelease: () => undefined,
      refreshLatestRelease: async () => {
        now += 3_000;
        return { tag: 'v1', name: 'First', url: 'https://example.com/release', publishedAt: null };
      },
    });
    let now = 0;
    const warned = vi.fn();
    app.addHook('onRequest', (request, _reply, done) => {
      vi.spyOn(request.log, 'warn').mockImplementation(warned);
      done();
    });
    try {
      await app.ready();
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const upsert = ctx.store.upsertProject.bind(ctx.store);
      vi.spyOn(ctx.store, 'upsertProject').mockImplementation(async (...args) => {
        if (args[0].id === 'verity-control') now += 200;
        return upsert(...args);
      });
      const persist = ctx.store.updateProjectReleaseStatus.bind(ctx.store);
      vi.spyOn(ctx.store, 'updateProjectReleaseStatus').mockImplementation(async (...args) => {
        now += 500;
        return persist(...args);
      });
      const settings = ctx.store.getVeritySettingsRaw.bind(ctx.store);
      vi.spyOn(ctx.store, 'getVeritySettingsRaw').mockImplementation(async () => {
        now += 750;
        return settings();
      });
      expect((await app.inject('/projects')).statusCode).toBe(200);
      // A combined release timer hides whether GitHub or a database write stalls the overview.
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          route: '/projects',
          phases: expect.objectContaining({
            project_release_refresh: expect.objectContaining({ calls: 1, totalMs: 3_000 }),
            project_release_persist: expect.objectContaining({ calls: 1, totalMs: 500 }),
            project_settings: expect.objectContaining({ calls: 1, totalMs: 750 }),
            project_control: expect.objectContaining({ calls: 1, totalMs: 200 }),
          }),
        }),
        'slow backend read diagnostic',
      );
      expect((await ctx.store.getProject('release-project'))?.latestReleaseTag).toBe('v1');
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await ctx.close();
    }
  });

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
            session_automations: expect.objectContaining({ calls: 1 }),
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
