import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { registerRepairRoutes, registerQASettingsRoutes } from './repair-routes.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(ctx.db);
  await ctx.store.upsertProject({
    id: 'a',
    owner: 'team',
    repo: 'app',
    containerName: 'app',
    state: 'active',
  });
});
describe('repair mandate routes', () => {
  it('requires execution permission to opt in and defaults to no mandate', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.localUserId = 'reader';
    });
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
    vi.spyOn(ctx.store, 'hasProjectPermission').mockImplementation(
      async (_user, _project, permission) => permission === 'read',
    );
    registerRepairRoutes(app, ctx.store);
    try {
      expect((await app.inject({ method: 'GET', url: '/projects/a/repairs' })).json()).toEqual({
        qaEnabled: false,
        mandate: null,
        incidents: [],
      });
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/projects/a/repairs',
            payload: { mode: 'automatic' },
          })
        ).statusCode,
      ).toBe(403);
      expect(await ctx.store.repairs.mandate('a')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it('needs the Code permission, not only execute, to approve or retry a repair', async () => {
    const granted = new Set(['read', 'execute']);
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.localUserId = 'editor';
    });
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
    vi.spyOn(ctx.store, 'hasProjectPermission').mockImplementation(async (_user, _project, p) =>
      granted.has(p),
    );
    registerRepairRoutes(app, ctx.store);
    const attempt = async () => [
      (
        await app.inject({
          method: 'POST',
          url: '/projects/a/repairs/approval',
          payload: { proposalId: 'missing', allow: true },
        })
      ).statusCode,
      (
        await app.inject({
          method: 'POST',
          url: '/projects/a/repairs/retry',
          payload: { incidentId: 'missing' },
        })
      ).statusCode,
    ];
    try {
      expect(await attempt()).toEqual([403, 403]);
      // With Code the request passes the permission check and meets the missing records.
      granted.add('code');
      expect(await attempt()).toEqual([409, 409]);
    } finally {
      await app.close();
    }
  });
  it('binds consent to the authenticated user and rejects an active-owner retry', async () => {
    await ctx.store.repairs.configureQA(true, 'admin');
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.localUserId = 'user';
    });
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
    vi.spyOn(ctx.store, 'hasProjectPermission').mockResolvedValue(true);
    registerRepairRoutes(app, ctx.store);
    try {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/projects/a/repairs',
            payload: { mode: 'automatic' },
          })
        ).statusCode,
      ).toBe(200);
      expect((await ctx.store.repairs.mandate('a'))?.sponsor_user_id).toBe('user');
      const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
      await ctx.store.repairs.claim(incident.id, 'session', 1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/projects/a/repairs/retry',
            payload: { incidentId: incident.id },
          })
        ).statusCode,
      ).toBe(409);
      await app.inject({ method: 'PUT', url: '/projects/a/repairs', payload: { mode: 'off' } });
      expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('off');
    } finally {
      await app.close();
    }
  });
});

it('requires administrator consent for the global switch and disables before cancellation', async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.localUserId = 'admin';
  });
  const admin = vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
  const cancel = vi.fn(async () => {
    expect((await ctx.store.repairs.qa()).enabled).toBe(false);
    return true;
  });
  registerQASettingsRoutes(app, ctx.store, cancel);
  try {
    expect(
      (await app.inject({ method: 'PUT', url: '/settings/qa', payload: { enabled: true } }))
        .statusCode,
    ).toBe(403);
    admin.mockResolvedValue(true);
    expect((await app.inject({ method: 'GET', url: '/settings/qa' })).json().enabled).toBe(false);
    await app.inject({ method: 'PUT', url: '/settings/qa', payload: { enabled: true } });
    // Switching QA off stops every project's running review.
    await ctx.store.repairs.configure('a', 'admin', 'automatic');
    await ctx.store.createSession({
      sessionId: 'qa',
      projectId: 'a',
      worktree: '/tmp/qa',
      model: 'm',
    });
    await ctx.store.repairs.projectQA.ensureRole('a');
    await ctx.store.repairs.projectQA.attachSession('a', 'qa');
    await ctx.store.repairs.projectQA.claimReview(
      'a',
      (await ctx.store.repairs.qa()).revision,
      '{}',
      0,
    );
    await app.inject({ method: 'PUT', url: '/settings/qa', payload: { enabled: false } });
    expect(cancel).toHaveBeenCalledWith('qa');
    expect((await ctx.store.repairs.qa()).sponsor).toBe('admin');
  } finally {
    await app.close();
  }
});

it('accepts retry only on a real eligible transition and rejects repeated or awaiting-merge requests', async () => {
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const evidence = JSON.stringify({
    observedAt: new Date().toISOString(),
    status: { pipeline: 'failure', headSha: 'sha' },
  });
  const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', evidence);
  await ctx.store.repairs.blockUnowned(incident.id);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.localUserId = 'user';
  });
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(true);
  registerRepairRoutes(app, ctx.store);
  const retry = () =>
    app.inject({
      method: 'POST',
      url: '/projects/a/repairs/retry',
      payload: { incidentId: incident.id },
    });
  try {
    expect((await retry()).statusCode).toBe(200);
    expect((await retry()).statusCode).toBe(409);
    await ctx.db
      .updateTable('repair_incidents')
      .set({ state: 'awaiting_merge' })
      .where('id', '=', incident.id)
      .execute();
    expect((await retry()).statusCode).toBe(409);
    await ctx.db
      .updateTable('repair_incidents')
      .set({ state: 'blocked', evidence: '{}' })
      .where('id', '=', incident.id)
      .execute();
    expect((await retry()).statusCode).toBe(409);
  } finally {
    await app.close();
  }
});
