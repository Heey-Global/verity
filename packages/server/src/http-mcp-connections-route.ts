import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';

const connectionParams = z.object({ connectionId: z.string().min(1).max(128) });
const projectConnectionParams = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1).max(128),
});
const connectionBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u)
      .refine((name) => name.toLowerCase() !== 'verity', 'the name verity is reserved'),
    url: z.string().max(2048),
    authorization: z.string().min(1).max(8192).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const bindingBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/** Global server definitions with explicit per-project activation. No credential value is public. */
export function registerHttpMcpConnectionRoutes(app: FastifyInstance, store: EventStore): void {
  app.get('/mcp-connections', async () => ({
    connections: (await store.listHttpMcpConnections()).map(({ authorization, ...connection }) => ({
      ...connection,
      authorizationConfigured: authorization !== null,
    })),
  }));

  app.post('/mcp-connections', async (request, reply) => {
    const body = connectionBody.parse(request.body);
    let url: string;
    try {
      url = parseHttpMcpUpstream(body.url).toString();
    } catch {
      reply.code(400);
      return { error: 'MCP connection URL must be a public HTTPS endpoint' };
    }
    const connection = {
      id: randomUUID(),
      name: body.name.toLowerCase(),
      url,
      authorization: body.authorization ?? null,
      enabled: body.enabled ?? true,
    };
    await store.upsertHttpMcpConnection(connection);
    reply.code(201);
    const { authorization, ...publicConnection } = connection;
    return {
      connection: {
        ...publicConnection,
        authorizationConfigured: authorization !== null,
      },
    };
  });

  app.delete('/mcp-connections/:connectionId', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    if (!(await store.deleteHttpMcpConnection(connectionId))) {
      reply.code(404);
      return { error: 'MCP connection not found' };
    }
    reply.code(204);
    return reply.send();
  });

  app.get('/projects/:id/mcp-bindings', async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { bindings: await store.listProjectMcpBindings(id) };
  });

  app.put('/projects/:id/mcp-bindings/:connectionId', async (request, reply) => {
    const { id, connectionId } = projectConnectionParams.parse(request.params);
    if ((await store.getProject(id)) === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (!(await store.listHttpMcpConnections()).some((entry) => entry.id === connectionId)) {
      reply.code(404);
      return { error: 'MCP connection not found' };
    }
    const body = bindingBody.parse(request.body);
    const binding = {
      projectId: id,
      connectionId,
      enabled: body.enabled,
    };
    try {
      await store.upsertProjectMcpBinding(binding);
    } catch (error) {
      if (error instanceof Error && error.message === 'project MCP connection limit exceeded') {
        reply.code(409);
        return { error: 'a project may enable at most 16 MCP connections' };
      }
      throw error;
    }
    return { binding };
  });

  app.delete('/projects/:id/mcp-bindings/:connectionId', async (request, reply) => {
    const { id, connectionId } = projectConnectionParams.parse(request.params);
    if (!(await store.deleteProjectMcpBinding(id, connectionId))) {
      reply.code(404);
      return { error: 'MCP binding not found' };
    }
    reply.code(204);
    return reply.send();
  });
}
