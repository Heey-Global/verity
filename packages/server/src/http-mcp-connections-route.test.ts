import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from '@verity/store';

import { registerHttpMcpConnectionRoutes } from './http-mcp-connections-route.js';
import { McpOAuthDiscoveryError } from './http-mcp-oauth-errors.js';

const discovery = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock('./http-mcp-oauth-discovery.js', async (original) => ({
  ...(await original<typeof import('./http-mcp-oauth-discovery.js')>()),
  discoverMcpOAuth: discovery.discover,
}));

const upsert = vi.fn(async () => undefined);
const app = Fastify();
registerHttpMcpConnectionRoutes(app, {
  listHttpMcpConnections: async () => [],
  upsertHttpMcpConnection: upsert,
} as unknown as EventStore);

afterEach(() => upsert.mockClear());

async function create(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/mcp-connections', payload });
}

// Without its own message the form only says "invalid request", and a user who
// typed a display name such as "Heey Docs Privat" cannot tell what to change.
it('names the connection-name rule a rejected name breaks', async () => {
  const response = await create({
    name: 'Heey Docs Privat',
    url: 'https://mcp.example.test/mcp/privat',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toMatch(/letters, digits, hyphens and underscores/u);
  expect(upsert).not.toHaveBeenCalled();
});

it('explains that the gateway name is reserved', async () => {
  const response = await create({ name: 'Verity', url: 'https://mcp.example.test' });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('The name verity is reserved.');
});

it('reports the cross-field authentication rule instead of a generic error', async () => {
  const response = await create({
    name: 'tools',
    url: 'https://mcp.example.test',
    authType: 'static',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('static authentication requires authorization');
});

it('never echoes unexpected request fields back', async () => {
  const response = await create({ name: 'tools', url: 'https://x.test', secretField: 'leak' });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('invalid request');
});

it('still stores a valid identifier, lower-cased', async () => {
  const response = await create({ name: 'Heey-Docs_Privat', url: 'https://mcp.example.test' });
  expect(response.statusCode).toBe(201);
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ name: 'heey-docs_privat' }));
});

describe('OAuth discovery failures', () => {
  const lines: Record<string, unknown>[] = [];
  const logged = Fastify({
    logger: {
      level: 'warn',
      stream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          done();
        },
      }),
    },
  });
  registerHttpMcpConnectionRoutes(logged, {
    listHttpMcpConnections: async () => [],
    upsertHttpMcpConnection: upsert,
  } as unknown as EventStore);
  afterEach(() => {
    lines.length = 0;
    discovery.discover.mockReset();
  });

  // Before, every failed step answered the same "OAuth not detected" and left
  // nothing in the log, so a refused tailnet address looked like a broken server.
  it.each([
    ['/mcp-connections/oauth/discover', { url: 'https://docs.example.ts.net/mcp/privat' }],
    [
      '/mcp-connections',
      { name: 'docs', url: 'https://docs.example.ts.net/mcp/privat', authType: 'oauth' },
    ],
  ])('%s answers with the failed step and logs it', async (url, payload) => {
    discovery.discover.mockRejectedValue(
      new McpOAuthDiscoveryError(
        'address_refused',
        'docs.example.ts.net resolves to 127.0.0.1 (loopback), which MCP connections may not reach.',
        { host: 'docs.example.ts.net', address: '127.0.0.1', range: 'loopback' },
      ),
    );
    const response = await logged.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'address_refused',
      error:
        'docs.example.ts.net resolves to 127.0.0.1 (loopback), which MCP connections may not reach.',
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'verity: MCP OAuth discovery failed',
        code: 'address_refused',
        host: 'docs.example.ts.net',
        address: '127.0.0.1',
        range: 'loopback',
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps unexpected failures generic in the answer and the log', async () => {
    discovery.discover.mockRejectedValue(new Error('driver detail with token abc123'));
    const response = await logged.inject({
      method: 'POST',
      url: '/mcp-connections/oauth/discover',
      payload: { url: 'https://docs.example.test/mcp' },
    });
    expect(response.json()).toEqual({
      code: 'setup_failed',
      error: 'OAuth discovery failed. Check the server URL or configure OAuth manually.',
    });
    expect(JSON.stringify(lines)).not.toContain('abc123');
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'verity: MCP OAuth setup failed', errorName: 'Error' }),
    );
  });
});
