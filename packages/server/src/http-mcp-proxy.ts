import { McpOAuthAuthorizationRequired } from './http-mcp-oauth-errors.js';
import { transformMcpResponse } from './mcp-apps-stream.js';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { bearerToken } from './auth.js';
import { internalConnectionIdentity } from './internal-listener.js';
import type { McpGatewayCaller } from './mcp-gateway-tokens.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_EVENT_STREAM_LIFETIME_MS = 8 * 60 * 60_000;
const EVENT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const MCP_TIMEOUT_MS = 60_000;
const BINDING_HEADER = 'x-verity-mcp-binding';
const RESPONSE_HEADERS = ['content-type', 'mcp-session-id'] as const;

export interface HttpMcpProxyConnection {
  id: string;
  url: string;
  /** Server-resolved short-lived authorization. Never persisted in a project binding. */
  authorization?: string;
}

export interface HttpMcpProxyDeps {
  intercept?: (input: {
    projectId: string;
    caller: McpGatewayCaller;
    connection: HttpMcpProxyConnection;
    body: unknown;
    protocolSessionId?: string;
    protocolVersion?: string;
  }) => Promise<{ body: unknown; transform: (message: unknown) => Promise<unknown> }>;
  resolveCaller(input: { projectId: string; token: string }): Promise<McpGatewayCaller | undefined>;
  resolveConnection(input: {
    projectId: string;
    connectionId: string;
  }): Promise<HttpMcpProxyConnection | undefined>;
}

export function isForbiddenHttpMcpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const normalized =
      parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
        ? (parsed as ipaddr.IPv6).toIPv4Address()
        : parsed;
    return normalized.range() !== 'unicast';
  } catch {
    return true;
  }
}

export function parseHttpMcpUpstream(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.port !== '' ||
    isIP(url.hostname) !== 0 ||
    url.hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
      url.hostname,
    )
  ) {
    throw new Error('invalid HTTP MCP upstream');
  }
  return url;
}

export function isHttpMcpEventStream(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

export async function forwardHttpMcp(
  connection: HttpMcpProxyConnection,
  method: 'POST' | 'GET' | 'DELETE',
  body: Buffer | undefined,
  headers: {
    accept?: string;
    contentType?: string;
    protocolVersion?: string;
    sessionId?: string;
    lastEventId?: string;
  },
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: IncomingMessage;
  eventStream: boolean;
}> {
  const url = parseHttpMcpUpstream(connection.url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        method,
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        agent: false,
        headers: {
          accept: headers.accept ?? 'application/json, text/event-stream',
          ...(body === undefined
            ? {}
            : {
                'content-type': headers.contentType ?? 'application/json',
                'content-length': String(body.byteLength),
              }),
          ...(headers.protocolVersion === undefined
            ? {}
            : { 'mcp-protocol-version': headers.protocolVersion }),
          ...(headers.sessionId === undefined ? {} : { 'mcp-session-id': headers.sessionId }),
          ...(headers.lastEventId === undefined ? {} : { 'last-event-id': headers.lastEventId }),
          ...(connection.authorization === undefined
            ? {}
            : { authorization: connection.authorization }),
        },
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (
              error !== null ||
              addresses.length === 0 ||
              addresses.some((a) => isForbiddenHttpMcpAddress(a.address))
            ) {
              callback(new Error('HTTP MCP upstream resolution rejected'), []);
              return;
            }
            if (typeof options === 'object' && options.all) {
              callback(null, addresses);
              return;
            }
            const first = addresses[0]!;
            callback(null, first.address, first.family);
          });
        },
      },
      (response) => {
        request.setTimeout(0);
        const safeHeaders: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string') safeHeaders[name] = value;
        }
        const eventStream = isHttpMcpEventStream(response.headers['content-type']);
        response.setTimeout(eventStream ? EVENT_STREAM_IDLE_TIMEOUT_MS : MCP_TIMEOUT_MS, () =>
          response.destroy(new Error('HTTP MCP upstream stream stalled')),
        );
        resolve({
          status: response.statusCode ?? 502,
          headers: safeHeaders,
          body: response,
          eventStream,
        });
      },
    );
    request.setTimeout(MCP_TIMEOUT_MS, () =>
      request.destroy(new Error('HTTP MCP upstream timeout')),
    );
    request.on('error', reject);
    request.end(body);
  });
}

export function registerHttpMcpProxyRoute(app: FastifyInstance, deps: HttpMcpProxyDeps): void {
  const handle = async (
    method: 'POST' | 'GET' | 'DELETE',
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const identity = internalConnectionIdentity(request);
    const token = bearerToken(request.headers.authorization);
    const connectionId = request.headers[BINDING_HEADER];
    if (
      identity === undefined ||
      token === undefined ||
      typeof connectionId !== 'string' ||
      connectionId.length > 128
    ) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const caller = await deps.resolveCaller({ projectId: identity.projectId, token });
    const connection =
      caller === undefined
        ? undefined
        : await deps.resolveConnection({ projectId: identity.projectId, connectionId });
    if (caller === undefined || connection === undefined) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    let interception;
    try {
      interception =
        method !== 'DELETE' && deps.intercept !== undefined
          ? await deps.intercept({
              projectId: identity.projectId,
              caller,
              connection,
              body: request.body,
              ...(typeof request.headers['mcp-session-id'] === 'string'
                ? { protocolSessionId: request.headers['mcp-session-id'] }
                : {}),
              ...(typeof request.headers['mcp-protocol-version'] === 'string'
                ? { protocolVersion: request.headers['mcp-protocol-version'] }
                : {}),
            })
          : undefined;
    } catch {
      return reply.code(502).send({ error: 'MCP request could not be authorized' });
    }
    if (interception !== undefined) {
      const activeCaller = await deps.resolveCaller({ projectId: identity.projectId, token });
      const activeConnection = await deps.resolveConnection({
        projectId: identity.projectId,
        connectionId,
      });
      if (
        activeCaller?.sessionId !== caller.sessionId ||
        activeCaller.turnId !== caller.turnId ||
        activeConnection?.url !== connection.url ||
        activeConnection.authorization !== connection.authorization
      )
        return reply.code(401).send({ error: 'MCP access changed' });
    }
    const body =
      method === 'POST'
        ? Buffer.from(JSON.stringify(interception?.body ?? request.body))
        : undefined;
    let hijacked = false;
    try {
      const response = await forwardHttpMcp(connection, method, body, {
        ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
        ...(typeof request.headers['content-type'] === 'string'
          ? { contentType: request.headers['content-type'] }
          : {}),
        ...(typeof request.headers['mcp-protocol-version'] === 'string'
          ? { protocolVersion: request.headers['mcp-protocol-version'] }
          : {}),
        ...(typeof request.headers['mcp-session-id'] === 'string'
          ? { sessionId: request.headers['mcp-session-id'] }
          : {}),
        ...(typeof request.headers['last-event-id'] === 'string'
          ? { lastEventId: request.headers['last-event-id'] }
          : {}),
      });
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(response.status, response.headers);
      const maxBytes = response.eventStream ? MAX_EVENT_STREAM_BYTES : MAX_STREAM_BYTES;
      let streamed = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamed += chunk.byteLength;
          callback(
            streamed > maxBytes ? new Error('HTTP MCP upstream response too large') : null,
            chunk,
          );
        },
      });
      const lifetime = response.eventStream
        ? setTimeout(
            () => response.body.destroy(new Error('HTTP MCP event stream lifetime exceeded')),
            MAX_EVENT_STREAM_LIFETIME_MS,
          )
        : undefined;
      lifetime?.unref();
      let checkingAuthorization = false;
      const authorizationPoll = response.eventStream
        ? setInterval(() => {
            // A live turn does not keep a removed project binding or a replaced
            // provider credential authorized. Serialize polls so a slow lookup
            // cannot accumulate concurrent credential resolutions.
            if (checkingAuthorization || response.body.destroyed) return;
            checkingAuthorization = true;
            void (async () => {
              try {
                const activeCaller = await deps.resolveCaller({
                  projectId: identity.projectId,
                  token,
                });
                if (
                  activeCaller === undefined ||
                  activeCaller.sessionId !== caller.sessionId ||
                  activeCaller.turnId !== caller.turnId
                ) {
                  response.body.destroy(new Error('HTTP MCP proxy authorization expired'));
                  return;
                }
                const current = await deps.resolveConnection({
                  projectId: identity.projectId,
                  connectionId,
                });
                if (
                  current === undefined ||
                  current.id !== connection.id ||
                  current.url !== connection.url ||
                  current.authorization !== connection.authorization
                ) {
                  response.body.destroy(new Error('HTTP MCP proxy connection authority changed'));
                }
              } catch {
                response.body.destroy(new Error('HTTP MCP proxy authorization unavailable'));
              } finally {
                checkingAuthorization = false;
              }
            })();
          }, 1_000)
        : undefined;
      authorizationPoll?.unref();
      try {
        if (interception === undefined || response.status !== 200) {
          await pipeline(response.body, limiter, reply.raw);
        } else {
          await pipeline(
            response.body,
            limiter,
            async function* (source) {
              yield* transformMcpResponse(source, response.eventStream, interception.transform);
            },
            reply.raw,
          );
        }
      } finally {
        if (lifetime !== undefined) clearTimeout(lifetime);
        if (authorizationPoll !== undefined) clearInterval(authorizationPoll);
      }
      return reply;
    } catch (error) {
      if (hijacked) {
        reply.raw.destroy();
        return reply;
      }
      if (error instanceof McpOAuthAuthorizationRequired)
        return reply
          .code(401)
          .send({ error: 'mcp_oauth_authorization_required', message: error.message });
      reply.code(502);
      return { error: 'MCP upstream unavailable' };
    }
  };
  const guardedHandle: typeof handle = async (...args) => {
    try {
      return await handle(...args);
    } catch (error) {
      if (error instanceof McpOAuthAuthorizationRequired) {
        return args[2]
          .code(401)
          .send({ error: 'mcp_oauth_authorization_required', message: error.message });
      }
      return args[2].code(502).send({ error: 'MCP connection could not be resolved' });
    }
  };

  app.post('/internal/mcp-proxy', { bodyLimit: MAX_BODY_BYTES }, (request, reply) =>
    guardedHandle('POST', request, reply),
  );
  app.get('/internal/mcp-proxy', (request, reply) => guardedHandle('GET', request, reply));
  app.delete('/internal/mcp-proxy', (request, reply) => guardedHandle('DELETE', request, reply));
}
