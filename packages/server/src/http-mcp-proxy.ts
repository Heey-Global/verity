import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

import type { FastifyInstance } from 'fastify';

import { bearerToken } from './auth.js';
import { internalConnectionIdentity } from './internal-listener.js';
import type { McpGatewayCaller } from './mcp-gateway-tokens.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
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
  resolveCaller(input: { projectId: string; token: string }): Promise<McpGatewayCaller | undefined>;
  resolveConnection(input: {
    projectId: string;
    connectionId: string;
  }): Promise<HttpMcpProxyConnection | undefined>;
}

function forbiddenIpv4(address: string): boolean {
  const p = address.split('.').map(Number);
  return (
    p.length !== 4 ||
    p.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2]! <= 2) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51)) ||
    (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
    p[0]! >= 224
  );
}

function forbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return forbiddenIpv4(address);
  if (family !== 6) return true;
  let normalized = address.toLowerCase();
  try {
    normalized = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  // Global unicast is 2000::/3. Deny special-use and local families by default.
  if (!/^[23][0-9a-f]{0,3}(?::|$)/u.test(normalized)) return true;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:')
  );
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

async function forward(
  connection: HttpMcpProxyConnection,
  body: Buffer,
  headers: {
    accept?: string;
    contentType?: string;
    protocolVersion?: string;
    sessionId?: string;
  },
): Promise<{ status: number; headers: Record<string, string>; body: IncomingMessage }> {
  const url = parseHttpMcpUpstream(connection.url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        method: 'POST',
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        agent: false,
        headers: {
          accept: headers.accept ?? 'application/json, text/event-stream',
          'content-type': headers.contentType ?? 'application/json',
          'content-length': String(body.byteLength),
          ...(headers.protocolVersion === undefined
            ? {}
            : { 'mcp-protocol-version': headers.protocolVersion }),
          ...(headers.sessionId === undefined ? {} : { 'mcp-session-id': headers.sessionId }),
          ...(connection.authorization === undefined
            ? {}
            : { authorization: connection.authorization }),
        },
        lookup: (hostname, _options, callback) => {
          dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (
              error !== null ||
              addresses.length === 0 ||
              addresses.some((a) => forbiddenAddress(a.address))
            ) {
              callback(new Error('HTTP MCP upstream resolution rejected'), []);
              return;
            }
            const first = addresses[0]!;
            callback(null, first.address, first.family);
          });
        },
      },
      (response) => {
        request.setTimeout(0);
        response.setTimeout(MCP_TIMEOUT_MS, () =>
          response.destroy(new Error('HTTP MCP upstream stream stalled')),
        );
        const safeHeaders: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string') safeHeaders[name] = value;
        }
        resolve({ status: response.statusCode ?? 502, headers: safeHeaders, body: response });
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
  app.post('/internal/mcp-proxy', { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
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
    const body = Buffer.from(JSON.stringify(request.body));
    let hijacked = false;
    try {
      const response = await forward(connection, body, {
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
      });
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(response.status, response.headers);
      let streamed = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamed += chunk.byteLength;
          callback(
            streamed > MAX_STREAM_BYTES ? new Error('HTTP MCP upstream response too large') : null,
            chunk,
          );
        },
      });
      await pipeline(response.body, limiter, reply.raw);
      return reply;
    } catch {
      if (hijacked) {
        reply.raw.destroy();
        return reply;
      }
      reply.code(502);
      return { error: 'MCP upstream unavailable' };
    }
  });
  // Stateless upstreams have no server-initiated stream. MCP clients treat 405 as the
  // protocol-compatible signal to continue without one, matching the built-in gateway.
  app.get('/internal/mcp-proxy', async (request, reply) => {
    if (internalConnectionIdentity(request) === undefined) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    reply.code(405).header('allow', 'POST');
    return { error: 'method_not_allowed' };
  });
}
