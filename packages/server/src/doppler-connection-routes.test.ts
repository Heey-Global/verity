import { DopplerBindingsChangedError } from '@verity/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerDopplerConnectionRoutes } from './doppler-connection-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';

const binding = (
  id: string,
  connectionId: string,
  dopplerProject: string,
  dopplerConfig: string,
  isDefault = false,
) => ({
  id,
  projectId: 'p1',
  connectionId,
  connectionLabel: connectionId === 'platform' ? 'Platform' : 'Payments',
  dopplerProject,
  dopplerConfig,
  isDefault,
  createdAt: new Date(0),
});

function harness({
  changeBindings = false,
  workplaceSlug = null as string | null,
  personalWorkplace = null as string | null,
  instanceWorkplace = undefined as string | null | undefined,
} = {}) {
  const instanceToken =
    instanceWorkplace === undefined ? undefined : Buffer.from('instance-token-fixture');
  const tokens = new Map<string, string>();
  const validated = new Map<string, readonly string[]>();
  const bindings = [
    binding('b1', 'platform', 'demo', 'dev', true),
    binding('b2', 'platform', 'demo', 'stg'),
    binding('b3', 'payments', 'billing', 'dev'),
  ];
  const store = {
    isActiveAdministrator: async (userId: string) => userId === 'admin',
    dopplerConnections: {
      get: async () => ({ workplaceSlug, hasToken: instanceToken !== undefined }),
      tokenBytes: async () => instanceToken,
      list: async () => [
        { id: 'platform', hasToken: true },
        { id: 'payments', hasToken: false },
      ],
    },
    projectDopplerBindings: {
      list: async (projectId: string) => (projectId === 'p1' ? bindings : []),
    },
    userDopplerConnections: {
      statuses: async (userId: string, projectId: string) =>
        new Map(
          [...tokens.keys()]
            .filter((key) => key.startsWith(`${userId}/${projectId}/`))
            .map((key) => [
              key.split('/')[2]!,
              { updatedAt: new Date(0), validatedBindingIds: validated.get(key) ?? [] },
            ]),
        ),
      set: async (
        userId: string,
        projectId: string,
        connectionId: string,
        token: string,
        expectedBindingIds: readonly string[],
      ) => {
        expect(expectedBindingIds).toEqual(
          bindings.filter((binding) => binding.connectionId === connectionId).map(({ id }) => id),
        );
        if (changeBindings) throw new DopplerBindingsChangedError();
        const key = `${userId}/${projectId}/${connectionId}`;
        tokens.set(key, token);
        validated.set(key, expectedBindingIds);
      },
      delete: async (userId: string, projectId: string, connectionId: string) => {
        tokens.delete(`${userId}/${projectId}/${connectionId}`);
      },
    },
  };
  // A token reads the configs of its own connection only.
  const readable: Record<string, string[]> = {
    'dp.st.good': ['demo/dev', 'demo/stg'],
    'dp.st.dev-only': ['demo/dev'],
    'dp.st.billing': ['billing/dev'],
  };
  const listNames = vi.fn(
    async (input: { dopplerProject: string; dopplerConfig: string; token: Uint8Array }) => {
      const configs = readable[Buffer.from(input.token).toString()] ?? [];
      if (!configs.includes(`${input.dopplerProject}/${input.dopplerConfig}`))
        throw new Error('403');
      return ['API_KEY'];
    },
  );
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
          userId !== 'reader' || permission === 'read',
        getSession: async () => undefined,
      },
      request.localUserId!,
      request.method,
      request.routeOptions.url!,
      request.params as Record<string, unknown>,
    );
    if (outcome !== 'allow') return reply.code(403).send();
  });
  const workplace = vi.fn(async (token: string) => ({
    slug: token === 'instance-token-fixture' ? (instanceWorkplace ?? null) : personalWorkplace,
  }));
  registerDopplerConnectionRoutes(app, { store: store as never, listNames, workplace });
  return { app, tokens, listNames, bindings, workplace, instanceToken };
}

const put = (app: FastifyInstance, user: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: '/projects/p1/doppler/connection',
    headers: { 'x-test-user': user },
    payload: payload as object,
  });

describe('personal Doppler connection routes', () => {
  it.each(['other-workplace', null])(
    'refuses workplace %s for an identified connection',
    async (personalWorkplace) => {
      const { app, tokens, listNames, workplace } = harness({
        workplaceSlug: 'northstar',
        personalWorkplace,
      });
      try {
        const update = await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' });
        expect(update.statusCode).toBe(400);
        expect(update.json().error).toContain('could not be verified');
        expect(workplace).toHaveBeenCalledTimes(1);
        expect(listNames).not.toHaveBeenCalled();
        expect(tokens.size).toBe(0);
      } finally {
        await app.close();
      }
    },
  );

  it('accepts a verified same-workplace token that can read the bound configs', async () => {
    const { app, tokens } = harness({ workplaceSlug: 'northstar', personalWorkplace: 'northstar' });
    try {
      expect(
        (await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' })).statusCode,
      ).toBe(200);
      expect(tokens.has('lena/p1/platform')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('derives workplace identity for a connection with a migrated instance token', async () => {
    const { app, tokens, workplace, instanceToken } = harness({
      instanceWorkplace: 'northstar',
      personalWorkplace: 'other-workplace',
    });
    try {
      const update = await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' });
      expect(update.statusCode).toBe(400);
      expect(workplace).toHaveBeenCalledTimes(2);
      expect(instanceToken).toEqual(Buffer.alloc(instanceToken!.length));
      expect(tokens.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects implicit token changes when a project uses multiple connections', async () => {
    const { app, tokens, listNames } = harness();
    try {
      const update = await put(app, 'lena', { token: 'dp.st.good' });
      const remove = await app.inject({
        method: 'DELETE',
        url: '/projects/p1/doppler/connection',
        headers: { 'x-test-user': 'lena' },
      });
      for (const response of [update, remove]) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toContain('Doppler connection picker');
      }
      expect(tokens.size).toBe(0);
      expect(listNames).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('asks the person to retry when bindings change during token validation', async () => {
    const { app, tokens } = harness({ changeBindings: true });
    try {
      const response = await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' });
      expect(response.statusCode).toBe(409);
      expect(tokens.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('flags saved tokens when the connection has newer bindings', async () => {
    const { app, bindings } = harness();
    try {
      expect(
        (await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' })).statusCode,
      ).toBe(200);
      bindings[1]!.id = 'new-binding-id';
      const response = await app.inject({
        url: '/projects/p1/doppler/connection',
        headers: { 'x-test-user': 'lena' },
      });
      expect(response.json()).toMatchObject({
        connections: [
          { connectionId: 'platform', connected: true, needsValidation: true },
          { connectionId: 'payments', connected: false, needsValidation: false },
        ],
      });
    } finally {
      await app.close();
    }
  });

  // The token is the person's own credential: it is stored for them alone, checked
  // against the project's configs first, and never returned.
  it('stores a working token for the signed-in person only and never returns it', async () => {
    const { app, tokens } = harness();
    expect(
      (await put(app, 'lena', { token: 'dp.st.wrong', connectionId: 'platform' })).statusCode,
    ).toBe(400);
    expect(tokens.size).toBe(0);
    expect((await put(app, 'lena', { token: 'dp.st.good', userId: 'admin' })).statusCode).toBe(400);

    const saved = await put(app, 'lena', { token: 'dp.st.good', connectionId: 'platform' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('dp.st.good');
    expect(saved.json()).toMatchObject({
      connected: true,
      canManageBindings: false,
      binding: { dopplerProject: 'demo', dopplerConfig: 'dev' },
      usesInstanceToken: false,
      connections: [
        { connectionId: 'platform', bindings: ['demo/dev', 'demo/stg'], connected: true },
        { connectionId: 'payments', bindings: ['billing/dev'], connected: false },
      ],
    });
    expect([...tokens.keys()]).toEqual(['lena/p1/platform']);

    const admin = await app.inject({
      url: '/projects/p1/doppler/connection',
      headers: { 'x-test-user': 'admin' },
    });
    expect(admin.json()).toMatchObject({
      connected: false,
      canManageBindings: true,
      usesInstanceToken: true,
      connections: [
        { connectionId: 'platform', usesInstanceToken: true },
        { connectionId: 'payments', usesInstanceToken: false },
      ],
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: '/projects/p1/doppler/connection?connectionId=platform',
      headers: { 'x-test-user': 'lena' },
    });
    expect(removed.statusCode).toBe(204);
    expect(tokens.size).toBe(0);
  });

  // One token stands in for every config the project binds on that connection, so
  // it must read all of them, and it never answers for another connection.
  it('keeps one token per connection and checks it against every config there', async () => {
    const { app, tokens } = harness();
    expect(
      (await put(app, 'lena', { token: 'dp.st.dev-only', connectionId: 'platform' })).statusCode,
    ).toBe(400);
    expect(
      (await put(app, 'lena', { token: 'dp.st.good', connectionId: 'payments' })).statusCode,
    ).toBe(400);
    const payments = await put(app, 'lena', { token: 'dp.st.billing', connectionId: 'payments' });
    expect(payments.statusCode).toBe(200);
    expect(payments.json()).toMatchObject({
      connected: false,
      connections: [
        { connectionId: 'platform', connected: false },
        { connectionId: 'payments', connected: true },
      ],
    });
    expect(
      (await put(app, 'lena', { token: 'dp.st.billing', connectionId: 'unbound' })).statusCode,
    ).toBe(409);
    expect([...tokens.keys()]).toEqual(['lena/p1/payments']);

    await app.inject({
      method: 'DELETE',
      url: '/projects/p1/doppler/connection?connectionId=payments',
      headers: { 'x-test-user': 'lena' },
    });
    expect(tokens.size).toBe(0);
  });

  it('needs execute permission on the project', async () => {
    const { app } = harness();
    expect((await put(app, 'reader', { token: 'dp.st.good' })).statusCode).toBe(403);
  });
});
