import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerVerityControlSessionRoute } from './verity-control-session-route.js';
import type { EventStore } from '@verity/store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Verity Control session route', () => {
  it('migrates and reuses an existing legacy session through the renamed endpoint', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'verity-control-test-'));
    const app = Fastify();
    const renameSession = vi.fn(async () => undefined);
    const add = vi.fn();
    registerVerityControlSessionRoute(app, {
      eventStore: {
        listSessions: async () => [
          { sessionId: 'legacy', name: 'Concierge', projectId: null, worktree },
        ],
        renameSession,
      } as unknown as EventStore,
      defaultModel: 'test-model',
      worktrees: { add, remove: vi.fn() },
      makeBranch: (name) => name,
      deleteSessionEverywhere: vi.fn(),
      advancedModeEnabled: async () => false,
      ensureControlProject: vi.fn(),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/verity-control/session' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sessionId: 'legacy' });
      expect(renameSession).toHaveBeenCalledWith('legacy', 'Verity Control');
      expect(add).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/concierge/session' })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
      await rm(worktree, { recursive: true, force: true });
    }
  });

  // A member's Control session would otherwise address its questions to the
  // project's creator instead of to them.
  it('records who opens a Control session in advanced mode', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.localUserId = 'mara';
    });
    const createSession = vi.fn(async () => undefined);
    registerVerityControlSessionRoute(app, {
      eventStore: { createSession } as unknown as EventStore,
      defaultModel: 'test-model',
      worktrees: { add: async () => '/wt/control', remove: vi.fn() },
      makeBranch: (name) => name,
      deleteSessionEverywhere: vi.fn(),
      advancedModeEnabled: async () => true,
      ensureControlProject: async () => ({ id: 'control' }) as never,
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/verity-control/session' });
      expect(response.statusCode, response.body).toBe(201);
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'control', createdByUserId: 'mara' }),
      );
    } finally {
      await app.close();
    }
  });
});
