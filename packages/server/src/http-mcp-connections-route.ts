import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';
import { completeHttpMcpOAuth } from './http-mcp-oauth.js';

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
    authType: z.enum(['none', 'static', 'oauth']).optional(),
    oauthClientId: z.string().trim().min(1).max(512).nullable().optional(),
    oauthClientSecret: z.string().trim().min(1).max(4096).nullable().optional(),
    oauthAuthorizationEndpoint: z.string().max(2048).nullable().optional(),
    oauthTokenEndpoint: z.string().max(2048).nullable().optional(),
    oauthScopes: z.string().trim().min(1).max(4096).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const oauthValues = [
      body.oauthClientId,
      body.oauthClientSecret,
      body.oauthAuthorizationEndpoint,
      body.oauthTokenEndpoint,
      body.oauthScopes,
    ];
    if (body.authType === 'static' && body.authorization == null) {
      ctx.addIssue({ code: 'custom', message: 'static authentication requires authorization' });
    }
    if (body.authType === 'oauth' && body.authorization != null) {
      ctx.addIssue({ code: 'custom', message: 'OAuth cannot include static authorization' });
    }
    if (body.authType !== 'oauth' && oauthValues.some((value) => value != null)) {
      ctx.addIssue({ code: 'custom', message: 'OAuth fields require OAuth authentication' });
    }
    if (body.authType === 'none' && body.authorization != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'unauthenticated connections cannot include credentials',
      });
    }
  });
const bindingBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Global server definitions with explicit per-project activation. No credential value is public. */
export function registerHttpMcpConnectionRoutes(app: FastifyInstance, store: EventStore): void {
  app.get('/mcp-connections', async () => ({
    connections: (await store.listHttpMcpConnections()).map((connection) => ({
      id: connection.id,
      name: connection.name,
      url: connection.url,
      enabled: connection.enabled,
      authType: connection.authType ?? (connection.authorization === null ? 'none' : 'static'),
      authorizationConfigured: connection.authorization !== null,
      oauthConnected: connection.oauthRefreshToken != null || connection.oauthAccessToken != null,
      oauthClientId: connection.oauthClientId ?? null,
      oauthAuthorizationEndpoint: connection.oauthAuthorizationEndpoint ?? null,
      oauthTokenEndpoint: connection.oauthTokenEndpoint ?? null,
      oauthScopes: connection.oauthScopes ?? null,
    })),
  }));

  app.post('/mcp-connections', async (request, reply) => {
    const body = connectionBody.parse(request.body);
    let url: string;
    try {
      url = parseHttpMcpUpstream(body.url).toString();
      if (body.authType === 'oauth') {
        if (
          body.oauthClientId == null ||
          body.oauthAuthorizationEndpoint == null ||
          body.oauthTokenEndpoint == null ||
          body.oauthScopes == null
        ) {
          throw new Error('incomplete OAuth configuration');
        }
        parseHttpMcpUpstream(body.oauthAuthorizationEndpoint);
        parseHttpMcpUpstream(body.oauthTokenEndpoint);
      }
    } catch {
      reply.code(400);
      return { error: 'MCP connection URL must be a public HTTPS endpoint' };
    }
    const connection = {
      id: randomUUID(),
      name: body.name.toLowerCase(),
      url,
      authorization: body.authorization ?? null,
      authType: body.authType ?? (body.authorization == null ? 'none' : 'static'),
      oauthClientId: body.oauthClientId ?? null,
      oauthClientSecret: body.oauthClientSecret ?? null,
      oauthAuthorizationEndpoint: body.oauthAuthorizationEndpoint ?? null,
      oauthTokenEndpoint: body.oauthTokenEndpoint ?? null,
      oauthScopes: body.oauthScopes ?? null,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
      enabled: body.enabled ?? true,
    };
    try {
      await store.upsertHttpMcpConnection(connection);
    } catch (error) {
      if (isUniqueViolation(error)) {
        reply.code(409);
        return { error: 'an MCP connection with this name already exists' };
      }
      throw error;
    }
    reply.code(201);
    return {
      connection: {
        id: connection.id,
        name: connection.name,
        url: connection.url,
        enabled: connection.enabled,
        authType: connection.authType,
        authorizationConfigured: connection.authorization !== null,
        oauthConnected: false,
        oauthClientId: connection.oauthClientId,
        oauthAuthorizationEndpoint: connection.oauthAuthorizationEndpoint,
        oauthTokenEndpoint: connection.oauthTokenEndpoint,
        oauthScopes: connection.oauthScopes,
      },
    };
  });

  app.post('/mcp-connections/:connectionId/oauth/complete', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    const body = z
      .object({
        code: z.string().min(1).max(8192),
        codeVerifier: z.string().min(43).max(128),
        redirectUri: z.literal('https://verity.build/mcp/oauth/callback'),
      })
      .strict()
      .parse(request.body);
    const connection = (await store.listHttpMcpConnections()).find(
      (item) => item.id === connectionId,
    );
    if (connection === undefined)
      return reply.code(404).send({ error: 'MCP connection not found' });
    try {
      await completeHttpMcpOAuth(store, connection, body);
      return { connected: true };
    } catch {
      return reply.code(400).send({ error: 'MCP OAuth authorization failed' });
    }
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
