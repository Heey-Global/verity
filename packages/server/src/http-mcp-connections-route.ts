import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EventStore } from '@verity/store';
import { z } from 'zod';

import { parseHttpMcpUpstream } from './http-mcp-proxy.js';
import { discoverMcpOAuth, registerMcpOAuthClient } from './http-mcp-oauth-discovery.js';
import { McpOAuthDiscoveryError } from './http-mcp-oauth-errors.js';
import { McpOAuthFlows, NATIVE_MCP_CALLBACK, mcpWebCallback } from './http-mcp-oauth-flows.js';

const connectionParams = z.object({ connectionId: z.string().min(1).max(128) });
const projectConnectionParams = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1).max(128),
});
/**
 * The name is a routing identifier, not a label: agents receive it as the MCP
 * server key, so it becomes part of tool names such as `mcp__<name>__<tool>` and
 * of Codex's `mcp_servers.<name>` table, which only accept these characters.
 * `verity` is the gateway's own server key.
 */
const connectionName = z
  .string()
  .trim()
  .min(1, 'Enter a connection name.')
  .max(80, 'Use at most 80 characters for the connection name.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
    'Use only letters, digits, hyphens and underscores in the connection name, starting with a letter or digit — for example heey-docs-privat.',
  )
  .refine((name) => name.toLowerCase() !== 'verity', 'The name verity is reserved.');

const connectionBody = z
  .object({
    name: connectionName,
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

function invalidConnectionMessage(issue: z.ZodError['issues'][number] | undefined): string {
  if (issue === undefined) return 'invalid request';
  if (issue.path[0] === 'name' || issue.code === 'custom') return issue.message;
  const field = issue.path.map(String).join('.');
  return field === '' ? 'invalid request' : `invalid ${field}`;
}

/**
 * A failed discovery or registration step as the form shows it, logged once with
 * its stage so the cause is visible on the server too. Unexpected errors keep a
 * generic answer: their messages are not written for users.
 */
function oauthSetupFailure(
  request: FastifyRequest,
  error: unknown,
  fallback: string,
): { error: string; code: string } {
  if (error instanceof McpOAuthDiscoveryError) {
    request.log.warn({ code: error.code, ...error.detail }, 'verity: MCP OAuth discovery failed');
    return { error: error.message, code: error.code };
  }
  request.log.warn(
    { errorName: error instanceof Error ? error.name : typeof error },
    'verity: MCP OAuth setup failed',
  );
  return { error: fallback, code: 'setup_failed' };
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
    } catch (error) {
      return reply
        .code(400)
        .send(
          oauthSetupFailure(
            request,
            error,
            'OAuth discovery failed. Check the server URL or configure OAuth manually.',
          ),
        );
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
    // The form needs to say which rule failed; the global handler only answers
    // "invalid request". Messages are this schema's own, never request content.
    const parsed = connectionBody.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: invalidConnectionMessage(issue) });
    }
    const body = parsed.data;
    let url: string;
    try {
      url = parseHttpMcpUpstream(body.url).toString();
      if (body.authType === 'oauth') {
        if (
          body.oauthAuthorizationEndpoint == null ||
          body.oauthTokenEndpoint == null ||
          body.oauthClientId == null
        ) {
          const { authority, discovery, internal } = await discoverMcpOAuth(url);
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
              undefined,
              internal !== false,
            );
            body.oauthClientId = registered.clientId;
            body.oauthClientSecret = registered.clientSecret;
            body.oauthTokenAuthMethod = registered.tokenAuthMethod;
          }
        }
        parseHttpMcpUpstream(body.oauthAuthorizationEndpoint);
        parseHttpMcpUpstream(body.oauthTokenEndpoint);
      }
    } catch (error) {
      reply.code(400);
      return oauthSetupFailure(
        request,
        error,
        'MCP setup failed. Use HTTPS endpoints Verity may reach and a valid OAuth client, or configure OAuth manually.',
      );
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
