import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizePairedRoute } from './paired-route-policy.js';
import { registerProjectTeamRoutes } from './project-team-routes.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await ctx.db
    .insertInto('users')
    .values([
      { id: ADMIN, role: 'administrator', status: 'active' },
      { id: 'reader', role: 'member', status: 'active' },
    ])
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  await ctx.store.upsertProject({
    id: 'p1',
    owner: 'acme',
    repo: 'app',
    containerName: 'verity-acme--app',
    state: 'active',
  });
  await ctx.db
    .insertInto('project_memberships')
    .values({
      project_id: 'p1',
      user_id: 'reader',
      can_read: true,
      can_execute: false,
      can_manage: false,
    })
    .execute();
});

function server(onMemberRemoved = vi.fn(async () => undefined)) {
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-test-user']);
  });
  // The real route policy against the real memberships.
  app.addHook('preHandler', async (request, reply) => {
    const outcome = await authorizePairedRoute(
      ctx.store,
      request.localUserId!,
      request.method,
      request.routeOptions.url!,
      request.params as Record<string, unknown>,
    );
    if (outcome !== 'allow') return reply.code(outcome === 'not_found' ? 404 : 403).send();
  });
  registerProjectTeamRoutes(app, {
    store: ctx.store,
    projectName: async () => 'app',
    onMemberRemoved,
    linkIdentity: () => ({
      serverId: 'srv_EREREREREREREREREREREQ',
      identityKey: 'MCowBQYDK2VwAyEAERERERERERERERERERERERERERERERERERERERE',
      uplinkOrigin: 'https://uplink.verity.build',
      installationId: '0b7f6e5d-4c3b-4a29-8817-161514131211',
      installationHandle: 'EREREREREREREREREREREQ',
    }),
  });
  return { app, onMemberRemoved };
}

const as = (
  app: FastifyInstance,
  user: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, headers: { 'x-test-user': user }, ...(payload ? { payload } : {}) });

describe('project team routes', () => {
  // Only someone who manages the project may see or change its team; a person
  // who may only read it must not invite anyone or change rights.
  it('lets only a manager invite, list and change the team', async () => {
    const { app } = server();
    const created = await as(app, ADMIN, 'POST', '/projects/p1/invitations', {
      inviteeName: 'Lena',
      canExecute: true,
      inviterName: 'Holger',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      invitation: { inviteeName: 'Lena', canExecute: true, state: 'creating' },
      linkFields: null,
    });
    expect(created.body).not.toMatch(/secret/i);

    const team = await as(app, ADMIN, 'GET', '/projects/p1/team');
    expect(team.json<{ members: { userId: string }[] }>().members.map((m) => m.userId)).toEqual([
      ADMIN,
      'reader',
    ]);
    expect(team.json<{ invitations: unknown[] }>().invitations).toHaveLength(1);

    for (const [method, url, payload] of [
      ['GET', '/projects/p1/team', undefined],
      ['POST', '/projects/p1/invitations', { inviteeName: 'Max', canExecute: false }],
      ['PATCH', '/projects/p1/members/reader', { canExecute: true, canManage: true }],
      ['DELETE', '/projects/p1/members/reader', undefined],
    ] as const)
      expect((await as(app, 'reader', method, url, payload)).statusCode).toBe(403);
  });

  it('changes and removes a member, revokes an invitation, and never touches the creator', async () => {
    const { app, onMemberRemoved } = server();
    const raised = await as(app, ADMIN, 'PATCH', '/projects/p1/members/reader', {
      canExecute: true,
      canManage: false,
    });
    expect(raised.json()).toMatchObject({ member: { canExecute: true, canManage: false } });
    expect(onMemberRemoved).not.toHaveBeenCalled();
    // Down to reading ends what they had running, as removal does.
    await as(app, ADMIN, 'PATCH', '/projects/p1/members/reader', {
      canExecute: false,
      canManage: false,
    });
    expect(onMemberRemoved).toHaveBeenCalledTimes(1);
    expect(
      (
        await as(app, ADMIN, 'PATCH', `/projects/p1/members/${ADMIN}`, {
          canExecute: false,
          canManage: false,
        })
      ).statusCode,
    ).toBe(409);
    expect((await as(app, ADMIN, 'DELETE', '/projects/p1/members/reader')).statusCode).toBe(204);
    expect(onMemberRemoved).toHaveBeenCalledWith('p1', 'reader');
    // A retry still ends access, in case the first attempt failed after removing them.
    expect((await as(app, ADMIN, 'DELETE', '/projects/p1/members/reader')).statusCode).toBe(404);
    expect(onMemberRemoved).toHaveBeenCalledTimes(3);

    const created = await as(app, ADMIN, 'POST', '/projects/p1/invitations', {
      inviteeName: 'Lena',
      canExecute: false,
    });
    const id = created.json<{ invitation: { id: string } }>().invitation.id;
    expect((await as(app, ADMIN, 'DELETE', `/projects/p1/invitations/${id}`)).statusCode).toBe(204);
    expect((await as(app, ADMIN, 'DELETE', `/projects/p1/invitations/${id}`)).statusCode).toBe(404);
  });
  // The inviter's app completes the link with the pin and its server address;
  // everything else has to match the contract's link envelope exactly.
  it('hands the inviter every link field Core holds, but no pin or address', async () => {
    const { app } = server();
    const created = await as(app, ADMIN, 'POST', '/projects/p1/invitations', {
      inviteeName: 'Lena',
      canExecute: true,
    });
    const { id } = created.json<{ invitation: { id: string } }>().invitation;
    await ctx.store.projectTeam.markInvitationCreated(
      id,
      'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM',
      new Date(Date.now() + 3_600_000),
    );
    const read = await as(app, ADMIN, 'GET', `/projects/p1/invitations/${id}`);
    const fields = read.json<{ linkFields: Record<string, unknown> }>().linkFields;
    const envelope = (
      JSON.parse(
        readFileSync(
          new URL('../../../scripts/team-control-contract/wire-fixtures.json', import.meta.url),
          'utf8',
        ),
      ) as { schema: string; valid: boolean; value: Record<string, unknown> }[]
    ).find((fixture) => fixture.schema === 'invitationLink' && fixture.valid)!.value;
    expect(Object.keys(fields).sort()).toEqual(
      Object.keys(envelope)
        .filter((key) => key !== 'tlsPin' && key !== 'coreOrigin')
        .sort(),
    );
    expect(fields).toMatchObject({ purpose: 'team-member', display: { projectName: 'app' } });
  });
});
