import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';
import type { LocalPreviewManager } from './local-preview-manager.js';
import { registerLocalPreviewRoutes } from './local-preview-routes.js';

function appFor(opts: { project: unknown; manager?: Partial<LocalPreviewManager> }) {
  const app = Fastify();
  registerLocalPreviewRoutes(app, {
    eventStore: { getProject: vi.fn(async () => opts.project) } as unknown as EventStore,
    ...(opts.manager ? { manager: opts.manager as LocalPreviewManager } : {}),
  });
  return app;
}

describe('project local preview listing', () => {
  it('lists the project shares so the session list needs no read per session', async () => {
    const share = { id: 'l1', projectId: 'p1', sessionId: 's1', url: 'http://h:18100/' };
    const listProject = vi.fn(() => [share]);
    const response = await appFor({
      project: { id: 'p1' },
      manager: { listProject } as never,
    }).inject({ method: 'GET', url: '/projects/p1/local-shares' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ shares: [share] });
    expect(listProject).toHaveBeenCalledWith('p1');
  });

  it('answers an empty list when the local preview runtime is absent', async () => {
    // The list polls this for every project; a Core without the runtime must not
    // turn that poll into an error the phone has to tell apart from a real one.
    const response = await appFor({ project: { id: 'p1' } }).inject({
      method: 'GET',
      url: '/projects/p1/local-shares',
    });
    expect(response.json()).toEqual({ shares: [] });
  });

  it('404s an unknown project without reaching the manager', async () => {
    const listProject = vi.fn(() => []);
    const response = await appFor({
      project: undefined,
      manager: { listProject },
    }).inject({ method: 'GET', url: '/projects/missing/local-shares' });
    expect(response.statusCode).toBe(404);
    expect(listProject).not.toHaveBeenCalled();
  });
});
