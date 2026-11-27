import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventStore, createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatNetworkShareAddress,
  installNetworkShares,
  parseNetworkShareAddress,
} from './network-share-routes.js';
import { NetworkShareError, type NetworkShareClient, type SmbTarget } from './network-share-smb.js';
import { authorizePairedRoute } from './paired-route-policy.js';

let ctx: TestDb;
let store: EventStore;
beforeAll(async () => {
  ctx = await createTestDb();
  store = new EventStore(ctx.db, createSecretCipher('ab'.repeat(32)));
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

/** A share with two folders that accepts the password "pw" for "verity". */
function fakeClient() {
  const seen: { password: string; host: string; share: string }[] = [];
  const check = (target: SmbTarget) => {
    seen.push({
      password: target.password.toString(),
      host: target.host,
      share: target.share,
    });
    if (target.host === 'offline.lan') throw new NetworkShareError('unreachable');
    if (target.password.toString() !== 'pw') throw new NetworkShareError('sign_in_failed');
  };
  const client: NetworkShareClient = {
    test: vi.fn(async (target: SmbTarget) => check(target)),
    list: vi.fn(async (target: SmbTarget, path: string) => {
      check(target);
      if (path === '')
        return [
          { name: 'Projects', kind: 'folder' as const, size: 0 },
          { name: 'notes.md', kind: 'file' as const, size: 3 },
        ];
      if (path === 'Projects') return [{ name: 'Briefs', kind: 'folder' as const, size: 0 }];
      if (path === 'Projects/Briefs') return [];
      throw new NetworkShareError('not_found');
    }),
    info: vi.fn(),
    read: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  return { client, seen };
}

async function server(client: NetworkShareClient, sealed = false): Promise<FastifyInstance> {
  const app = Fastify();
  // Without a limiter CodeQL reports the authorizing test hook as an
  // unthrottled route handler (as in user-context-routes.test.ts).
  await app.register(rateLimit, { max: 1000, timeWindow: 60_000 });
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
  installNetworkShares(app, { store, client, isSealed: () => sealed });
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

const studio = {
  label: 'Studio NAS',
  address: 'smb://nas.studio.lan/team',
  username: 'verity',
  password: 'pw',
};

describe('parseNetworkShareAddress', () => {
  it('reads Finder and Explorer forms and drops the folder path', () => {
    expect(parseNetworkShareAddress('smb://NAS.studio.lan:4450/team/Projects')).toEqual({
      host: 'nas.studio.lan',
      port: 4450,
      share: 'team',
    });
    expect(parseNetworkShareAddress('\\\\nas\\Team Files\\x')).toEqual({
      host: 'nas',
      port: null,
      share: 'Team Files',
    });
    expect(parseNetworkShareAddress('smb://192.168.1.20/photo%20archive').share).toBe(
      'photo archive',
    );
    // `%` is literal outside the URL form, and the shown address reads back unchanged.
    expect(parseNetworkShareAddress('\\\\nas\\50%').share).toBe('50%');
    const shown = formatNetworkShareAddress({ host: 'nas', port: null, share: 'Q%31 x' });
    expect(parseNetworkShareAddress(shown).share).toBe('Q%31 x');
  });

  // Credentials in the address would end up in the stored host and in logs.
  it.each([
    'smb://user:pw@nas/team',
    'smb://nas',
    'nas',
    'smb://nas/',
    'smb://na$/team',
    'smb://nas:0/team',
  ])('rejects %j', (input) => {
    expect(() => parseNetworkShareAddress(input)).toThrow();
  });
});

describe('network share routes', () => {
  it('saves a share only after it connected, and never returns the password', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const refused = await call(app, 'admin', 'POST', '/network-shares', {
      ...studio,
      password: 'no',
    });
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toMatchObject({ code: 'sign_in_failed' });
    expect((await store.networkShares.listConnections()).length).toBe(0);

    const created = await call(app, 'admin', 'POST', '/network-shares', studio);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      label: 'Studio NAS',
      address: 'smb://nas.studio.lan/team',
      projectCount: 0,
    });
    const listed = await call(app, 'admin', 'GET', '/network-shares');
    expect(listed.body).not.toContain('"pw"');
    expect(listed.json().connections).toHaveLength(1);
  });

  // Every route but reading a project's folders reaches the NAS with the stored
  // account or changes what agents may do; a missing policy entry must fail here.
  it('keeps connections and folder grants with administrators', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    const folder = (
      await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
        connectionId: id,
        path: 'Projects',
      })
    ).json<{ id: string }>().id;
    const adminOnly: [Parameters<typeof call>[2], string, object?][] = [
      ['GET', '/network-shares'],
      ['POST', '/network-shares', studio],
      ['PATCH', `/network-shares/${id}`, { label: 'Renamed' }],
      ['DELETE', `/network-shares/${id}`],
      ['POST', `/network-shares/${id}/test`],
      ['GET', `/network-shares/${id}/folders`],
      ['POST', '/projects/p1/network-shares/folders', { connectionId: id, path: 'Projects' }],
      ['PATCH', `/projects/p1/network-shares/folders/${folder}`, { accessMode: 'read-write' }],
      ['DELETE', `/projects/p1/network-shares/folders/${folder}`],
    ];
    for (const user of ['manager', 'reader'])
      for (const [method, url, payload] of adminOnly)
        expect(
          (await call(app, user, method, url, payload)).statusCode,
          `${user} ${method} ${url}`,
        ).toBe(403);
    expect(
      (await call(app, 'reader', 'GET', '/projects/p1/network-shares/folders')).statusCode,
    ).toBe(200);
  });

  it('offers only folders that can be granted', async () => {
    const { client } = fakeClient();
    client.list = vi.fn(async () => [
      { name: 'Projects', kind: 'folder' as const, size: 0 },
      { name: 'Old.', kind: 'folder' as const, size: 0 },
      { name: 'a:b', kind: 'folder' as const, size: 0 },
    ]);
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    expect((await call(app, 'admin', 'GET', `/network-shares/${id}/folders`)).json()).toEqual({
      path: '',
      folders: [{ name: 'Projects', path: 'Projects' }],
    });
  });

  it('browses folders only and grants read only by default', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    const root = await call(app, 'admin', 'GET', `/network-shares/${id}/folders`);
    expect(root.json()).toEqual({ path: '', folders: [{ name: 'Projects', path: 'Projects' }] });
    const traversal = await call(
      app,
      'admin',
      'GET',
      `/network-shares/${id}/folders?path=Projects/../..`,
    );
    expect(traversal.statusCode).toBe(400);

    const granted = await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
      connectionId: id,
      path: '/Projects/Briefs',
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json()).toMatchObject({
      name: 'Briefs',
      path: 'Projects/Briefs',
      accessMode: 'read-only',
    });
    const missing = await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
      connectionId: id,
      path: 'Nope',
    });
    expect(missing.statusCode).toBe(404);

    const folder = granted.json<{ id: string }>().id;
    // Another project's route cannot reach this grant.
    expect(
      (
        await call(app, 'admin', 'PATCH', `/projects/p2/network-shares/folders/${folder}`, {
          accessMode: 'read-write',
        })
      ).statusCode,
    ).toBe(404);
    const changed = await call(
      app,
      'admin',
      'PATCH',
      `/projects/p1/network-shares/folders/${folder}`,
      {
        accessMode: 'read-write',
      },
    );
    expect(changed.json()).toMatchObject({ accessMode: 'read-write' });
    expect(
      (await call(app, 'admin', 'GET', '/network-shares')).json().connections[0].projectCount,
    ).toBe(1);
    expect(
      (await call(app, 'admin', 'DELETE', `/projects/p1/network-shares/folders/${folder}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(app, 'reader', 'GET', '/projects/p1/network-shares/folders')).json(),
    ).toEqual({
      folders: [],
    });
  });

  it('tests changed sign-in details before saving them and ends grants on a new target', async () => {
    const { client, seen } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
      connectionId: id,
      path: 'Projects',
    });
    const offline = await call(app, 'admin', 'PATCH', `/network-shares/${id}`, {
      address: 'smb://offline.lan/team',
      password: 'pw',
    });
    expect(offline.statusCode).toBe(502);
    expect((await store.networkShares.getConnection(id))?.host).toBe('nas.studio.lan');

    // The stored password is never sent to a new target.
    const withoutPassword = await call(app, 'admin', 'PATCH', `/network-shares/${id}`, {
      address: 'smb://attacker.example/archive',
    });
    expect(withoutPassword.json()).toMatchObject({ code: 'password_required' });
    expect(seen.some((attempt) => attempt.host === 'attacker.example')).toBe(false);
    const moved = await call(app, 'admin', 'PATCH', `/network-shares/${id}`, {
      address: 'smb://nas.studio.lan/archive',
      password: 'pw',
    });
    expect(moved.statusCode).toBe(200);
    expect(seen.at(-1)).toEqual({ password: 'pw', host: 'nas.studio.lan', share: 'archive' });
    const [folder] = (await call(app, 'admin', 'GET', '/projects/p1/network-shares/folders')).json<{
      folders: { stale: boolean }[];
    }>().folders;
    expect(folder?.stale).toBe(true);
  });

  // A change that lands between the route's first look and the test must not
  // carry the saved password to the address that look still showed.
  it('checks the password rule against the target it tests, not an earlier view', async () => {
    const { client, seen } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    const saved = await store.networkShares.getConnection(id);
    vi.spyOn(store.networkShares, 'getConnection').mockResolvedValueOnce({
      ...saved!,
      host: 'attacker.example',
      share: 'archive',
    });
    seen.length = 0;
    const response = await call(app, 'admin', 'PATCH', `/network-shares/${id}`, {
      address: 'smb://attacker.example/archive',
    });
    expect(response.json()).toMatchObject({ code: 'password_required' });
    expect(seen).toEqual([]);
    expect((await store.networkShares.getConnection(id))?.host).toBe('nas.studio.lan');
  });

  // Credentials reach smbclient through its environment, which cannot carry a
  // NUL; refused up front, they never reach the spawn that would echo them.
  it('refuses credentials the environment cannot carry', async () => {
    const { client, seen } = fakeClient();
    const app = await server(client);
    const nul = await call(app, 'admin', 'POST', '/network-shares', {
      ...studio,
      password: 'pw\u0000x',
    });
    expect(nul.statusCode).toBe(400);
    const control = await call(app, 'admin', 'POST', '/network-shares', {
      ...studio,
      username: 'ver\u0001ity',
    });
    expect(control.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it('reports a failed connection test without failing the request', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    await store.networkShares.updateConnection(id, { password: 'changed-on-nas' });
    const tested = await call(app, 'admin', 'POST', `/network-shares/${id}/test`);
    expect(tested.json()).toMatchObject({ ok: false, code: 'sign_in_failed' });
  });

  it('does not grant a folder checked on a target that changed meanwhile', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    const list = client.list;
    client.list = vi.fn(async (target: SmbTarget, path: string) => {
      const entries = await list(target, path);
      // Another administrator points the connection elsewhere during the check.
      await store.networkShares.updateConnection(id, { share: 'archive' });
      return entries;
    });
    const granted = await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
      connectionId: id,
      path: 'Projects',
    });
    expect(granted.statusCode).toBe(409);
    expect(await store.networkShares.projectFolders('p1')).toEqual([]);
  });

  // Each real test is a sign-in on the NAS; visiting the settings repeatedly
  // must not turn a changed NAS password into a lockout of the server's address.
  it('reuses a recent test result unless a fresh one is asked for', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    vi.mocked(client.test).mockClear();
    await call(app, 'admin', 'POST', `/network-shares/${id}/test`);
    await call(app, 'admin', 'POST', `/network-shares/${id}/test`);
    expect(client.test).toHaveBeenCalledTimes(1);
    await call(app, 'admin', 'POST', `/network-shares/${id}/test?fresh=1`);
    expect(client.test).toHaveBeenCalledTimes(2);
    await call(app, 'admin', 'PATCH', `/network-shares/${id}`, { password: 'pw' });
    vi.mocked(client.test).mockClear();
    await call(app, 'admin', 'POST', `/network-shares/${id}/test`);
    expect(client.test).toHaveBeenCalledTimes(1);
  });

  // A test that loaded the old details can finish after a change was saved;
  // caching its result would show the old outcome for the new details.
  it('does not cache a test that ran on details changed meanwhile', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    let finish: (() => void) | undefined;
    vi.mocked(client.test).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const running = call(app, 'admin', 'POST', `/network-shares/${id}/test`);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await call(app, 'admin', 'PATCH', `/network-shares/${id}`, { label: 'Renamed' });
    finish!();
    expect((await running).json()).toEqual({ ok: true });

    vi.mocked(client.test).mockClear();
    vi.mocked(client.test).mockRejectedValueOnce(new NetworkShareError('sign_in_failed'));
    expect((await call(app, 'admin', 'POST', `/network-shares/${id}/test`)).json()).toMatchObject({
      ok: false,
    });
    expect(client.test).toHaveBeenCalledTimes(1);
  });

  it('removes project access when the share is disconnected', async () => {
    const { client } = fakeClient();
    const app = await server(client);
    const { id } = (await call(app, 'admin', 'POST', '/network-shares', studio)).json<{
      id: string;
    }>();
    await call(app, 'admin', 'POST', '/projects/p1/network-shares/folders', {
      connectionId: id,
      path: 'Projects',
    });
    expect((await call(app, 'admin', 'DELETE', `/network-shares/${id}`)).statusCode).toBe(204);
    expect(await store.networkShares.projectFolders('p1')).toEqual([]);
  });
});
