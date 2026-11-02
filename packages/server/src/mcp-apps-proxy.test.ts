import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { startProjectInternalUnixListener } from './internal-listener.js';
import { registerHttpMcpProxyRoute } from './http-mcp-proxy.js';
import { createMcpAppsInterceptor, type McpAppEvent } from './mcp-apps.js';
import { dashboardFixture } from './mcp-apps-fixture.test-helper.js';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));

it.each([false, true])(
  'captures apps over the actual proxy and bounded RPC transport (SSE: %s)',
  async (sse) => {
    const fixture = dashboardFixture();
    const connection = {
      id: 'c',
      url: 'https://mcp.example.test',
      authorization: 'Bearer fixture',
    };
    transport.request
      .mockReset()
      .mockImplementation(
        (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
          expect(options.headers).toMatchObject({ authorization: 'Bearer fixture' });
          const outgoing = Object.assign(new EventEmitter(), {
            setTimeout: vi.fn(),
            end: (raw: Buffer) => {
              const envelope = JSON.parse(raw.toString()) as {
                id: string;
                method: string;
                params: Record<string, unknown>;
              };
              void fixture.rpc(connection, envelope.method, envelope.params).then(({ result }) => {
                const response = Object.assign(new PassThrough(), {
                  statusCode: 200,
                  headers: {
                    'content-type': sse ? 'text/event-stream' : 'application/json',
                    'mcp-session-id': 'upstream',
                  },
                  setTimeout: vi.fn(),
                });
                callback(response as unknown as IncomingMessage);
                const reply = { jsonrpc: '2.0', id: envelope.id, result };
                response.end(sse ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply));
              });
            },
          });
          return outgoing;
        },
      );
    const events: McpAppEvent[] = [];
    const app = Fastify();
    registerHttpMcpProxyRoute(app, {
      resolveCaller: async () => ({ sessionId: 's', turnId: 't' }),
      resolveConnection: async () => connection,
      intercept: createMcpAppsInterceptor({
        emit: async (_sessionId, event) => {
          events.push(event);
        },
      }),
    });
    await app.ready();
    const directory = await mkdtemp('/tmp/mcp-app-proxy-');
    const listener = await startProjectInternalUnixListener(app, {
      socketRoot: directory,
      identity: { projectId: 'p', containerGeneration: 'g' },
      ownerUid: process.getuid?.() ?? 1000,
      relayGid: process.getgid?.() ?? 1000,
    });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const outgoing = request(
          {
            socketPath: listener.socketPath,
            path: '/internal/mcp-proxy',
            method: 'POST',
            headers: {
              authorization: 'Bearer turn',
              'x-verity-mcp-binding': 'c',
              'content-type': 'application/json',
              'mcp-session-id': 'upstream',
            },
          },
          (incoming) => {
            expect(incoming.statusCode).toBe(200);
            let data = '';
            incoming.on('data', (chunk: Buffer) => {
              data += chunk.toString();
            });
            incoming.on('end', () => resolve(data));
            incoming.on('error', reject);
          },
        );
        outgoing.on('error', reject);
        outgoing.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'dashboard', arguments: {} },
          }),
        );
      });
      expect(body).toContain('Count: 1');
      expect(body).not.toContain('privateToApp');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: 's',
        projectId: 'p',
        result: { structuredContent: { count: 1 }, _meta: { privateToApp: true } },
      });
    } finally {
      await listener.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
