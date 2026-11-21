import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { registerProjectQARoutes } from './project-qa-routes.js';
import { registerRepairRoutes } from './repair-routes.js';

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
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.configure('a', 'admin', 'automatic');
});

/** An app acting as `user` with the given project permissions. */
function app(permissions: readonly ('read' | 'execute' | 'manage')[], admin = false) {
  const server = Fastify();
  server.addHook('preHandler', async (request) => {
    request.localUserId = 'user';
  });
  vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(admin);
  vi.spyOn(ctx.store, 'hasProjectPermission').mockImplementation(async (_user, _project, p) =>
    permissions.includes(p),
  );
  const changed = vi.fn();
  registerProjectQARoutes(server, ctx.store, changed);
  registerRepairRoutes(server, ctx.store);
  return { server, changed };
}

async function stoppedIssue() {
  await ctx.store.repairs.observe(
    'a',
    'pr:88',
    'sha',
    '{"status":{"checks":{"failed":2,"total":9}}}',
  );
  const [issue] = await ctx.store.repairs.projectQA.issues('a');
  await ctx.store.repairs.projectQA.stop('a', issue!.id, 'beyond-mandate', 'Needs a migration');
  return issue!;
}

it('shows readers the QA state and its stopped issues, but lets only executors decide', async () => {
  const issue = await stoppedIssue();
  const reader = app(['read']);
  try {
    const state = (await reader.server.inject({ method: 'GET', url: '/projects/a/qa' })).json();
    expect(state).toMatchObject({
      enabled: true,
      coding: true,
      mode: 'automatic',
      sources: { pullRequests: { failing: 1, readable: false } },
    });
    expect(state.issues[0]).toMatchObject({
      key: 'pr:88',
      state: 'needs_you',
      reason: 'beyond-mandate',
      failing: '2 of 9 checks failed',
      roundsAllowed: 2,
    });
    const refused = await reader.server.inject({
      method: 'POST',
      url: `/projects/a/qa/issues/${issue.id}/decision`,
      payload: { decision: 'another_round' },
    });
    expect(refused.statusCode).toBe(403);
  } finally {
    await reader.server.close();
  }
  const executor = app(['read', 'execute']);
  try {
    const decided = await executor.server.inject({
      method: 'POST',
      url: `/projects/a/qa/issues/${issue.id}/decision`,
      payload: { decision: 'another_round' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().state.issues[0]).toMatchObject({ state: 'open', roundsAllowed: 3 });
    expect(executor.changed).toHaveBeenCalledWith('a');
    // Answered once: the issue no longer waits.
    const again = await executor.server.inject({
      method: 'POST',
      url: `/projects/a/qa/issues/${issue.id}/decision`,
      payload: { decision: 'defer' },
    });
    expect(again.statusCode).toBe(409);
  } finally {
    await executor.server.close();
  }
});

it('refuses a decision about another project’s issue', async () => {
  await ctx.store.upsertProject({
    id: 'b',
    owner: 'team',
    repo: 'site',
    containerName: 'site',
    state: 'active',
  });
  const issue = await stoppedIssue();
  const executor = app(['read', 'execute']);
  try {
    const response = await executor.server.inject({
      method: 'POST',
      url: `/projects/b/qa/issues/${issue.id}/decision`,
      payload: { decision: 'take_over' },
    });
    expect(response.statusCode).toBe(409);
    expect((await ctx.store.repairs.projectQA.issue('a', issue.id))?.state).toBe('needs_you');
  } finally {
    await executor.server.close();
  }
});

it('needs project management to switch QA off or pause it', async () => {
  const executor = app(['read', 'execute']);
  try {
    const refused = await executor.server.inject({
      method: 'PUT',
      url: '/projects/a/repairs',
      payload: { mode: 'off' },
    });
    expect(refused.statusCode).toBe(403);
  } finally {
    await executor.server.close();
  }
  const manager = app(['read', 'execute', 'manage']);
  try {
    const paused = await manager.server.inject({
      method: 'PUT',
      url: '/projects/a/repairs',
      payload: { mode: 'paused' },
    });
    expect(paused.statusCode).toBe(200);
    expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('paused');
  } finally {
    await manager.server.close();
  }
});

it('lets only administrators release the emergency brake', async () => {
  await ctx.store.repairs.projectQA.checkBrake();
  const member = app(['read', 'execute', 'manage']);
  try {
    const refused = await member.server.inject({
      method: 'POST',
      url: '/settings/qa/brake/release',
    });
    expect(refused.statusCode).toBe(403);
  } finally {
    await member.server.close();
  }
  const admin = app([], true);
  try {
    const released = await admin.server.inject({
      method: 'POST',
      url: '/settings/qa/brake/release',
    });
    expect(released.statusCode).toBe(200);
    expect(await ctx.store.repairs.projectQA.brake()).toBeNull();
  } finally {
    await admin.server.close();
  }
});
