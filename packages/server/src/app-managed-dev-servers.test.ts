import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { InMemoryEventBus } from '@verity/session';
import { expect, it, vi } from 'vitest';
import { buildControlPlane, type ControlPlaneDeps } from './app.js';
import { markInternalConnections } from './internal-listener.js';

// Direct route tests cannot catch a manager dropped by the composition layer.
it('forwards the managed server manager to app and agent routes', async () => {
  const binding = { projectId: 'p1', containerGeneration: 'g1', owner: 'o', repo: 'r' };
  const view = vi.fn<(sessionId: string) => Promise<never[]>>(async () => []);
  const app = buildControlPlane({
    eventStore: {
      getSession: async () => ({ projectId: 'p1' }),
      listMovePreviewRestarts: async () => [],
    } as unknown as ControlPlaneDeps['eventStore'],
    bus: new InMemoryEventBus(),
    managedDevServerManager: { view } as unknown as NonNullable<
      ControlPlaneDeps['managedDevServerManager']
    >,
    ghTokenCapabilities: { resolve: async () => binding } as unknown as NonNullable<
      ControlPlaneDeps['ghTokenCapabilities']
    >,
  });
  const connections = new EventEmitter();
  markInternalConnections(connections as unknown as Server, binding);
  app.addHook('onRequest', async (request) => {
    connections.emit('connection', request.raw.socket);
  });
  try {
    const listed = await app.inject({ method: 'GET', url: '/sessions/s1/managed-dev-servers' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ servers: [] });
    const agent = await app.inject({
      method: 'POST',
      url: '/internal/dev-servers',
      headers: { authorization: 'Bearer good' },
      payload: { action: 'list', sessionId: 's1' },
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.json()).toEqual({ servers: [] });
    expect(view.mock.calls).toEqual([['s1'], ['s1']]);
  } finally {
    await app.close();
  }
});
