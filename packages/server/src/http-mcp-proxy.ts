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

interface HttpMcpProxyConnection {
  id: string;
  url: string;
  /** Server-resolved short-lived authorization. Never persisted in a project binding. */
  authorization?: string;
}

export interface HttpMcpProxyDeps {
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
  return contentType?.toLowerCase().startsWith('text/event-stream') === true;
}

async function forward(
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
    if (connection === undefined) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const body = method === 'POST' ? Buffer.from(JSON.stringify(request.body)) : undefined;
    let hijacked = false;
    try {
      const response = await forward(connection, method, body, {
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
      const authorizationPoll = response.eventStream
        ? setInterval(() => {
            void deps
              .resolveCaller({ projectId: identity.projectId, token })
              .then((activeCaller) => {
                if (activeCaller === undefined) {
                  response.body.destroy(new Error('HTTP MCP proxy authorization expired'));
                }
              })
              .catch(() =>
                response.body.destroy(new Error('HTTP MCP proxy authorization unavailable')),
              );
          }, 1_000)
        : undefined;
      authorizationPoll?.unref();
      try {
        await pipeline(response.body, limiter, reply.raw);
      } finally {
        if (lifetime !== undefined) clearTimeout(lifetime);
        if (authorizationPoll !== undefined) clearInterval(authorizationPoll);
      }
      return reply;
    } catch {
      if (hijacked) {
        reply.raw.destroy();
        return reply;
      }
      reply.code(502);
      return { error: 'MCP upstream unavailable' };
    }
  };
  app.post('/internal/mcp-proxy', { bodyLimit: MAX_BODY_BYTES }, (request, reply) =>
    handle('POST', request, reply),
  );
  app.get('/internal/mcp-proxy', (request, reply) => handle('GET', request, reply));
  app.delete('/internal/mcp-proxy', (request, reply) => handle('DELETE', request, reply));
}
