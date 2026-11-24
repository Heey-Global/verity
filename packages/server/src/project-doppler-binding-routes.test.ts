import Fastify, { type FastifyInstance } from 'fastify';
import { EventStore, createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDopplerRoutes } from './doppler-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';
import { installDopplerBindings } from './project-doppler-binding-routes.js';

let ctx: TestDb;
let store: EventStore;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db, createSecretCipher('ef'.repeat(32)));
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['p1', 'p2'])
    await store.upsertProject({
      id,
      owner: 'acme',
      repo: id,
      containerName: `dev-acme-${id}`,
      state: 'active',
    });
});

// Tokens read only the configs listed for them; anything else is refused by Doppler.
const readable: Record<string, string[]> = {
  'dp.sa.platform': ['portal/prd', 'portal/stg'],
  'dp.sa.payments': ['billing/dev'],
};

function server(): FastifyInstance {
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-test-user']);
  });
  app.addHook('preHandler', async (request, reply) => {
    const outcome = await authorizePairedRoute(
      {
        isActiveLocalUser: async () => true,
        isActiveAdministrator: async (id) => id === 'admin',
        hasProjectPermission: async (userId, _projectId, permission) =>
          userId === 'manager' || (userId === 'reader' && permission === 'read'),
        getSession: async () => undefined,
      },
      request.localUserId!,
      request.method,
      request.routeOptions.url!,
      request.params as Record<string, unknown>,
    );
    if (outcome !== 'allow') return reply.code(403).send();
  });
  const listNames = vi.fn(
    async (input: { dopplerProject: string; dopplerConfig: string; token: Uint8Array }) => {
      const configs = readable[Buffer.from(input.token).toString()] ?? [];
      if (!configs.includes(`${input.dopplerProject}/${input.dopplerConfig}`))
        throw new Error('403');
      return ['API_KEY'];
    },
  );
  registerDopplerRoutes(app, {
    eventStore: store,
    dopplerValidate: async (token) =>
      token in readable ? { ok: true } : { ok: false, error: 'Doppler rejected the token' },
    dopplerWorkplace: async (token) => ({ slug: `wp-${token.slice(6)}`, name: null }),
  });
  installDopplerBindings(app, { store, listNames });
  return app;
}

const call = (
  app: FastifyInstance,
  user: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-user': user },
    ...(payload === undefined ? {} : { payload }),
  });

const addConnection = async (app: FastifyInstance, label: string, token: string) =>
  (await call(app, 'admin', 'POST', '/doppler/connections', { label, token })).json<{
    id: string;
  }>().id;

describe('Doppler connections (ADR 0031)', () => {
  it('adds only tokens Doppler accepts and never returns them', async () => {
    const app = server();
    const refused = await call(app, 'admin', 'POST', '/doppler/connections', {
      label: 'Broken',
      token: 'dp.sa.wrong',
    });
    expect(refused.statusCode).toBe(400);
    const added = await call(app, 'admin', 'POST', '/doppler/connections', {
      label: 'Platform',
      token: 'dp.sa.platform',
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      label: 'Platform',
      hasToken: true,
      workplaceSlug: 'wp-platform',
      projectCount: 0,
    });
    const listed = await call(app, 'admin', 'GET', '/doppler/connections');
    expect(listed.body).not.toContain('dp.sa.');
    expect(listed.json().connections).toHaveLength(1);
  });

  // Connections hold the administrator's tokens; nobody else may see or change them.
  it('is for administrators only', async () => {
    const app = server();
    for (const user of ['manager', 'reader']) {
      expect((await call(app, user, 'GET', '/doppler/connections')).statusCode).toBe(403);
      expect(
        (
          await call(app, user, 'POST', '/doppler/connections', {
            label: 'x',
            token: 'dp.sa.platform',
          })
        ).statusCode,
      ).toBe(403);
      expect((await call(app, user, 'DELETE', '/doppler/connections/any')).statusCode).toBe(403);
    }
  });

  it('warns with the projects in use and still deletes, taking their bindings along', async () => {
    const app = server();
    const platform = await addConnection(app, 'Platform', 'dp.sa.platform');
    const payments = await addConnection(app, 'Payments', 'dp.sa.payments');
    for (const [projectId, connectionId, dopplerProject, dopplerConfig] of [
      ['p1', platform, 'portal', 'prd'],
      ['p1', payments, 'billing', 'dev'],
      ['p2', platform, 'portal', 'stg'],
    ] as const)
      expect(
        (
          await call(app, 'admin', 'POST', `/projects/${projectId}/doppler/bindings`, {
            connectionId,
            dopplerProject,
            dopplerConfig,
          })
        ).statusCode,
      ).toBe(201);
    const usage = await call(app, 'admin', 'GET', `/doppler/connections/${platform}/usage`);
    expect(
      usage
        .json<{ projects: { projectId: string }[] }>()
        .projects.map((project) => project.projectId),
    ).toEqual(['p1', 'p2']);
    expect(
      (await call(app, 'admin', 'DELETE', `/doppler/connections/${platform}`)).statusCode,
    ).toBe(204);
    const p1 = await call(app, 'admin', 'GET', '/projects/p1/doppler/bindings');
    expect(p1.json().bindings).toEqual([
      expect.objectContaining({ reference: 'billing/dev', isDefault: true }),
    ]);
    expect((await call(app, 'admin', 'GET', '/projects/p2/doppler/bindings')).json()).toEqual({
      bindings: [],
    });
    expect(
      (await call(app, 'admin', 'DELETE', `/doppler/connections/${platform}`)).statusCode,
    ).toBe(404);
  });
});

describe('project Doppler bindings (ADR 0031)', () => {
  it('adds any project and config the connection reads, once per project', async () => {
    const app = server();
    const platform = await addConnection(app, 'Platform', 'dp.sa.platform');
    const payments = await addConnection(app, 'Payments', 'dp.sa.payments');
    const add = (connectionId: string, dopplerProject: string, dopplerConfig: string) =>
      call(app, 'admin', 'POST', '/projects/p1/doppler/bindings', {
        connectionId,
        dopplerProject,
        dopplerConfig,
      });
    expect((await add(platform, 'portal', 'prd')).json()).toMatchObject({ isDefault: true });
    expect((await add(platform, 'billing', 'dev')).statusCode).toBe(400);
    const billing = await add(payments, 'billing', 'dev');
    expect(billing.json()).toMatchObject({ reference: 'billing/dev', isDefault: false });
    // The same project and config again — from any connection — would make
    // `billing/dev/NAME` ambiguous.
    expect((await add(payments, 'billing', 'dev')).statusCode).toBe(409);
    expect((await add('missing', 'billing', 'dev')).statusCode).toBe(404);

    const moved = await call(
      app,
      'admin',
      'PATCH',
      `/projects/p1/doppler/bindings/${billing.json().id}`,
      { isDefault: true },
    );
    expect(
      moved
        .json<{ bindings: { reference: string }[] }>()
        .bindings.map((binding) => binding.reference),
    ).toEqual(['billing/dev', 'portal/prd']);
    expect((await store.getProjectSettings('p1'))?.dopplerProject).toBe('billing');
    // Another project's binding id is not this project's.
    expect(
      (
        await call(app, 'admin', 'PATCH', `/projects/p2/doppler/bindings/${billing.json().id}`, {
          isDefault: true,
        })
      ).statusCode,
    ).toBe(404);
  });

  // Members see what their project reads from; changing it reads Doppler with the
  // administrator's token, so it stays theirs.
  it('lets members read the bindings and only administrators change them', async () => {
    const app = server();
    const platform = await addConnection(app, 'Platform', 'dp.sa.platform');
    const added = await call(app, 'admin', 'POST', '/projects/p1/doppler/bindings', {
      connectionId: platform,
      dopplerProject: 'portal',
      dopplerConfig: 'prd',
    });
    expect((await call(app, 'reader', 'GET', '/projects/p1/doppler/bindings')).statusCode).toBe(
      200,
    );
    expect(
      (
        await call(app, 'manager', 'POST', '/projects/p1/doppler/bindings', {
          connectionId: platform,
          dopplerProject: 'portal',
          dopplerConfig: 'stg',
        })
      ).statusCode,
    ).toBe(403);
    const id = added.json().id;
    expect(
      (await call(app, 'manager', 'DELETE', `/projects/p1/doppler/bindings/${id}`)).statusCode,
    ).toBe(403);
    expect(
      (await call(app, 'admin', 'DELETE', `/projects/p1/doppler/bindings/${id}`)).statusCode,
    ).toBe(204);
  });
});
