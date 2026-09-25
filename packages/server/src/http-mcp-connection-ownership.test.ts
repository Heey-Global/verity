import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { EventStore, HttpMcpConnectionRecord } from '@verity/store';

import { registerHttpMcpConnectionRoutes } from './http-mcp-connections-route.js';

it('hides another user’s MCP connection from list, OAuth, binding, and delete routes', async () => {
  const ownerId = 'owner';
  const otherId = 'other';
  const connection: HttpMcpConnectionRecord = {
    id: 'private',
    ownerUserId: ownerId,
    name: 'private',
    url: 'https://mcp.example.test',
    authorization: 'Bearer secret',
    enabled: true,
  };
  const deleteConnection = vi.fn(async () => true);
  const createConnection = vi.fn(async () => undefined);
  const upsertBinding = vi.fn(async () => undefined);
  const deleteBinding = vi.fn(async () => true);
  const store = {
    listHttpMcpConnections: async (userId?: string) => (userId === ownerId ? [connection] : []),
    listProjectMcpBindings: async () => [
      { projectId: 'project', connectionId: connection.id, enabled: true },
    ],
    getProject: async () => ({ id: 'project' }),
    deleteHttpMcpConnection: deleteConnection,
    upsertHttpMcpConnection: createConnection,
    upsertProjectMcpBinding: upsertBinding,
    deleteProjectMcpBinding: deleteBinding,
  } as unknown as EventStore;
  const app = Fastify();
  app.decorateRequest('localUserId', null);
  app.addHook('onRequest', async (request) => {
    request.localUserId = String(request.headers['x-test-user'] ?? otherId);
  });
  registerHttpMcpConnectionRoutes(app, store);
  try {
    const headers = { 'x-test-user': otherId };
    const list = await app.inject({ method: 'GET', url: '/mcp-connections', headers });
    expect(list.json()).toEqual({ connections: [] });

    const oauth = await app.inject({
      method: 'POST',
      url: '/mcp-connections/private/oauth/complete',
      headers,
      payload: {
        code: 'code',
        codeVerifier: 'a'.repeat(43),
        redirectUri: 'https://verity.build/mcp/oauth/callback',
      },
    });
    expect(oauth.statusCode).toBe(404);

    const bindings = await app.inject({
      method: 'GET',
      url: '/projects/project/mcp-bindings',
      headers,
    });
    expect(bindings.json()).toEqual({ bindings: [] });
    const bind = await app.inject({
      method: 'PUT',
      url: '/projects/project/mcp-bindings/private',
      headers,
      payload: { enabled: true },
    });
    expect(bind.statusCode).toBe(404);
    expect(upsertBinding).not.toHaveBeenCalled();

    const removeForeignBinding = await app.inject({
      method: 'DELETE',
      url: '/projects/project/mcp-bindings/private',
      headers,
    });
    expect(removeForeignBinding.statusCode).toBe(404);
    expect(deleteBinding).not.toHaveBeenCalled();

    const remove = await app.inject({
      method: 'DELETE',
      url: '/mcp-connections/private',
      headers,
    });
    expect(remove.statusCode).toBe(404);
    expect(deleteConnection).not.toHaveBeenCalled();

    const ownerHeaders = { 'x-test-user': ownerId };
    const ownerList = await app.inject({
      method: 'GET',
      url: '/mcp-connections',
      headers: ownerHeaders,
    });
    expect(ownerList.json()).toMatchObject({ connections: [{ id: connection.id }] });
    const ownerBindings = await app.inject({
      method: 'GET',
      url: '/projects/project/mcp-bindings',
      headers: ownerHeaders,
    });
    expect(ownerBindings.json()).toEqual({
      bindings: [{ projectId: 'project', connectionId: connection.id, enabled: true }],
    });
    const ownerDeleteBinding = await app.inject({
      method: 'DELETE',
      url: '/projects/project/mcp-bindings/private',
      headers: ownerHeaders,
    });
    expect(ownerDeleteBinding.statusCode).toBe(204);
    expect(deleteBinding).toHaveBeenCalledWith('project', connection.id);

    const create = await app.inject({
      method: 'POST',
      url: '/mcp-connections',
      headers: ownerHeaders,
      payload: { name: 'mine', url: 'https://mcp.example.test/new' },
    });
    expect(create.statusCode).toBe(201);
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: ownerId, name: 'mine' }),
    );
  } finally {
    await app.close();
  }
});
