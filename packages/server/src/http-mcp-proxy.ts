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
import {
  internalConnectionIdentity,
  internalConnectionGenerationSignal,
} from './internal-listener.js';
import type { McpGatewayCaller } from './mcp-gateway-tokens.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_EVENT_STREAM_LIFETIME_MS = 8 * 60 * 60_000;
const EVENT_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const MCP_TIMEOUT_MS = 60_000;
const BINDING_HEADER = 'x-verity-mcp-binding';
const RESPONSE_HEADERS = ['content-type', 'mcp-session-id'] as const;

class McpUpstreamFailure extends Error {
  constructor(
    readonly stage: 'connect' | 'headers' | 'response',
    readonly reason: 'timeout' | 'transport' | 'protocol',
  ) {
    super('MCP upstream request failed');
  }
}

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
  signal?: AbortSignal,
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: IncomingMessage;
  eventStream: boolean;
}> {
  const url = parseHttpMcpUpstream(connection.url);
  return new Promise((resolve, reject) => {
    let connected = false;
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        method,
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        agent: false,
        ...(signal === undefined ? {} : { signal }),
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
        const abortResponse = () => response.destroy(new Error('Project generation retired'));
        signal?.addEventListener('abort', abortResponse, { once: true });
        response.once('close', () => signal?.removeEventListener('abort', abortResponse));
        if (signal?.aborted) abortResponse();
        const safeHeaders: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string') safeHeaders[name] = value;
        }
        const eventStream = isHttpMcpEventStream(response.headers['content-type']);
        response.setTimeout(eventStream ? EVENT_STREAM_IDLE_TIMEOUT_MS : MCP_TIMEOUT_MS, () =>
          response.destroy(new McpUpstreamFailure('response', 'timeout')),
        );
        resolve({
          status: response.statusCode ?? 502,
          headers: safeHeaders,
          body: response,
          eventStream,
        });
      },
    );
    request.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        connected = true;
      });
    });
    request.setTimeout(MCP_TIMEOUT_MS, () =>
      request.destroy(new McpUpstreamFailure(connected ? 'headers' : 'connect', 'timeout')),
    );
    request.on('error', (error: Error) =>
      reject(
        error instanceof McpUpstreamFailure
          ? error
          : new McpUpstreamFailure(connected ? 'headers' : 'connect', 'transport'),
      ),
    );
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
    const generationSignal = internalConnectionGenerationSignal(request);
    const token = bearerToken(request.headers.authorization);
    const connectionId = request.headers[BINDING_HEADER];
    if (
      generationSignal?.aborted === true ||
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
      generationSignal?.aborted || caller === undefined
        ? undefined
        : await deps.resolveConnection({ projectId: identity.projectId, connectionId });
    if (generationSignal?.aborted || caller === undefined || connection === undefined) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const requestStarted = performance.now();
    const rpcMethod =
      typeof request.body === 'object' &&
      request.body !== null &&
      'method' in request.body &&
      typeof request.body.method === 'string' &&
      [
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
        'resources/read',
        'ping',
      ].includes(request.body.method)
        ? request.body.method
        : 'other';
    const context = { connectionId, rpcMethod };
    request.log.info({ ...context, stage: 'intercept' }, 'MCP proxy interception started');
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
      request.log.warn(
        { ...context, stage: 'intercept', elapsedMs: performance.now() - requestStarted },
        'MCP proxy request failed',
      );
      return reply.code(502).send({ error: 'MCP request could not be authorized' });
    }
    request.log.info(
      { ...context, stage: 'intercept', elapsedMs: performance.now() - requestStarted },
      'MCP proxy interception completed',
    );
    {
      // Every asynchronous credential/interception lookup can outlive retirement.
      const activeCaller = await deps.resolveCaller({ projectId: identity.projectId, token });
      if (generationSignal?.aborted) return reply.code(401).send({ error: 'MCP access changed' });
      const activeConnection = await deps.resolveConnection({
        projectId: identity.projectId,
        connectionId,
      });
      if (
        generationSignal?.aborted ||
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
    let upstreamStatus: number | undefined;
    let contentType: string | undefined;
    let headersMs: number | undefined;
    let firstByteMs: number | undefined;
    let upstreamEndMs: number | undefined;
    let streamed = 0;
    const upstreamStarted = performance.now();
    const diagnostics = () => ({
      ...context,
      upstreamStatus,
      contentType,
      headersMs,
      firstByteMs,
      upstreamEndMs,
      bytes: streamed,
      elapsedMs: performance.now() - upstreamStarted,
    });
    request.log.info({ ...context, stage: 'forward' }, 'MCP proxy forwarding started');
    try {
      const response = await forwardHttpMcp(
        connection,
        method,
        body,
        {
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
        },
        generationSignal,
      );
      upstreamStatus = response.status;
      // Log only recognized media types, never arbitrary upstream header values.
      const mediaType = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      contentType =
        mediaType === 'application/json' || mediaType === 'text/event-stream' ? mediaType : 'other';
      headersMs = performance.now() - upstreamStarted;
      request.log.info(
        { ...diagnostics(), stage: 'headers' },
        'MCP proxy upstream headers received',
      );
      response.body.once('end', () => {
        upstreamEndMs = performance.now() - upstreamStarted;
        request.log.info({ ...diagnostics(), stage: 'end' }, 'MCP proxy upstream body ended');
      });
      if (response.status >= 400) {
        request.log.warn(
          {
            stage: 'headers',
            ...diagnostics(),
            reason: response.status === 401 || response.status === 403 ? 'authorization' : 'http',
          },
          'MCP upstream rejected request',
        );
      }
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(response.status, response.headers);
      const maxBytes = response.eventStream ? MAX_EVENT_STREAM_BYTES : MAX_STREAM_BYTES;

      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (firstByteMs === undefined && chunk.byteLength > 0) {
            firstByteMs = performance.now() - upstreamStarted;
            request.log.info(
              { ...diagnostics(), stage: 'first-byte' },
              'MCP proxy upstream first body byte received',
            );
          }
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
      let authorizationDeadline: ReturnType<typeof setTimeout> | undefined;
      const authorizationPoll = response.eventStream
        ? setInterval(() => {
            // A live turn does not keep a removed project binding or a replaced
            // provider credential authorized. Serialize polls so a slow lookup
            // cannot accumulate concurrent credential resolutions.
            if (checkingAuthorization || response.body.destroyed) return;
            checkingAuthorization = true;
            authorizationDeadline = setTimeout(() => {
              response.body.destroy(new Error('HTTP MCP authority check deadline exceeded'));
            }, 1000);
            authorizationDeadline.unref();
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
                if (authorizationDeadline !== undefined) clearTimeout(authorizationDeadline);
                checkingAuthorization = false;
              }
            })();
          }, 500)
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
              try {
                yield* transformMcpResponse(source, response.eventStream, interception.transform);
              } catch (error) {
                // pipeline destroys the HTTP response with this error before the
                // outer catch runs. Keep Fastify's own error log credential-free too.
                throw error instanceof McpUpstreamFailure
                  ? error
                  : new McpUpstreamFailure(
                      'response',
                      error instanceof SyntaxError ? 'protocol' : 'transport',
                    );
              }
            },
            reply.raw,
          );
        }
      } finally {
        if (lifetime !== undefined) clearTimeout(lifetime);
        if (authorizationPoll !== undefined) clearInterval(authorizationPoll);
        if (authorizationDeadline !== undefined) clearTimeout(authorizationDeadline);
      }
      request.log.info({ ...diagnostics(), stage: 'complete' }, 'MCP proxy response completed');
      return reply;
    } catch (error) {
      // Error messages and URLs can contain connector credentials or query PINs.
      request.log.warn(
        {
          stage:
            error instanceof McpUpstreamFailure ? error.stage : hijacked ? 'response' : 'connect',
          reason:
            error instanceof McpUpstreamFailure
              ? error.reason
              : error instanceof SyntaxError
                ? 'protocol'
                : 'transport',
          ...diagnostics(),
        },
        'MCP proxy request failed',
      );
      if (hijacked) {
        reply.raw.destroy();
        return reply;
      }
      if (error instanceof McpOAuthAuthorizationRequired)
        return reply
          .code(401)
          .send({ error: 'mcp_oauth_authorization_required', message: error.message });
      if (error instanceof McpUpstreamFailure && error.reason === 'timeout')
        return reply.code(504).send({ error: `MCP upstream timed out during ${error.stage}` });
      reply.code(502);
      return { error: 'MCP upstream connection failed' };
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
      args[1].log.warn({ stage: 'resolve' }, 'MCP proxy connection resolution failed');
      return args[2].code(502).send({ error: 'MCP connection could not be resolved' });
    }
  };

  app.post('/internal/mcp-proxy', { bodyLimit: MAX_BODY_BYTES }, (request, reply) =>
    guardedHandle('POST', request, reply),
  );
  app.get('/internal/mcp-proxy', (request, reply) => guardedHandle('GET', request, reply));
  app.delete('/internal/mcp-proxy', (request, reply) => guardedHandle('DELETE', request, reply));
}
