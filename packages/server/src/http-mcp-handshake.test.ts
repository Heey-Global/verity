import Fastify from 'fastify';
import { Agent, createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpAppsInterceptor } from './mcp-apps.js';
import { registerHttpMcpProxyRoute } from './http-mcp-proxy.js';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));
vi.mock('./internal-listener.js', () => ({
  internalConnectionIdentity: () => ({ projectId: 'project', containerGeneration: 'generation' }),
}));

it.each([
  { sse: false, singleConnection: false },
  { sse: true, singleConnection: false },
  { sse: false, singleConnection: true },
])(
  'completes an SDK handshake and tool call ($sse SSE/session, $singleConnection single connection)',
  async ({ sse, singleConnection }) => {
    const agent = singleConnection ? new Agent({ keepAlive: true, maxSockets: 1 }) : undefined;
    const calls: string[] = [];
    const upstream = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET' || request.method === 'DELETE') {
          response.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        expect(Number(request.headers['content-length'])).toBe(Buffer.concat(chunks).byteLength);
        const message = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: number;
          method: string;
        };
        calls.push(message.method);
        if (message.method !== 'initialize') {
          expect(request.headers['mcp-session-id']).toBe(sse ? 'test-session' : undefined);
          expect(request.headers['mcp-protocol-version']).toBe('2025-06-18');
        }
        if (message.method === 'notifications/initialized') {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'stub', version: '1' },
              }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'tool completed' }] };
        response.writeHead(200, {
          'content-type': sse ? 'text/event-stream' : 'application/json',
          ...(sse ? { 'mcp-session-id': 'test-session' } : {}),
        });
        const envelope = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        // An SSE response may stay open after the matching reply arrives.
        if (sse) response.write(`event: message\r\ndata: ${envelope}\r\n\r\n`);
        else response.end(envelope);
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error('stub failed')),
      );
    });
    upstream.keepAliveTimeout = 60_000;
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === 'string')
      throw new Error('missing address');
    transport.request.mockImplementation(
      (options: RequestOptions, callback: Parameters<typeof httpRequest>[2]) =>
        httpRequest(
          {
            ...options,
            protocol: 'http:',
            hostname: '127.0.0.1',
            port: upstreamAddress.port,
            lookup: undefined,
            // Exercise response draining even with a stricter pool than production.
            ...(agent === undefined ? {} : { agent }),
          },
          callback,
        ),
    );
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });
    registerHttpMcpProxyRoute(app, {
      resolveCaller: async () => ({ sessionId: 'session', turnId: 'turn' }),
      resolveConnection: async () => ({
        id: 'tools',
        url: 'https://mcp.example.test/rpc?pin=private',
      }),
      intercept: createMcpAppsInterceptor({ emit: async () => {} }),
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'regression', version: '1' });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL('/internal/mcp-proxy', address),
      {
        requestInit: { headers: { authorization: 'Bearer turn', 'x-verity-mcp-binding': 'tools' } },
      },
    );
    try {
      await client.connect(clientTransport);
      expect(
        await client.callTool({ name: 'echo', arguments: { message: 'Grüße 👋' } }),
      ).toMatchObject({
        content: [{ text: 'tool completed' }],
      });
      expect(calls).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ]);
      expect(clientTransport.sessionId).toBe(sse ? 'test-session' : undefined);
      await vi.waitFor(() => {
        const entries = logs
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry.rpcMethod === 'tools/call');
        const written = entries.find((entry) => entry.stage === 'request-written');
        expect(written).toMatchObject({
          bodyBytes: expect.any(Number),
          requestWrittenMs: expect.any(Number),
          hasProtocolSession: sse,
          acceptsJson: true,
          acceptsEventStream: true,
          requestContentType: 'application/json',
          protocolVersion: '2025-06-18',
        });
        expect(Number(written?.bodyBytes)).toBeGreaterThan(0);
        const headers = entries.find((entry) => entry.stage === 'headers');
        expect(written?.reqId).toBe(headers?.reqId);
        const firstByte = entries.find((entry) => entry.stage === 'first-byte');
        expect(headers).toMatchObject({
          upstreamStatus: 200,
          contentType: sse ? 'text/event-stream' : 'application/json',
          headersMs: expect.any(Number),
          reqId: expect.any(String),
        });
        expect(firstByte).toMatchObject({
          upstreamStatus: 200,
          firstByteMs: expect.any(Number),
          reqId: headers?.reqId,
        });
        expect(Number(firstByte?.firstByteMs)).toBeGreaterThanOrEqual(Number(headers?.headersMs));
        if (!sse) {
          const ended = entries.find((entry) => entry.stage === 'end');
          expect(ended).toMatchObject({
            upstreamEndMs: expect.any(Number),
            bytes: expect.any(Number),
            reqId: headers?.reqId,
          });
          expect(Number(ended?.upstreamEndMs)).toBeGreaterThanOrEqual(
            Number(firstByte?.firstByteMs),
          );
          expect(entries).toContainEqual(
            expect.objectContaining({ stage: 'complete', reqId: headers?.reqId }),
          );
        }
      });
      expect(logs.join('')).not.toMatch(/pin=|private/u);
    } finally {
      await client.close();
      agent?.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  },
);

it.each([
  { timeout: false, connected: false },
  { timeout: true, connected: false },
  { timeout: true, connected: true },
])(
  'reports pre-response failures without leaking credentials ($timeout timeout, $connected connected)',
  async ({ timeout, connected }) => {
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });
    transport.request.mockImplementation(() => {
      let onTimeout: (() => void) | undefined;
      const outgoing = Object.assign(new EventEmitter(), {
        setTimeout: (_delay: number, callback: () => void) => {
          onTimeout = callback;
        },
        destroy: (error: Error) => {
          outgoing.emit('error', error);
        },
        end: () => {
          queueMicrotask(() => {
            if (connected) {
              const socket = new EventEmitter();
              outgoing.emit('socket', socket);
              socket.emit('secureConnect');
              outgoing.emit('finish');
            }
            if (timeout) onTimeout?.();
            else
              outgoing.emit(
                'error',
                new Error('failed https://example.test?pin=private Bearer secret'),
              );
          });
        },
      });
      return outgoing;
    });
    registerHttpMcpProxyRoute(app, {
      resolveCaller: async () => ({ sessionId: 'session', turnId: 'turn' }),
      resolveConnection: async () => ({
        id: 'tools',
        url: 'https://mcp.example.test?pin=private',
        authorization: 'Bearer secret',
      }),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/mcp-proxy',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
        headers: {
          authorization: 'Bearer turn',
          'x-verity-mcp-binding': 'tools',
          accept: 'application/json; token=secret, text/event-stream',
          'content-type': 'application/json; charset=utf-8; token=secret',
          'mcp-protocol-version': 'secret',
          'mcp-session-id': 'private',
        },
      });
      expect(response.statusCode).toBe(timeout ? 504 : 502);
      expect(response.json()).toEqual({
        error: timeout
          ? `MCP upstream timed out during ${connected ? 'headers' : 'connect'}`
          : 'MCP upstream connection failed',
      });
      expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
        expect.objectContaining({
          level: 40,
          stage: connected ? 'headers' : 'connect',
          ...(connected
            ? {
                connectedMs: expect.any(Number),
                requestWrittenMs: expect.any(Number),
                transportStage: 'request-written',
              }
            : {}),
          reason: timeout ? 'timeout' : 'transport',
          connectionId: 'tools',
          acceptsJson: true,
          acceptsEventStream: true,
          requestContentType: 'application/json',
          protocolVersion: 'other',
          hasProtocolSession: true,
        }),
      );
      expect(logs.join('')).not.toMatch(/private|secret|pin=/u);
    } finally {
      await app.close();
    }
  },
);

it.each(['authorization', 'protocol', 'timeout'] as const)(
  'logs upstream status after receiving a response (%s)',
  async (failure) => {
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });
    transport.request.mockImplementation(
      (_options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        const outgoing = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          end: () => {
            const response = Object.assign(new PassThrough(), {
              statusCode: failure === 'authorization' ? 403 : 200,
              headers: { 'content-type': 'application/json; token=secret' },
              setTimeout: (_delay: number, onTimeout: () => void) => {
                if (failure === 'timeout') setImmediate(onTimeout);
              },
            });
            callback(response as unknown as IncomingMessage);
            if (failure !== 'timeout')
              response.end(failure === 'protocol' ? '{invalid pin=private Bearer secret' : '{}');
          },
        });
        return outgoing;
      },
    );
    registerHttpMcpProxyRoute(app, {
      resolveCaller: async () => ({ sessionId: 'session', turnId: 'turn' }),
      resolveConnection: async () => ({ id: 'tools', url: 'https://mcp.example.test?pin=private' }),
      intercept: createMcpAppsInterceptor({ emit: async () => {} }),
    });
    try {
      const response = await app
        .inject({
          method: 'POST',
          url: '/internal/mcp-proxy',
          payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
          headers: { authorization: 'Bearer turn', 'x-verity-mcp-binding': 'tools' },
        })
        .catch(() => undefined);
      if (failure === 'authorization') expect(response?.statusCode).toBe(403);
      await vi.waitFor(() =>
        expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
          expect.objectContaining({
            level: 40,
            stage: failure === 'authorization' ? 'headers' : 'response',
            reason: failure,
            upstreamStatus: failure === 'authorization' ? 403 : 200,
            contentType: 'application/json',
            headersMs: expect.any(Number),
            elapsedMs: expect.any(Number),
          }),
        ),
      );
      expect(logs.join('')).not.toMatch(/private|secret|pin=/u);
    } finally {
      await app.close();
    }
  },
);
