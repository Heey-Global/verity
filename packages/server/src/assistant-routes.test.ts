import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { registerAssistantRoutes } from './assistant-routes.js';

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

function server(userId: string) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.localUserId = userId;
  });
  const sessions = new Set<string>();
  const ensureSession = vi.fn(async () => {
    const id = await ctx.store.assistant.session('assistant-session');
    sessions.add(id);
    return id;
  });
  const cancel = vi.fn(async () => true);
  registerAssistantRoutes(app, ctx.store, {
    ensureSession,
    sessionExists: async (id) => sessions.has(id),
    cancel,
  });
  return { app, ensureSession, sessions, cancel };
}

describe('assistant settings routes', () => {
  it('lets only administrators read or change the assistant', async () => {
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
    const { app } = server('member');
    try {
      expect((await app.inject({ method: 'GET', url: '/settings/assistant' })).statusCode).toBe(
        403,
      );
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/settings/assistant',
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(403);
      expect((await ctx.store.assistant.settings()).enabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('creates the session only when switched on and reports granted projects', async () => {
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(true);
    const { app, ensureSession, sessions, cancel } = server('admin');
    try {
      expect((await app.inject({ method: 'GET', url: '/settings/assistant' })).json()).toEqual({
        enabled: false,
        sessionId: null,
        grants: [],
      });
      expect(ensureSession).not.toHaveBeenCalled();
      const enabled = await app.inject({
        method: 'PUT',
        url: '/settings/assistant',
        payload: { enabled: true },
      });
      expect(enabled.json()).toMatchObject({ enabled: true, sessionId: 'assistant-session' });
      await ctx.store.assistant.setGrant('a', 'admin', 'tasks');
      expect((await app.inject({ method: 'GET', url: '/settings/assistant' })).json()).toEqual({
        enabled: true,
        sessionId: 'assistant-session',
        grants: [{ projectId: 'a', mode: 'tasks' }],
      });
      // Capture reads this on every sheet; a read must never spawn a session, so a deleted
      // session is reported as missing until the switch is turned on again.
      sessions.clear();
      expect(
        (await app.inject({ method: 'GET', url: '/settings/assistant' })).json(),
      ).toMatchObject({ enabled: true, sessionId: null });
      expect(ensureSession).toHaveBeenCalledTimes(1);
      // Switching off stops a running turn, as QA does; tool calls are refused anyway.
      await app.inject({ method: 'PUT', url: '/settings/assistant', payload: { enabled: false } });
      expect(cancel).toHaveBeenCalledWith('assistant-session');
    } finally {
      await app.close();
    }
  });

  it('leaves the switch off when the session cannot be created', async () => {
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(true);
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.localUserId = 'admin';
    });
    registerAssistantRoutes(app, ctx.store, {
      ensureSession: async () => {
        throw new Error('Verity Control unavailable');
      },
      sessionExists: async () => false,
      cancel: async () => false,
    });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/assistant',
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(503);
      expect((await ctx.store.assistant.settings()).enabled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('assistant project routes', () => {
  it('needs execute permission and an enabled assistant to grant access', async () => {
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(false);
    const permission = vi
      .spyOn(ctx.store, 'hasProjectPermission')
      .mockImplementation(async (_user, _project, level) => level === 'read');
    const { app } = server('member');
    const grant = (mode: string) =>
      app.inject({ method: 'PUT', url: '/projects/a/assistant', payload: { mode } });
    try {
      expect((await app.inject({ method: 'GET', url: '/projects/a/assistant' })).json()).toEqual({
        assistantEnabled: false,
        mode: 'off',
      });
      expect((await grant('tasks')).statusCode).toBe(403);
      permission.mockResolvedValue(true);
      expect((await grant('tasks')).statusCode).toBe(409);
      await ctx.store.assistant.configure(true, 'admin');
      expect((await grant('delegate')).json()).toEqual({ mode: 'delegate' });
      expect(await ctx.store.assistant.grant('a')).toMatchObject({
        mode: 'delegate',
        sponsor_user_id: 'member',
      });
      // Revoking must stay possible after the assistant was switched off again.
      await ctx.store.assistant.configure(false, 'admin');
      expect((await grant('off')).json()).toEqual({ mode: 'off' });
    } finally {
      await app.close();
    }
  });

  it('never grants the assistant access to Verity Control itself', async () => {
    vi.spyOn(ctx.store, 'isActiveAdministrator').mockResolvedValue(true);
    await ctx.store.upsertProject({
      id: 'control',
      owner: 'verity',
      repo: 'control',
      containerName: 'control',
      state: 'active',
      kind: 'control_plane',
    });
    await ctx.store.assistant.configure(true, 'admin');
    const { app } = server('admin');
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/projects/control/assistant',
        payload: { mode: 'tasks' },
      });
      expect(response.statusCode).toBe(409);
      expect(await ctx.store.assistant.grant('control')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
