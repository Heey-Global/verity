import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EventStore } from '@verity/store';
import { createTestDb } from '@verity/store/testing';
import { evaluateProjectEgress } from './project-egress-policy.js';
import { registerProjectEgressRoutes } from './project-egress-routes.js';
import { authorizePairedRoute } from './paired-route-policy.js';
const admin = '00000000-0000-4000-8000-000000000001';
let ctx: Awaited<ReturnType<typeof createTestDb>>;
const app = Fastify();
let userId: string | undefined = admin;
beforeAll(async () => {
  ctx = await createTestDb();
  await sql`insert into projects(id, owner, repo, container_name, kind, state, overview_visible)
    values ('a', 'o', 'r', 'a', 'local', 'absent', true)`.execute(ctx.db);
  app.addHook('preHandler', (request, _reply, done) => {
    request.localUserId = userId ?? null;
    done();
  });
  registerProjectEgressRoutes(app, new EventStore(ctx.db).projectEgress);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
});
it('registers management routes with explicit project rights', async () => {
  const permissions: string[] = [];
  const authority = {
    isActiveLocalUser: async () => true,
    isActiveAdministrator: async () => false,
    getSession: async () => undefined,
    hasProjectPermission: async (
      _user: string,
      _project: string,
      permission: 'read' | 'execute' | 'manage',
    ) => {
      permissions.push(permission);
      return true;
    },
  };
  for (const path of ['decisions', 'reopen', 'revoke', 'permanent', 'requests'])
    expect(
      await authorizePairedRoute(authority, admin, 'POST', '/projects/:id/egress/' + path, {
        id: 'a',
      }),
    ).toBe('allow');
  expect(permissions).toEqual(['manage', 'manage', 'manage', 'manage', 'execute']);
});
it('rejects missing identity, private targets and client-supplied authority', async () => {
  userId = undefined;
  expect((await app.inject({ method: 'GET', url: '/projects/a/egress' })).statusCode).toBe(403);
  userId = admin;
  for (const payload of [
    { host: '127.0.0.1', protocol: 'tcp', port: 443 },
    { host: 'example.com', protocol: 'tcp', port: 443, approvedBy: admin },
  ])
    expect(
      (await app.inject({ method: 'POST', url: '/projects/a/egress/requests', payload }))
        .statusCode,
    ).toBe(400);
});
it('never turns broker or system hostnames into direct rules or cards', async () => {
  userId = admin;
  const before = (await app.inject({ method: 'GET', url: '/projects/a/egress' })).json<{
    policy: { requests: Record<string, unknown> };
  }>();
  for (const [path, payload] of [
    ['requests', { host: 'API.GitHub.com', protocol: 'tcp', port: 443 }],
    ['reopen', { target: { host: 'www.googleapis.com', protocol: 'tcp', port: 443 }, revision: 0 }],
    [
      'permanent',
      { target: { host: 'registry.npmjs.org', protocol: 'tcp', port: 443 }, revision: 0 },
    ],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/a/egress/${path}`,
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'broker_required' });
  }
  const after = (await app.inject({ method: 'GET', url: '/projects/a/egress' })).json<{
    policy: { requests: Record<string, unknown> };
  }>();
  expect(after.policy.requests).toEqual(before.policy.requests);
});
it('refuses to approve a stored request for a broker destination', async () => {
  userId = admin;
  // Simulate a request recorded before classification existed.
  const created = await new EventStore(ctx.db).projectEgress.request('a', admin, {
    host: 'uploads.github.com',
    protocol: 'tcp',
    port: 443,
  });
  if (!('id' in created)) throw new Error('Expected a stored request');
  const approve = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/decisions',
    payload: { requestId: created.id, revision: created.revision, allow: true },
  });
  expect(approve.statusCode).toBe(403);
  expect(approve.json()).toMatchObject({ error: 'broker_required', route: 'forge' });
  const deny = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/decisions',
    payload: { requestId: created.id, revision: created.revision, allow: false },
  });
  expect(deny.statusCode).toBe(200);
});
it('creates and approves a draft rule without advertising enforcement or replay', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/requests',
    payload: { host: 'example.com', protocol: 'tcp', port: 443 },
  });
  expect(created.statusCode).toBe(200);
  const body = created.json<{ enforcement: string; request: { id: string; revision: number } }>();
  expect(body.enforcement).toBe('unavailable');
  const approved = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/decisions',
    payload: { requestId: body.request.id, revision: body.request.revision, allow: true },
  });
  expect(approved.statusCode).toBe(200);
  expect(approved.json()).toMatchObject({
    enforcement: 'unavailable',
    request: { status: 'allowed' },
  });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/projects/a/egress/decisions',
        payload: { requestId: body.request.id, revision: body.request.revision, allow: true },
      })
    ).statusCode,
  ).toBe(409);
});

it('requires a distinct settings operation for permanent grants and supports revocation', async () => {
  const read = await app.inject({ method: 'GET', url: '/projects/a/egress' });
  const revision = read.json<{ policy: { revision: number } }>().policy.revision;
  const permanent = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/permanent',
    payload: { target: { host: 'example.org', protocol: 'tcp', port: 443 }, revision },
  });
  expect(permanent.statusCode).toBe(200);
  const grant = permanent.json<{ grant: { id: string; expiresAt: number | null } }>().grant;
  expect(grant.expiresAt).toBeNull();
  const revoked = await app.inject({
    method: 'POST',
    url: '/projects/a/egress/revoke',
    payload: { grantId: grant.id, revision: revision + 1 },
  });
  expect(revoked.statusCode).toBe(200);
});

it('retains denial through the real JSONB persistence roundtrip', async () => {
  const store = new EventStore(ctx.db).projectEgress;
  const target = { host: 'denied.example.com', protocol: 'tcp' as const, port: 443 };
  const request = await store.request('a', admin, target);
  if ('covered' in request) throw new Error('unexpected coverage');
  await store.decide('a', admin, request.id, request.revision, false);
  const policy = await store.read('a', admin);
  expect(
    evaluateProjectEgress(
      {
        projectId: 'a',
        policyProjectId: 'a',
        identityCurrent: true,
        sponsorAuthorized: true,
        route: 'direct',
      },
      policy,
      target,
      Date.now(),
    ).decision,
  ).toBe('deny');
});
