import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';
import { discoverMcpOAuth, registerMcpOAuthClient } from './http-mcp-oauth-discovery.js';
import { McpOAuthFlows, NATIVE_MCP_CALLBACK, mcpWebCallback } from './http-mcp-oauth-flows.js';

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
    oauthTokenAuthMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
    oauthClientSecret: z.string().trim().min(1).max(4096).nullable().optional(),
    oauthAuthorizationEndpoint: z.string().max(2048).nullable().optional(),
    oauthTokenEndpoint: z.string().max(2048).nullable().optional(),
    oauthScopes: z.string().trim().max(4096).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const oauthValues = [
      body.oauthClientId,
      body.oauthClientSecret,
      body.oauthTokenAuthMethod,
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

const legacyAdministratorId = '00000000-0000-4000-8000-000000000001';

function connectionOwnerId(request: { localUserId: string | null }): string {
  return request.localUserId ?? legacyAdministratorId;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** User-owned server definitions with explicit per-project activation. No credential value is public. */
export function registerHttpMcpConnectionRoutes(
  app: FastifyInstance,
  store: EventStore,
  options: {
    browserRequestOrigin?: ((request: FastifyRequest) => string | undefined) | undefined;
  } = {},
): void {
  const flows = new McpOAuthFlows(store);
  const trustedOrigin = (request: FastifyRequest) =>
    options.browserRequestOrigin?.(request) ?? `${request.protocol}://${request.headers.host}`;
  app.post('/mcp-connections/oauth/discover', async (request, reply) => {
    const body = z
      .object({ url: z.string().max(2048) })
      .strict()
      .parse(request.body);
    try {
      return (await discoverMcpOAuth(body.url)).discovery;
    } catch {
      return reply.code(400).send({
        error: 'OAuth discovery failed. Check the server URL or configure OAuth manually.',
      });
    }
  });
  app.get('/mcp-connections', async (request) => ({
    connections: (await store.listHttpMcpConnections(connectionOwnerId(request))).map(
      (connection) => ({
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
      }),
    ),
  }));

  app.post('/mcp-connections', async (request, reply) => {
    const body = connectionBody.parse(request.body);
    let url: string;
    try {
      url = parseHttpMcpUpstream(body.url).toString();
      if (body.authType === 'oauth') {
        if (
          body.oauthAuthorizationEndpoint == null ||
          body.oauthTokenEndpoint == null ||
          body.oauthClientId == null
        ) {
          const { authority, discovery } = await discoverMcpOAuth(url);
          // Do not send registration credentials to endpoints supplied by the form.
          if (
            (body.oauthAuthorizationEndpoint != null &&
              body.oauthAuthorizationEndpoint !== discovery.authorizationEndpoint) ||
            (body.oauthTokenEndpoint != null && body.oauthTokenEndpoint !== discovery.tokenEndpoint)
          )
            throw new Error('OAuth endpoints do not match discovery');
          body.oauthAuthorizationEndpoint = discovery.authorizationEndpoint;
          body.oauthTokenEndpoint = discovery.tokenEndpoint;
          body.oauthScopes ??= discovery.scopes;
          if (body.oauthClientId == null) {
            if (body.oauthClientSecret != null)
              throw new Error('A client secret requires a client ID');
            const callbacks = [NATIVE_MCP_CALLBACK];
            try {
              callbacks.push(mcpWebCallback(trustedOrigin(request)));
            } catch {
              if (request.headers.origin !== undefined)
                throw new Error('Web OAuth requires HTTPS or localhost');
            }
            const registered = await registerMcpOAuthClient(
              authority,
              callbacks,
              body.oauthScopes ?? '',
            );
            body.oauthClientId = registered.clientId;
            body.oauthClientSecret = registered.clientSecret;
            body.oauthTokenAuthMethod = registered.tokenAuthMethod;
          }
        }
        parseHttpMcpUpstream(body.oauthAuthorizationEndpoint);
        parseHttpMcpUpstream(body.oauthTokenEndpoint);
      }
    } catch {
      reply.code(400);
      return {
        error:
          'MCP setup failed. Use public HTTPS endpoints and a valid OAuth client, or configure OAuth manually.',
      };
    }
    const connection = {
      id: randomUUID(),
      ownerUserId: connectionOwnerId(request),
      name: body.name.toLowerCase(),
      url,
      authorization: body.authorization ?? null,
      authType: body.authType ?? (body.authorization == null ? 'none' : 'static'),
      oauthClientId: body.oauthClientId ?? null,
      oauthClientSecret: body.oauthClientSecret ?? null,
      oauthTokenAuthMethod: body.oauthTokenAuthMethod ?? 'client_secret_post',
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

  app.post('/mcp-connections/:connectionId/oauth/start', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    const body = z
      .object({ platform: z.enum(['web', 'native', 'native-staging']) })
      .strict()
      .parse(request.body);
    const ownerId = connectionOwnerId(request);
    const connection = (await store.listHttpMcpConnections(ownerId)).find(
      (item) => item.id === connectionId,
    );
    if (connection === undefined)
      return reply.code(404).send({ error: 'MCP connection not found' });
    reply.header('cache-control', 'no-store');
    try {
      return flows.start(ownerId, connection, body.platform, trustedOrigin(request));
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : 'MCP OAuth could not start' });
    }
  });

  app.post('/mcp-connections/:connectionId/oauth/cancel', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    const body = z
      .object({ state: z.string().min(1).max(128) })
      .strict()
      .parse(request.body);
    flows.cancel(connectionOwnerId(request), connectionId, body.state);
    return reply.code(204).send();
  });

  app.post('/mcp-connections/:connectionId/oauth/complete', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    const ownerId = connectionOwnerId(request);
    const connection = (await store.listHttpMcpConnections(ownerId)).find(
      (item) => item.id === connectionId,
    );
    if (connection === undefined)
      return reply.code(404).send({ error: 'MCP connection not found' });
    const body = z
      .object({ code: z.string().min(1).max(8192), state: z.string().min(1).max(128) })
      .strict()
      .parse(request.body);
    reply.header('cache-control', 'no-store');
    try {
      await flows.finish(ownerId, connection, body, trustedOrigin(request));
      return { connected: true };
    } catch {
      return reply
        .code(400)
        .send({ error: 'MCP OAuth authorization failed or expired. Reconnect OAuth.' });
    }
  });

  app.delete('/mcp-connections/:connectionId', async (request, reply) => {
    const { connectionId } = connectionParams.parse(request.params);
    if (
      !(await store.listHttpMcpConnections(connectionOwnerId(request))).some(
        (item) => item.id === connectionId,
      )
    ) {
      return reply.code(404).send({ error: 'MCP connection not found' });
    }
    if (!(await store.deleteHttpMcpConnection(connectionId))) {
      reply.code(404);
      return { error: 'MCP connection not found' };
    }
    reply.code(204);
    return reply.send();
  });

  app.get('/projects/:id/mcp-bindings', async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const ownedIds = new Set(
      (await store.listHttpMcpConnections(connectionOwnerId(request))).map((entry) => entry.id),
    );
    return {
      bindings: (await store.listProjectMcpBindings(id)).filter((binding) =>
        ownedIds.has(binding.connectionId),
      ),
    };
  });

  app.put('/projects/:id/mcp-bindings/:connectionId', async (request, reply) => {
    const { id, connectionId } = projectConnectionParams.parse(request.params);
    if ((await store.getProject(id)) === undefined) {
      reply.code(404);
      return { error: 'project not found' };
    }
    if (
      !(await store.listHttpMcpConnections(connectionOwnerId(request))).some(
        (entry) => entry.id === connectionId,
      )
    ) {
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
    if (
      !(await store.listHttpMcpConnections(connectionOwnerId(request))).some(
        (entry) => entry.id === connectionId,
      )
    ) {
      return reply.code(404).send({ error: 'MCP binding not found' });
    }
    if (!(await store.deleteProjectMcpBinding(id, connectionId))) {
      reply.code(404);
      return { error: 'MCP binding not found' };
    }
    reply.code(204);
    return reply.send();
  });
}
