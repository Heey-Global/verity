import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';

import { forwardHttpMcp } from './http-mcp-proxy.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns', () => ({ lookup: mocks.lookup }));

let options: RequestOptions;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation((config: RequestOptions) => {
    options = config;
    return Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
      write: vi.fn(),
    });
  });
});

function forward(url: string) {
  void forwardHttpMcp({ id: 'c', url }, 'POST', Buffer.from('{}'), {}).catch(() => undefined);
}

function resolveTo(address: string) {
  mocks.lookup.mockImplementation(
    (_host: string, _options: unknown, callback: (e: null, a: unknown[]) => void) =>
      callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]),
  );
  const callback = vi.fn();
  (options.lookup as (h: string, o: { all: boolean }, c: typeof callback) => void)(
    'docs.example.ts.net',
    { all: true },
    callback,
  );
  return callback;
}

// A self-hosted MCP server on another port was accepted by setup and then
// called on 443, so every tool call failed while discovery had succeeded.
it.each([
  ['https://docs.example.ts.net:8443/mcp/private', 'docs.example.ts.net', 8443, true],
  ['https://docs.example.ts.net/mcp/private', 'docs.example.ts.net', 443, true],
  ['https://[fd7a:115c:a1e0::1]:9443/mcp', 'fd7a:115c:a1e0::1', 9443, false],
  ['https://100.101.2.3/mcp', '100.101.2.3', 443, false],
])('connects %s at %s:%s', async (url, hostname, port, sni) => {
  forward(url);
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
  expect(options).toMatchObject({ hostname, port, path: new URL(url).pathname });
  expect('servername' in options).toBe(sni);
});

// The proxy is the path that carries the stored bearer or OAuth token, so it
// must refuse what discovery refuses whatever the name resolves to later.
it.each(['127.0.0.1', '169.254.169.254', '100.100.100.200', 'fd00:ec2::254', '::1'])(
  'refuses a resolution to %s',
  async (address) => {
    forward('https://docs.example.ts.net/mcp');
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(resolveTo(address)).toHaveBeenCalledWith(expect.any(Error), []);
  },
);

it.each(['100.101.2.3', 'fd7a:115c:a1e0::1', '192.168.1.20', '8.8.8.8'])(
  'admits a resolution to %s',
  async (address) => {
    forward('https://docs.example.ts.net/mcp');
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(resolveTo(address)).toHaveBeenCalledWith(null, [
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
  },
);
