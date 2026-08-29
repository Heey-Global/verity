import { DevServerPortRangeExhaustedError, EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  registerDevServerRoutes,
  runningDevServerIds,
  startAutoDevServers,
} from './dev-server-routes.js';
import type { ProjectRuntime, ProjectRuntimeSettings } from './project-runtime.js';

let ctx: TestDb;
let app: FastifyInstance;
let store: EventStore;
const detectDevServers = vi.fn(async () => [
  {
    key: '.:dev',
    name: 'Web',
    command: 'npm run dev',
    workdir: null,
    containerPort: '5173',
    confidence: 'medium' as const,
    evidence: 'Vite default from package.json script "dev"',
  },
]);

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  detectDevServers.mockClear();
  store = new EventStore(ctx.db);
  await store.upsertProject({
    id: 'p1',
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
  app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid request' });
    return reply.send(error);
  });
  const projectRuntime: ProjectRuntime = {
    startDevServer: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: true,
      pid: '1',
    }),
    devServerStatus: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: false,
      pid: null,
    }),
    stopDevServer: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: false,
      pid: null,
    }),
    devServerLogs: async (project) => ({ projectId: project.id, logs: '' }),
    devServerHealth: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      reachable: false,
      status: null,
      checkedAt: '2026-07-14T00:00:00.000Z',
      error: null,
    }),
  };
  registerDevServerRoutes(app, { eventStore: store, projectRuntime, detectDevServers });
});
afterEach(async () => app.close());

interface DevServerBody {
  id: string;
  projectId: string;
  name: string;
  command: string | null;
  url: string | null;
  hostPort: string | null;
  sortOrder: number;
}

describe('Dev server routes', () => {
  it('fingerprints suggestions without taking ownership of an exact manual match', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      suggestions: [
        expect.objectContaining({
          key: '.:dev',
          status: 'new',
          alreadyConfigured: false,
          existingDevServerId: null,
        }),
      ],
    });
    expect(await store.listDevServers('p1')).toEqual([]);

    await store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run dev',
      containerPort: '5173',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(second.json()).toMatchObject({
      suggestions: [
        expect.objectContaining({
          alreadyConfigured: true,
          status: 'configured',
          existingDevServerId: expect.any(String),
        }),
      ],
    });
    expect((await store.listDevServers('p1'))[0]?.sourceKey).toBeNull();
    expect(await store.getDevServerDetectionState('p1')).toMatchObject({
      fingerprint: second.json<{ fingerprint: string }>().fingerprint,
    });
    expect(second.json<{ fingerprint: string }>().fingerprint).not.toBe(
      first.json<{ fingerprint: string }>().fingerprint,
    );
    expect(detectDevServers).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('only marks the current detection fingerprint as reviewed', async () => {
    const detected = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    const fingerprint = detected.json<{ fingerprint: string }>().fingerprint;
    const stale = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-server-suggestions/reviewed',
      payload: { fingerprint: 'stale' },
    });
    expect(stale.statusCode).toBe(409);

    const reviewed = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-server-suggestions/reviewed',
      payload: { fingerprint },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().detection).toMatchObject({
      fingerprint,
      reviewedFingerprint: fingerprint,
      reviewedAt: expect.any(String),
    });
    const refreshed = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(refreshed.json()).toMatchObject({
      fingerprint,
      reviewedFingerprint: fingerprint,
      reviewedAt: expect.any(String),
    });
  });

  it('classifies tracked sources as configured, changed, or missing', async () => {
    const server = await store.createDevServer({
      projectId: 'p1',
      sourceKey: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      containerPort: '5173',
    });
    const configured = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(configured.json().suggestions[0]).toMatchObject({
      status: 'configured',
      existingDevServerId: server.id,
      existingConfig: {
        name: 'Web',
        command: 'npm run dev',
        workdir: null,
        containerPort: '5173',
      },
    });

    detectDevServers.mockResolvedValueOnce([
      {
        key: '.:dev',
        name: 'Web',
        command: 'npm run dev:new',
        workdir: null,
        containerPort: '5173',
        confidence: 'medium',
        evidence: 'changed script',
      },
    ]);
    const changed = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(changed.json().suggestions[0]).toMatchObject({
      status: 'changed',
      existingDevServerId: server.id,
    });
    const changedFingerprint = changed.json<{ fingerprint: string }>().fingerprint;

    detectDevServers.mockResolvedValueOnce([]);
    const missing = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(missing.json().suggestions).toEqual([
      expect.objectContaining({
        key: '.:dev',
        status: 'missing',
        existingDevServerId: server.id,
      }),
    ]);
    expect(missing.json().fingerprint).not.toBe(changedFingerprint);
    expect(await store.getDevServer(server.id)).toBeDefined();
  });

  it('changes the fingerprint when only tracked server configuration changes', async () => {
    const server = await store.createDevServer({
      projectId: 'p1',
      sourceKey: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      containerPort: '5173',
    });
    const before = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    await store.updateDevServer(server.id, { name: 'Custom Web' });
    const after = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(after.json().suggestions[0].status).toBe('changed');
    expect(after.json().fingerprint).not.toBe(before.json().fingerprint);
  });

  it('creates, lists, gets, patches, and deletes a dev server', async () => {
    await store.updateProjectState('p1', 'absent');
    const created = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-servers',
      payload: {
        sourceKey: '.:dev',
        name: 'Web',
        command: 'npm run dev',
        containerPort: '3000',
      },
    });
    expect(created.statusCode).toBe(201);
    const { devServer } = created.json<{ devServer: DevServerBody }>();
    expect(devServer).toMatchObject({
      projectId: 'p1',
      sourceKey: '.:dev',
      name: 'Web',
      command: 'npm run dev',
      hostPort: '3000',
      sortOrder: 0,
    });

    const list = await app.inject({ method: 'GET', url: '/projects/p1/dev-servers' });
    expect(list.json<{ devServers: DevServerBody[] }>().devServers).toHaveLength(1);

    const got = await app.inject({ method: 'GET', url: `/dev-servers/${devServer.id}` });
    expect(got.json<{ devServer: DevServerBody }>().devServer.name).toBe('Web');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/dev-servers/${devServer.id}`,
      payload: { command: 'pnpm dev', url: 'http://localhost:5173' },
    });
    expect(patched.json<{ devServer: DevServerBody }>().devServer).toMatchObject({
      command: 'pnpm dev',
      url: 'http://localhost:5173',
    });

    const deleted = await app.inject({ method: 'DELETE', url: `/dev-servers/${devServer.id}` });
    expect(deleted.json<{ deleted: boolean }>().deleted).toBe(true);
    const after = await app.inject({ method: 'GET', url: '/projects/p1/dev-servers' });
    expect(after.json<{ devServers: DevServerBody[] }>().devServers).toHaveLength(0);
  });

  it('requires a stopped, visible project before allocating a new port', async () => {
    const active = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-servers',
      payload: { name: 'Web' },
    });
    expect(active.statusCode).toBe(409);

    await store.hideProject('p1');
    await store.updateProjectState('p1', 'absent');
    const hidden = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-servers',
      payload: { name: 'Web' },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('requires a stopped project before changing a published container port', async () => {
    await store.updateProjectState('p1', 'absent');
    const created = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-servers',
      payload: { name: 'Web', containerPort: '3000' },
    });
    const id = created.json<{ devServer: DevServerBody }>().devServer.id;
    await store.updateProjectState('p1', 'active');

    const changed = await app.inject({
      method: 'PATCH',
      url: `/dev-servers/${id}`,
      payload: { containerPort: '4173' },
    });

    expect(changed.statusCode).toBe(409);
  });

  it('404s for an unknown project, dev server, and delete', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/projects/nope/dev-servers' })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/dev-servers/nope' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'PATCH', url: '/dev-servers/nope', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/dev-servers/nope' })).statusCode).toBe(404);
  });

  it('rejects caller-selected host ports', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-servers',
      payload: { hostPort: 'not-a-port' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('controls each dev-server runtime independently by stable id', async () => {
    const web = await ctx.store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run web',
      url: 'http://localhost:3000',
    });
    const docs = await ctx.store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      url: 'http://localhost:4000',
      sortOrder: 1,
    });
    const projectRuntime: ProjectRuntime = {
      startDevServer: vi.fn(async (_project, settings) => ({
        projectId: 'p1',
        url: settings.devServerUrl,
        running: true,
        pid: settings.devServerId === web.id ? '101' : '202',
      })),
      devServerStatus: vi.fn(async (_project, settings) => ({
        projectId: 'p1',
        url: settings.devServerUrl,
        running: true,
        pid: settings.devServerId === web.id ? '101' : '202',
      })),
      stopDevServer: vi.fn(async (_project, settings) => ({
        projectId: 'p1',
        url: settings.devServerUrl,
        running: false,
        pid: null,
      })),
      devServerLogs: vi.fn(async () => ({ projectId: 'p1', logs: 'ready\n' })),
      devServerHealth: vi.fn(async (_project, settings) => ({
        projectId: 'p1',
        url: settings.devServerUrl,
        reachable: true,
        status: 200,
        checkedAt: '2026-07-14T00:00:00.000Z',
        error: null,
      })),
    };
    const runtimeApp = Fastify();
    const beginPublicPreviewMutation = vi.fn(async () => () => undefined);
    registerDevServerRoutes(runtimeApp, {
      eventStore: ctx.store,
      projectRuntime,
      beginPublicPreviewMutation,
    });
    try {
      const webStart = await runtimeApp.inject({
        method: 'POST',
        url: `/dev-servers/${web.id}/runtime`,
      });
      const docsStart = await runtimeApp.inject({
        method: 'POST',
        url: `/dev-servers/${docs.id}/runtime`,
      });
      const runningList = await runtimeApp.inject({
        method: 'GET',
        url: '/projects/p1/dev-servers',
      });
      const editWhileRunning = await runtimeApp.inject({
        method: 'PATCH',
        url: `/dev-servers/${web.id}`,
        payload: { command: 'npm run changed' },
      });
      await runtimeApp.inject({ method: 'GET', url: `/dev-servers/${web.id}/runtime` });
      await runtimeApp.inject({ method: 'GET', url: `/dev-servers/${docs.id}/runtime/logs` });
      await runtimeApp.inject({ method: 'GET', url: `/dev-servers/${docs.id}/runtime/health` });
      await runtimeApp.inject({ method: 'POST', url: `/dev-servers/${web.id}/runtime/stop` });
      const deleted = await runtimeApp.inject({ method: 'DELETE', url: `/dev-servers/${docs.id}` });

      expect(webStart.json()).toMatchObject({ runtime: { pid: '101' } });
      expect(docsStart.json()).toMatchObject({ runtime: { pid: '202' } });
      expect(runningList.json()).toMatchObject({
        devServers: [
          expect.objectContaining({ id: web.id, running: true, autoStart: true }),
          expect.objectContaining({ id: docs.id, running: true, autoStart: true }),
        ],
      });
      expect((await ctx.store.getDevServer(web.id))?.autoStart).toBe(false);
      expect(editWhileRunning.statusCode).toBe(409);
      expect(beginPublicPreviewMutation).toHaveBeenCalledWith(web.id);
      expect(beginPublicPreviewMutation).toHaveBeenCalledWith(docs.id);
      expect(beginPublicPreviewMutation).toHaveBeenCalledTimes(4);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting a Vitest mock
      expect(projectRuntime.startDevServer).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 'p1' }),
        expect.objectContaining({
          devServerId: web.id,
          devServerCommand: 'npm run web',
          devServerUrl: 'http://localhost:3000',
        }),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting a Vitest mock
      expect(projectRuntime.startDevServer).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ devServerId: docs.id, devServerCommand: 'npm run docs' }),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting a Vitest mock
      expect(projectRuntime.devServerLogs).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ devServerId: docs.id }),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting a Vitest mock
      expect(projectRuntime.stopDevServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ devServerId: web.id }),
      );
      expect(deleted.statusCode).toBe(200);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- inspecting a Vitest mock
      expect(projectRuntime.stopDevServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ devServerId: docs.id }),
      );
      await expect(ctx.store.getDevServer(docs.id)).resolves.toBeUndefined();

      // Cleanup remains possible for a failed project while the secret store is
      // sealed: delete uses the raw/non-decrypting settings path.
      await ctx.store.updateProjectState('p1', 'failed', 'container unhealthy');
      const decryptingRead = vi
        .spyOn(ctx.store, 'getProjectSettings')
        .mockRejectedValue(new Error('secret store is sealed'));
      const failedDelete = await runtimeApp.inject({
        method: 'DELETE',
        url: `/dev-servers/${web.id}`,
      });
      expect(failedDelete.statusCode).toBe(200);
      expect(decryptingRead).not.toHaveBeenCalled();
      await expect(ctx.store.getDevServer(web.id)).resolves.toBeUndefined();
    } finally {
      await runtimeApp.close();
    }
  });

  it('503s server-specific runtime routes when runtime is unavailable', async () => {
    const devServer = await ctx.store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const noRuntimeApp = Fastify();
    registerDevServerRoutes(noRuntimeApp, { eventStore: ctx.store });
    try {
      const res = await noRuntimeApp.inject({
        method: 'GET',
        url: `/dev-servers/${devServer.id}/runtime`,
      });
      expect(res.statusCode).toBe(503);
      const deletion = await noRuntimeApp.inject({
        method: 'DELETE',
        url: `/dev-servers/${devServer.id}`,
      });
      expect(deletion.statusCode).toBe(503);
      await expect(ctx.store.getDevServer(devServer.id)).resolves.toBeDefined();
    } finally {
      await noRuntimeApp.close();
    }
  });
});

describe('Dev server session preview', () => {
  const CLONE_ROOT = '/srv/clones';
  const WORKTREE = '/srv/clones/heey-global-verity/.verity-sessions/agent-s1';

  const seedSession = async (sessionId = 's1', projectId = 'p1', worktree = WORKTREE) => {
    await store.createSession({ sessionId, worktree, model: 'claude/default', projectId });
  };

  const previewApp = (
    opts: {
      running?: boolean;
      cloneRoot?: string | undefined;
      failStarts?: number;
      syncProjectCheckout?: (projectId: string) => Promise<void>;
    } = {},
  ) => {
    const started: Array<{ checkoutRoot: string | null | undefined }> = [];
    let remainingStartFailures = opts.failStarts ?? 0;
    const runtime: ProjectRuntime = {
      startDevServer: async (project, settings) => {
        started.push({ checkoutRoot: settings.devServerCheckoutRoot });
        if (remainingStartFailures > 0) {
          remainingStartFailures -= 1;
          throw new Error('start failed');
        }
        return { projectId: project.id, url: settings.devServerUrl, running: true, pid: '1' };
      },
      devServerStatus: async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        running: opts.running ?? false,
        pid: opts.running ? '1' : null,
      }),
      stopDevServer: async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        running: false,
        pid: null,
      }),
      devServerLogs: async (project) => ({ projectId: project.id, logs: '' }),
      devServerHealth: async (project, settings) => ({
        projectId: project.id,
        url: settings.devServerUrl,
        reachable: false,
        status: null,
        checkedAt: '2026-07-14T00:00:00.000Z',
        error: null,
      }),
    };
    const localApp = Fastify();
    registerDevServerRoutes(localApp, {
      eventStore: store,
      projectRuntime: runtime,
      ...('cloneRoot' in opts ? {} : { projectCloneRoot: CLONE_ROOT }),
      ...(opts.syncProjectCheckout ? { syncProjectCheckout: opts.syncProjectCheckout } : {}),
    });
    return { app: localApp, started };
  };

  it('sets the pointer and restarts a running server in the session worktree', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp, started } = previewApp({ running: true });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.devServer.previewSessionId).toBe('s1');
      expect(body.runtime?.running).toBe(true);
      expect(started).toEqual([{ checkoutRoot: '/work/.verity-sessions/agent-s1' }]);
    } finally {
      await localApp.close();
    }
  });

  it('does not restart a stopped server, which picks up the new root on next start', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp, started } = previewApp({ running: false });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(res.statusCode).toBe(200);
      expect(started).toEqual([]);
      const start = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/runtime`,
      });
      expect(start.statusCode).toBe(200);
      expect(started).toEqual([{ checkoutRoot: '/work/.verity-sessions/agent-s1' }]);
    } finally {
      await localApp.close();
    }
  });

  it('resets to main and restarts there', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await store.updateDevServer(server.id, { previewSessionId: 's1' });
    const syncProjectCheckout = vi.fn(async () => undefined);
    const { app: localApp, started } = previewApp({ running: true, syncProjectCheckout });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().devServer.previewSessionId).toBeNull();
      expect(syncProjectCheckout).toHaveBeenCalledWith('p1');
      expect(started).toEqual([{ checkoutRoot: null }]);
    } finally {
      await localApp.close();
    }
  });

  it('restores the prior pointer and running checkout when the preview restart fails', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp, started } = previewApp({ running: true, failStarts: 1 });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(res.statusCode).toBe(500);
      expect((await store.getDevServer(server.id))?.previewSessionId).toBeNull();
      expect(started).toEqual([
        { checkoutRoot: '/work/.verity-sessions/agent-s1' },
        { checkoutRoot: null },
      ]);
    } finally {
      await localApp.close();
    }
  });

  it('surfaces both failures when the restore after a failed preview also fails', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp, started } = previewApp({ running: true, failStarts: 2 });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        message: 'dev server preview failed and the previous runtime could not be restored',
      });
      // The pointer is still rolled back so the next start uses the main checkout.
      expect((await store.getDevServer(server.id))?.previewSessionId).toBeNull();
      expect(started).toEqual([
        { checkoutRoot: '/work/.verity-sessions/agent-s1' },
        { checkoutRoot: null },
      ]);
    } finally {
      await localApp.close();
    }
  });

  it('rejects a session from another project and an unknown session', async () => {
    await store.upsertProject({
      id: 'p2',
      owner: 'heey-global',
      repo: 'other',
      containerName: 'verity-heey-global--other',
      state: 'active',
    });
    await seedSession('foreign', 'p2', '/srv/clones/heey-global-other/.verity-sessions/agent-x');
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp } = previewApp();
    try {
      const foreign = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 'foreign' },
      });
      expect(foreign.statusCode).toBe(409);
      const unknown = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 'nope' },
      });
      expect(unknown.statusCode).toBe(404);
      expect((await store.getDevServer(server.id))?.previewSessionId).toBeNull();
    } finally {
      await localApp.close();
    }
  });

  it('rejects a session whose worktree is outside the project checkout', async () => {
    await seedSession('outside', 'p1', '/tmp/elsewhere/agent-x');
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp } = previewApp();
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 'outside' },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await localApp.close();
    }
  });

  it('503s when previews are not configured (no projectCloneRoot)', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp } = previewApp({ cloneRoot: undefined });
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await localApp.close();
    }
  });

  it('serves main again when the previewed session is deleted', async () => {
    await seedSession();
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await store.updateDevServer(server.id, { previewSessionId: 's1' });
    await store.deleteSession('s1');
    const { app: localApp, started } = previewApp();
    try {
      const start = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/runtime`,
      });
      expect(start.statusCode).toBe(200);
      expect(started).toEqual([{ checkoutRoot: null }]);
    } finally {
      await localApp.close();
    }
  });

  it('404s a preview switch for an unknown dev server and a hidden project', async () => {
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const { app: localApp } = previewApp();
    try {
      const unknownServer = await localApp.inject({
        method: 'POST',
        url: '/dev-servers/nope/preview-session',
        payload: { sessionId: null },
      });
      expect(unknownServer.statusCode).toBe(404);
      expect(unknownServer.json()).toEqual({ error: 'dev server not found' });

      await store.hideProject('p1');
      const hiddenProject = await localApp.inject({
        method: 'POST',
        url: `/dev-servers/${server.id}/preview-session`,
        payload: { sessionId: 's1' },
      });
      expect(hiddenProject.statusCode).toBe(404);
      expect(hiddenProject.json()).toEqual({ error: 'project not found' });
    } finally {
      await localApp.close();
    }
  });
});

describe('Dev server route refusals', () => {
  it('404s detection suggestions for an unknown or hidden project', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/projects/nope/dev-server-suggestions',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'project not found' });

    await store.hideProject('p1');
    const hidden = await app.inject({
      method: 'GET',
      url: '/projects/p1/dev-server-suggestions',
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'project not found' });
    expect(detectDevServers).not.toHaveBeenCalled();
  });

  it('503s detection suggestions when no detector is configured', async () => {
    const noDetectorApp = Fastify();
    registerDevServerRoutes(noDetectorApp, { eventStore: store });
    try {
      const res = await noDetectorApp.inject({
        method: 'GET',
        url: '/projects/p1/dev-server-suggestions',
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'dev server detection is not configured' });
    } finally {
      await noDetectorApp.close();
    }
  });

  it('404s a detection review for an unknown or hidden project', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/projects/nope/dev-server-suggestions/reviewed',
      payload: { fingerprint: 'abc' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'project not found' });

    await store.hideProject('p1');
    const hidden = await app.inject({
      method: 'POST',
      url: '/projects/p1/dev-server-suggestions/reviewed',
      payload: { fingerprint: 'abc' },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'project not found' });
  });

  it('maps a port-range exhaustion to 409 and any other store failure to 500', async () => {
    await store.updateProjectState('p1', 'absent');
    const create = vi
      .spyOn(store, 'createDevServer')
      .mockRejectedValueOnce(new DevServerPortRangeExhaustedError())
      .mockRejectedValueOnce(new Error('database is down'));
    try {
      const exhausted = await app.inject({
        method: 'POST',
        url: '/projects/p1/dev-servers',
        payload: { name: 'Web' },
      });
      expect(exhausted.statusCode).toBe(409);
      expect(exhausted.json()).toEqual({
        error: 'no free dev-server host port remains in 3000-3099 or 8000-8099',
      });

      const other = await app.inject({
        method: 'POST',
        url: '/projects/p1/dev-servers',
        payload: { name: 'Web' },
      });
      expect(other.statusCode).toBe(500);
      expect(other.json()).toMatchObject({ message: 'database is down' });
    } finally {
      create.mockRestore();
    }
  });

  it('refuses to start a dev server it cannot run', async () => {
    const noCommand = await store.createDevServer({ projectId: 'p1', name: 'Web' });

    const unknown = await app.inject({ method: 'POST', url: '/dev-servers/nope/runtime' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'dev server not found' });

    const missingCommand = await app.inject({
      method: 'POST',
      url: `/dev-servers/${noCommand.id}/runtime`,
    });
    expect(missingCommand.statusCode).toBe(400);
    expect(missingCommand.json()).toEqual({ error: 'dev server command is not configured' });

    const runnable = await store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      sortOrder: 1,
    });
    await store.updateProjectState('p1', 'absent');
    const stopped = await app.inject({
      method: 'POST',
      url: `/dev-servers/${runnable.id}/runtime`,
    });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json()).toEqual({ error: 'project p1 is not active' });

    const noRuntimeApp = Fastify();
    registerDevServerRoutes(noRuntimeApp, { eventStore: store });
    try {
      const unconfigured = await noRuntimeApp.inject({
        method: 'POST',
        url: `/dev-servers/${runnable.id}/runtime`,
      });
      expect(unconfigured.statusCode).toBe(503);
      expect(unconfigured.json()).toEqual({ error: 'project runtime is not configured' });
    } finally {
      await noRuntimeApp.close();
    }
  });

  it('refuses runtime reads for an unknown dev server or an orphaned project', async () => {
    const devServer = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    for (const url of ['runtime', 'runtime/logs', 'runtime/health']) {
      const res = await app.inject({ method: 'GET', url: `/dev-servers/nope/${url}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'dev server not found' });
    }

    const orphaned = vi.spyOn(store, 'getProject').mockResolvedValue(undefined);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/dev-servers/${devServer.id}/runtime`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'dev server not found' });
    } finally {
      orphaned.mockRestore();
    }
  });

  it('409s runtime status for a stopped project and stop for an absent one', async () => {
    const devServer = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await store.updateProjectState('p1', 'failed', 'container unhealthy');

    // stop tolerates a non-active project, status does not.
    const stopWhileFailed = await app.inject({
      method: 'POST',
      url: `/dev-servers/${devServer.id}/runtime/stop`,
    });
    expect(stopWhileFailed.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: `/dev-servers/${devServer.id}/runtime`,
    });
    expect(status.statusCode).toBe(409);
    expect(status.json()).toEqual({ error: 'project p1 is not active' });

    await store.updateProjectState('p1', 'absent');
    const stopWhileAbsent = await app.inject({
      method: 'POST',
      url: `/dev-servers/${devServer.id}/runtime/stop`,
    });
    expect(stopWhileAbsent.statusCode).toBe(409);
    expect(stopWhileAbsent.json()).toEqual({ error: 'project p1 is not active' });
  });

  it('404s a container-port patch for a hidden project', async () => {
    await store.updateProjectState('p1', 'absent');
    const devServer = await store.createDevServer({ projectId: 'p1', name: 'Web' });
    await store.hideProject('p1');

    const res = await app.inject({
      method: 'PATCH',
      url: `/dev-servers/${devServer.id}`,
      payload: { containerPort: '4173' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
    expect((await store.getDevServer(devServer.id))?.containerPort).toBeNull();
  });
});

describe('startAutoDevServers', () => {
  const CLONE_ROOT = '/srv/clones';

  const recordingRuntime = (
    onStart: (settings: ProjectRuntimeSettings) => void = () => undefined,
  ): ProjectRuntime => ({
    startDevServer: async (project, settings) => {
      onStart(settings);
      return { projectId: project.id, url: settings.devServerUrl, running: true, pid: '1' };
    },
    devServerStatus: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: false,
      pid: null,
    }),
    stopDevServer: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: false,
      pid: null,
    }),
    devServerLogs: async (project) => ({ projectId: project.id, logs: '' }),
    devServerHealth: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      reachable: false,
      status: null,
      checkedAt: '2026-07-14T00:00:00.000Z',
      error: null,
    }),
  });

  it('starts only auto-start servers that have a command', async () => {
    await store.updateProjectSettings('p1', { defaultBranch: 'trunk' });
    const auto = await store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run dev',
      autoStart: true,
    });
    await store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      autoStart: false,
      sortOrder: 1,
    });
    await store.createDevServer({
      projectId: 'p1',
      name: 'Blank',
      command: '   ',
      autoStart: true,
      sortOrder: 2,
    });
    const started: ProjectRuntimeSettings[] = [];

    await startAutoDevServers(
      store,
      recordingRuntime((s) => started.push(s)),
      undefined,
      'p1',
    );

    expect(started).toEqual([
      expect.objectContaining({
        devServerId: auto.id,
        devServerCommand: 'npm run dev',
        adoptLegacyDevServerFiles: true,
        devServerCheckoutRoot: null,
        defaultBranch: 'trunk',
      }),
    ]);
  });

  it('starts exactly the forced servers regardless of their auto-start flag', async () => {
    const auto = await store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run dev',
      autoStart: true,
    });
    const manual = await store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      autoStart: false,
      sortOrder: 1,
    });
    const started: string[] = [];

    await startAutoDevServers(
      store,
      recordingRuntime((s) => started.push(s.devServerId ?? '')),
      undefined,
      'p1',
      [manual.id],
    );

    expect(started).toEqual([manual.id]);
    expect(started).not.toContain(auto.id);
  });

  it('starts nothing for a project that is not active', async () => {
    await store.createDevServer({
      projectId: 'p1',
      command: 'npm run dev',
      autoStart: true,
    });
    await store.updateProjectState('p1', 'absent');
    const started: string[] = [];

    await startAutoDevServers(
      store,
      recordingRuntime((s) => started.push(s.devServerId ?? '')),
      undefined,
      'p1',
    );

    expect(started).toEqual([]);
  });

  it('restores a previewed session checkout and falls back to main when it is unusable', async () => {
    await store.createSession({
      sessionId: 'inside',
      worktree: '/srv/clones/heey-global-verity/.verity-sessions/agent-a',
      model: 'claude/default',
      projectId: 'p1',
    });
    await store.createSession({
      sessionId: 'outside',
      worktree: '/tmp/elsewhere/agent-b',
      model: 'claude/default',
      projectId: 'p1',
    });
    const previewed = await store.createDevServer({
      projectId: 'p1',
      name: 'Preview',
      command: 'npm run dev',
      autoStart: true,
    });
    const escaped = await store.createDevServer({
      projectId: 'p1',
      name: 'Escaped',
      command: 'npm run dev',
      autoStart: true,
      sortOrder: 1,
    });
    await store.updateDevServer(previewed.id, { previewSessionId: 'inside' });
    await store.updateDevServer(escaped.id, { previewSessionId: 'outside' });
    const roots: Array<string | null | undefined> = [];

    await startAutoDevServers(
      store,
      recordingRuntime((s) => roots.push(s.devServerCheckoutRoot)),
      CLONE_ROOT,
      'p1',
    );

    expect(roots).toEqual(['/work/.verity-sessions/agent-a', null]);
  });

  it('reports every failed start in one aggregate error', async () => {
    await store.createDevServer({
      projectId: 'p1',
      name: 'Web',
      command: 'npm run dev',
      autoStart: true,
    });
    await store.createDevServer({
      projectId: 'p1',
      name: 'Docs',
      command: 'npm run docs',
      autoStart: true,
      sortOrder: 1,
    });
    const runtime = recordingRuntime((settings) => {
      throw new Error(`cannot start ${settings.devServerCommand ?? ''}`);
    });

    const failure = await startAutoDevServers(store, runtime, undefined, 'p1').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('could not auto-start Dev Servers');
    expect(((failure as AggregateError).errors as Error[]).map((error) => error.message)).toEqual([
      'cannot start npm run dev',
      'cannot start npm run docs',
    ]);
  });
});

describe('runningDevServerIds', () => {
  const CLONE_ROOT = '/srv/clones';

  const statusRuntime = (
    isRunning: (settings: ProjectRuntimeSettings) => boolean,
    seen: ProjectRuntimeSettings[] = [],
  ): ProjectRuntime => ({
    startDevServer: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: true,
      pid: '1',
    }),
    devServerStatus: async (project, settings) => {
      seen.push(settings);
      return {
        projectId: project.id,
        url: settings.devServerUrl,
        running: isRunning(settings),
        pid: isRunning(settings) ? '1' : null,
      };
    },
    stopDevServer: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      running: false,
      pid: null,
    }),
    devServerLogs: async (project) => ({ projectId: project.id, logs: '' }),
    devServerHealth: async (project, settings) => ({
      projectId: project.id,
      url: settings.devServerUrl,
      reachable: false,
      status: null,
      checkedAt: '2026-07-14T00:00:00.000Z',
      error: null,
    }),
  });

  it('reports only running servers that were offered as candidates', async () => {
    const running = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const stopped = await store.createDevServer({
      projectId: 'p1',
      command: 'npm run docs',
      sortOrder: 1,
    });
    const uncontested = await store.createDevServer({
      projectId: 'p1',
      command: 'npm run api',
      sortOrder: 2,
    });
    const seen: ProjectRuntimeSettings[] = [];
    const runtime = statusRuntime((settings) => settings.devServerId !== stopped.id, seen);

    const ids = await runningDevServerIds(store, runtime, undefined, 'p1', [
      running.id,
      stopped.id,
    ]);

    expect(ids).toEqual([running.id]);
    expect(seen.map((settings) => settings.devServerId)).toEqual([running.id, stopped.id]);
    expect(seen.map((settings) => settings.devServerId)).not.toContain(uncontested.id);
  });

  it('never projects legacy project credentials into captured run state', async () => {
    await store.updateProjectSettings('p1', {
      dopplerTokenRef: 'doppler://ref',
      dopplerToken: 'dp.st.plaintext',
    });
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const seen: ProjectRuntimeSettings[] = [];

    await runningDevServerIds(
      store,
      statusRuntime(() => true, seen),
      undefined,
      'p1',
      [server.id],
    );

    expect(seen[0] && 'dopplerTokenRef' in seen[0]).toBe(false);
    expect(seen[0] && 'dopplerToken' in seen[0]).toBe(false);
  });

  it('reports nothing for a project that is not active', async () => {
    const server = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    await store.updateProjectState('p1', 'absent');
    const seen: ProjectRuntimeSettings[] = [];

    const ids = await runningDevServerIds(
      store,
      statusRuntime(() => true, seen),
      undefined,
      'p1',
      [server.id],
    );

    expect(ids).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('checks a previewed server in its session checkout and falls back to main', async () => {
    await store.createSession({
      sessionId: 'inside',
      worktree: '/srv/clones/heey-global-verity/.verity-sessions/agent-a',
      model: 'claude/default',
      projectId: 'p1',
    });
    await store.createSession({
      sessionId: 'outside',
      worktree: '/tmp/elsewhere/agent-b',
      model: 'claude/default',
      projectId: 'p1',
    });
    const previewed = await store.createDevServer({ projectId: 'p1', command: 'npm run dev' });
    const escaped = await store.createDevServer({
      projectId: 'p1',
      command: 'npm run docs',
      sortOrder: 1,
    });
    await store.updateDevServer(previewed.id, { previewSessionId: 'inside' });
    await store.updateDevServer(escaped.id, { previewSessionId: 'outside' });
    const seen: ProjectRuntimeSettings[] = [];

    await runningDevServerIds(
      store,
      statusRuntime(() => true, seen),
      CLONE_ROOT,
      'p1',
      [previewed.id, escaped.id],
    );

    expect(seen.map((settings) => settings.devServerCheckoutRoot)).toEqual([
      '/work/.verity-sessions/agent-a',
      null,
    ]);
  });
});
