import type { EventStore } from '@verity/store';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerProjectRepositoriesRoutes } from './project-repositories-routes.js';

it('validates remote access even when the caller supplies a default branch', async () => {
  const app = Fastify();
  const add = vi.fn();
  const defaultBranch = vi.fn().mockRejectedValue(new Error('access denied'));
  registerProjectRepositoriesRoutes(app, {
    store: {
      getProject: vi.fn().mockResolvedValue({ id: 'p', kind: 'github' }),
      addProjectRepository: add,
    } as unknown as EventStore,
    repositoryFor: vi.fn().mockResolvedValue({ operations: { defaultBranch } }),
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/projects/p/repositories',
      payload: {
        name: 'Private',
        kind: 'github',
        owner: 'team',
        repo: 'private',
        defaultBranch: 'main',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(defaultBranch).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
