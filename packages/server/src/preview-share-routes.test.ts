import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPreviewShareRoutes } from './preview-share-routes.js';
import {
  PreviewShareConflictError,
  PreviewShareInputError,
  PreviewShareNotFoundError,
  PreviewShareUpstreamError,
  type PreviewShareManager,
  type PublicPreviewShare,
} from './preview-share-manager.js';
import type { EventStore } from '@verity/store';

describe('public preview share routes', () => {
  it('creates, lists and stops a public share without returning secret material', async () => {
    const publicShare = {
      id: 'share-1',
      projectId: 'p1',
      devServerId: 'dev-1',
      containerGeneration: 'generation-1',
      targetPort: 3000,
      state: 'active' as const,
      publicOrigin: 'https://share-1.preview.example',
      connectorContainerName: 'verity-preview-share-1',
      connectorContainerId: 'connector-1',
      expiresAt: new Date('2030-01-01T01:00:00Z'),
      revokedAt: null,
      failure: null,
      createdAt: new Date('2030-01-01T00:00:00Z'),
      updatedAt: new Date('2030-01-01T00:00:00Z'),
    };
    const manager = {
      create: vi.fn(async () => publicShare),
      list: vi.fn(async () => [publicShare]),
      stop: vi.fn(async () => true),
    };
    const store = { getProject: vi.fn(async () => ({ id: 'p1' })) };
    const app = Fastify();
    registerPreviewShareRoutes(app, {
      eventStore: store as unknown as EventStore,
      manager: manager as unknown as PreviewShareManager,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/sessions/s1/public-port-shares',
      payload: { targetPort: 3000, pin: '123456', ttlSeconds: 3600 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(
      expect.objectContaining({
        share: expect.objectContaining({ id: 'share-1', publicOrigin: publicShare.publicOrigin }),
      }),
    );
    expect(JSON.stringify(created.json())).not.toContain('connectorToken');

    expect(
      (await app.inject({ method: 'GET', url: '/projects/p1/public-shares' })).json().shares,
    ).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/public-shares/share-1' })).statusCode).toBe(
      204,
    );
    await app.close();
  });

  it('is fail-closed when the lifecycle is not configured', async () => {
    const app = Fastify();
    registerPreviewShareRoutes(app, { eventStore: {} as EventStore });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sessions/s1/public-port-shares',
          payload: { targetPort: 3000, pin: '123456', ttlSeconds: 3600 },
        })
      ).statusCode,
    ).toBe(503);
    await app.close();
  });
});

describe('public preview share route refusals', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  function appFor(deps: {
    manager?: Partial<PreviewShareManager>;
    getProject?: () => Promise<unknown>;
    getSession?: () => Promise<unknown>;
  }) {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerPreviewShareRoutes(app, {
      eventStore: {
        getProject: deps.getProject ?? (async () => ({ id: 'p1' })),
        getSession: deps.getSession ?? (async () => undefined),
      } as unknown as EventStore,
      ...(deps.manager === undefined
        ? {}
        : { manager: deps.manager as unknown as PreviewShareManager }),
    });
    return app;
  }

  const create = (url: string, payload: Record<string, unknown>) => ({
    method: 'POST' as const,
    url,
    payload,
  });
  const devServerCreate = create('/sessions/s1/public-port-shares', {
    targetPort: 3000,
    pin: '123456',
    ttlSeconds: 3600,
  });
  const staticCreate = create('/projects/p1/public-static-shares', {
    pin: '123456',
    ttlSeconds: 3600,
    staticPath: 'dist',
  });

  it('refuses every public-preview route with 503 when no manager is wired', async () => {
    // Fail-closed matters per route: a share endpoint that 404s or 500s instead
    // reads as "gone" rather than "this deployment does not offer public previews".
    const app = appFor({});
    for (const request of [
      devServerCreate,
      staticCreate,
      { method: 'GET' as const, url: '/projects/p1/public-shares' },
      { method: 'DELETE' as const, url: '/public-shares/share-1' },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'public previews are not configured' });
    }
  });

  it('maps lifecycle refusals onto distinct statuses for both create routes', async () => {
    for (const request of [devServerCreate, staticCreate]) {
      for (const [error, status] of [
        [new PreviewShareInputError('ttl exceeds the maximum'), 400],
        [new PreviewShareNotFoundError('dev server not found'), 404],
        [new PreviewShareConflictError('a share already exists for this dev server'), 409],
      ] as const) {
        const response = await appFor({
          manager: { create: vi.fn(() => Promise.reject(error)) },
        }).inject(request);
        expect(response.statusCode).toBe(status);
        // The operator-facing reason has to survive the mapping — a bare status
        // leaves "why" invisible in the UI.
        expect(response.json()).toEqual({ error: error.message });
      }
    }
  });

  it('rejects malformed create bodies before touching the lifecycle', async () => {
    const manager = { create: vi.fn(() => Promise.reject(new Error('unreachable'))) };
    const app = appFor({ manager });
    for (const request of [
      create('/sessions/s1/public-port-shares', { pin: '12345', ttlSeconds: 3600 }),
      create('/sessions/s1/public-port-shares', { pin: '123456', ttlSeconds: 1.5 }),
      create('/sessions/s1/public-port-shares', { pin: '123456', ttlSeconds: 60, extra: true }),
      create('/projects/p1/public-static-shares', { pin: '123456', ttlSeconds: 60 }),
      create('/projects/p1/public-static-shares', {
        pin: '123456',
        ttlSeconds: 60,
        staticPath: '   ',
      }),
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual(expect.any(String));
    }
    expect(manager.create).not.toHaveBeenCalled();
  });

  it('creates a project static share from a trimmed path', async () => {
    const created = { id: 'share-2', staticPath: 'dist' } as unknown as PublicPreviewShare;
    const manager = { create: vi.fn(() => Promise.resolve(created)) };
    const response = await appFor({ manager }).inject(
      create('/projects/p1/public-static-shares', {
        pin: '123456',
        ttlSeconds: 3600,
        staticPath: '  dist  ',
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ share: { id: 'share-2', staticPath: 'dist' } });
    expect(manager.create).toHaveBeenCalledWith({
      projectId: 'p1',
      pin: '123456',
      ttlSeconds: 3600,
      staticPath: 'dist',
    });
  });

  it('uses the session id for folder browsing and share creation', async () => {
    const listStaticEntries = vi.fn(async () => ({ directories: ['dist'], files: ['index.html'] }));
    const create = vi.fn(
      async () => ({ id: 'session-share', sessionId: 's1' }) as PublicPreviewShare,
    );
    const app = appFor({
      manager: { listStaticEntries, create },
      getSession: async () => ({ sessionId: 's1', projectId: 'p1' }),
    });
    const browsed = await app.inject({
      method: 'GET',
      url: '/sessions/s1/public-static-directories?path=site',
    });
    expect(browsed.json()).toEqual({ directories: ['dist'], files: ['index.html'] });
    expect(listStaticEntries).toHaveBeenCalledWith('p1', 'site', 's1');
    const created = await app.inject({
      method: 'POST',
      url: '/sessions/s1/public-static-shares',
      payload: { staticPath: 'site/dist', pin: '123456', ttlSeconds: 3600 },
    });
    expect(created.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      sessionId: 's1',
      staticPath: 'site/dist',
      pin: '123456',
      ttlSeconds: 3600,
    });
  });

  it('lists session dev servers and shares one of their ports', async () => {
    const devServers = [
      { port: 5173, reachable: true, pid: 40, name: 'Vite', command: 'vite', workdir: '.' },
    ];
    const listSessionDevServers = vi.fn(async () => devServers);
    const create = vi.fn(async () => ({ id: 'port-share', sessionId: 's1' }) as PublicPreviewShare);
    const app = appFor({ manager: { listSessionDevServers, create } });

    const listed = await app.inject({ method: 'GET', url: '/sessions/s1/dev-servers' });
    expect(listed.json()).toEqual({ devServers });
    expect(listSessionDevServers).toHaveBeenCalledWith('s1');

    const created = await app.inject({
      method: 'POST',
      url: '/sessions/s1/public-port-shares',
      payload: { targetPort: 5173, pin: '123456', ttlSeconds: 3600 },
    });
    expect(created.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      sessionId: 's1',
      targetPort: 5173,
      pin: '123456',
      ttlSeconds: 3600,
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/sessions/s1/public-port-shares',
      payload: { targetPort: 70_000, pin: '123456', ttlSeconds: 3600 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('shows an Uplink protocol refusal on static share creation', async () => {
    const response = await appFor({
      manager: {
        create: vi.fn(() =>
          Promise.reject(
            new PreviewShareUpstreamError(
              'Uplink closed the control connection (1002: protocol_error)',
            ),
          ),
        ),
      },
    }).inject(staticCreate);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'Uplink closed the control connection (1002: protocol_error)',
    });
  });

  it('does not disguise an unexpected lifecycle failure as a client error', async () => {
    for (const request of [devServerCreate, staticCreate]) {
      const response = await appFor({
        manager: { create: vi.fn(() => Promise.reject(new Error('edge connector unreachable'))) },
      }).inject(request);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(
        expect.objectContaining({ message: 'edge connector unreachable' }),
      );
    }
  });

  it('404s the share listing for a project that does not exist', async () => {
    const manager = { list: vi.fn(() => Promise.resolve([])) };
    const response = await appFor({
      manager,
      getProject: async () => undefined,
    }).inject({ method: 'GET', url: '/projects/missing/public-shares' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'project not found' });
    // Listing an unknown project must not reach the lifecycle at all.
    expect(manager.list).not.toHaveBeenCalled();
  });

  it('404s a stop for a share the lifecycle does not know', async () => {
    const manager = { stop: vi.fn(() => Promise.resolve(false)) };
    const response = await appFor({ manager }).inject({
      method: 'DELETE',
      url: '/public-shares/share-gone',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'public preview share not found' });
    expect(manager.stop).toHaveBeenCalledWith('share-gone');
  });
});

it('browses static folders with a local runtime and no Uplink manager', async () => {
  const app = Fastify();
  const listStaticEntries = vi.fn(async () => ({ directories: ['dist'], files: [] }));
  registerPreviewShareRoutes(app, {
    eventStore: { getSession: async () => ({ projectId: 'p1' }) } as unknown as EventStore,
    localManager: {
      listStaticEntries,
    } as unknown as import('./local-preview-manager.js').LocalPreviewManager,
  });
  const response = await app.inject('/sessions/s1/public-static-directories?path=web');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ directories: ['dist'], files: [] });
  expect(listStaticEntries).toHaveBeenCalledWith('p1', 'web', 's1');
  await app.close();
});
