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
});
