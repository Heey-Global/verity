import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  discoverMcpOAuth,
  mcpServerIsInternal,
  oauthHttpRequest,
} from './http-mcp-oauth-discovery.js';
const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns', () => ({ lookup: mocks.lookup }));
let options: RequestOptions;
let outgoing: EventEmitter;
let incoming: PassThrough;
let responseStatus = 200;
let responseHeaders: Record<string, string> = {};
beforeEach(() => {
  vi.clearAllMocks();
  responseStatus = 200;
  responseHeaders = {};
  mocks.request.mockImplementation(
    (_url: URL, config: RequestOptions, callback: (response: PassThrough) => void) => {
      options = config;
      outgoing = Object.assign(new EventEmitter(), {
        end: vi.fn(() => {
          incoming = Object.assign(new PassThrough(), {
            statusCode: responseStatus,
            headers: responseHeaders,
          });
          callback(incoming);
        }),
        destroy: vi.fn((error: Error) => outgoing.emit('error', error)),
      });
      return outgoing;
    },
  );
});
it('bounds response bytes and rejects aborted responses instead of hanging', async () => {
  const response = oauthHttpRequest('https://metadata.example/');
  const rejected = expect(response).rejects.toMatchObject({
    code: 'metadata_invalid',
    message: expect.stringMatching(/more than 1 MiB/u),
  });
  incoming.write(Buffer.alloc(1024 * 1024 + 1));
  await rejected;
});
it('does not follow redirects or send credentials during discovery', async () => {
  responseStatus = 302;
  responseHeaders = { location: 'https://127.0.0.1' };
  const response = oauthHttpRequest('https://metadata.example/');
  incoming.end();
  expect((await response).status).toBe(302);
  expect(options.headers).toEqual({ accept: 'application/json, text/event-stream' });
  expect(options.agent).toBe(false);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
type LookupCallback = (error: unknown, addresses: unknown[] | string, family?: number) => void;

/** Runs the request's own lookup hook against a resolver answering `answer`. */
function resolveThroughHook(answer: { error: NodeJS.ErrnoException | null; address?: string }) {
  mocks.lookup.mockImplementation(
    (
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
    ) =>
      callback(
        answer.error,
        answer.address === undefined
          ? []
          : [{ address: answer.address, family: answer.address.includes(':') ? 6 : 4 }],
      ),
  );
  const callback = vi.fn<LookupCallback>();
  const lookup = options.lookup as (
    host: string,
    options: { all: boolean },
    callback: LookupCallback,
  ) => void;
  lookup('metadata.example', { all: true }, callback);
  return callback;
}

// These reach the Verity host itself or its cloud metadata service, whatever
// name resolves to them; allowing tailnet and private ranges must not open them.
it.each([
  ['127.0.0.1', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::1', 'loopback'],
  ['169.254.169.254', 'linkLocal'],
  ['fe80::1', 'linkLocal'],
  ['0.0.0.0', 'unspecified'],
])('refuses actual DNS resolution to %s and names the range', async (address, range) => {
  const response = oauthHttpRequest('https://metadata.example/');
  const callback = resolveThroughHook({ error: null, address });
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'address_refused',
      message: `metadata.example resolves to ${address} (${range}), which MCP connections may not reach.`,
    }),
    [],
  );
  incoming.end('{}');
  await response;
});

// A self-hosted MCP server on the tailnet or a LAN is a deliberate target.
it.each(['100.101.2.3', '100.64.0.1', 'fd7a:115c:a1e0::1', '10.0.0.1', '192.168.1.20'])(
  'connects when DNS resolves to the tailnet or private address %s',
  async (address) => {
    const response = oauthHttpRequest('https://metadata.example/');
    const callback = resolveThroughHook({ error: null, address });
    expect(callback).toHaveBeenCalledWith(null, [
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    incoming.end('{}');
    await response;
  },
);

it('refuses internal peers when only public ones are allowed', async () => {
  const response = oauthHttpRequest(
    'https://metadata.example/',
    undefined,
    undefined,
    undefined,
    false,
    false,
  );
  const callback = resolveThroughHook({ error: null, address: '100.101.2.3' });
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'address_refused',
      detail: expect.objectContaining({ range: 'internal' }),
    }),
    [],
  );
  incoming.end('{}');
  await response;
  await expect(
    oauthHttpRequest('https://10.0.0.5/token', undefined, undefined, undefined, false, false),
  ).rejects.toMatchObject({ code: 'address_refused' });
});

// Reporting an unresolvable tailnet host as public would blame a policy that
// does not apply; the token request fails with the actual cause instead.
it('fails the token-time classification when the MCP host cannot be resolved', async () => {
  mocks.lookup.mockImplementation(
    (_host: string, _options: unknown, callback: (error: Error | null, a: unknown[]) => void) =>
      callback(Object.assign(new Error('not found'), { code: 'EAI_AGAIN' }), []),
  );
  await expect(mcpServerIsInternal('https://docs.example.ts.net/mcp')).rejects.toMatchObject({
    code: 'dns_failed',
    message: 'The Verity server could not resolve the MCP server docs.example.ts.net (EAI_AGAIN).',
  });
});

it('does not report a mixed public and private answer as internal', async () => {
  const response = oauthHttpRequest('https://metadata.example/');
  mocks.lookup.mockImplementation(
    (
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
    ) =>
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
  );
  (options.lookup as (h: string, o: { all: boolean }, c: () => void) => void)(
    'metadata.example',
    { all: true },
    () => undefined,
  );
  incoming.end('{}');
  expect(await response).toMatchObject({ internal: false });
});

it('reports whether the peer was internal', async () => {
  const response = oauthHttpRequest('https://metadata.example/');
  resolveThroughHook({ error: null, address: '100.101.2.3' });
  incoming.end('{}');
  expect(await response).toMatchObject({ internal: true });
  const literal = oauthHttpRequest('https://8.8.8.8/');
  incoming.end('{}');
  expect(await literal).toMatchObject({ internal: false });
});

it.each([
  ['https://100.101.2.3/mcp', null, true],
  ['https://8.8.8.8/mcp', null, false],
  ['https://docs.example.ts.net/mcp', '100.101.2.3', true],
  ['https://mcp.example.com/mcp', '8.8.8.8', false],
  ['https://mixed.example/mcp', ['8.8.8.8', '10.0.0.5'], false],
])(
  'classifies %s (DNS answer %s) as internal: %s for later token requests',
  async (url, answer, expected) => {
    mocks.lookup.mockImplementation(
      (
        _host: string,
        _options: unknown,
        callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
      ) =>
        callback(
          null,
          (Array.isArray(answer) ? answer : [answer ?? '']).map((address) => ({
            address,
            family: 4,
          })),
        ),
    );
    await expect(mcpServerIsInternal(url)).resolves.toBe(expected);
    if (answer === null) expect(mocks.lookup).not.toHaveBeenCalled();
  },
);

it('says the server could not resolve the host', async () => {
  const response = oauthHttpRequest('https://metadata.example/');
  const callback = resolveThroughHook({
    error: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
  });
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'dns_failed',
      message: 'The Verity server could not resolve metadata.example (ENOTFOUND).',
    }),
    [],
  );
  incoming.end('{}');
  await response;
});

it.each([
  [
    'CERT_HAS_EXPIRED',
    'tls_failed',
    'The TLS certificate of metadata.example could not be verified (CERT_HAS_EXPIRED).',
  ],
  [
    'ECONNREFUSED',
    'connect_failed',
    'The Verity server could not connect to metadata.example (ECONNREFUSED).',
  ],
])('reports the transport error %s as %s', async (errno, code, message) => {
  mocks.request.mockImplementation(() => {
    const req = Object.assign(new EventEmitter(), {
      end: () => req.emit('error', Object.assign(new Error('socket error'), { code: errno })),
      destroy: vi.fn(),
    });
    return req;
  });
  await expect(oauthHttpRequest('https://metadata.example/')).rejects.toMatchObject({
    code,
    message,
  });
});

it('bounds the total request lifetime even if the peer keeps sending data', async () => {
  vi.useFakeTimers();
  try {
    const response = oauthHttpRequest('https://metadata.example/');
    const rejected = expect(response).rejects.toMatchObject({
      code: 'timeout',
      message: 'metadata.example did not answer within 15 seconds.',
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

it('discovers OAuth metadata without waiting for an open MCP event stream to end', async () => {
  vi.useFakeTimers();
  const stream = new PassThrough();
  const paths: string[] = [];
  mocks.request.mockImplementation(
    (url: URL, _config: RequestOptions, callback: (response: PassThrough) => void) => {
      paths.push(url.pathname);
      const req = Object.assign(new EventEmitter(), {
        end: () => {
          if (url.pathname === '/mcp') {
            callback(
              Object.assign(stream, {
                statusCode: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            );
            return;
          }
          const body =
            url.pathname === '/.well-known/oauth-protected-resource/mcp'
              ? {
                  resource: 'https://tools.example/mcp',
                  authorization_servers: ['https://identity.example'],
                }
              : {
                  issuer: 'https://identity.example',
                  authorization_endpoint: 'https://identity.example/authorize',
                  token_endpoint: 'https://identity.example/token',
                  code_challenge_methods_supported: ['S256'],
                };
          const response = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
          });
          callback(response);
          response.end(JSON.stringify(body));
        },
        destroy: (error: Error) => req.emit('error', error),
      });
      return req;
    },
  );
  try {
    const observed = discoverMcpOAuth('https://tools.example/mcp').then(
      (value) => ({ kind: 'success', value }),
      (error: unknown) => ({ kind: 'error', error }),
    );
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await observed).toMatchObject({
      kind: 'success',
      value: { discovery: { authorizationEndpoint: 'https://identity.example/authorize' } },
    });
    expect(paths).toContain('/.well-known/oauth-protected-resource/mcp');
    expect(stream.destroyed).toBe(true);
    // Socket closure after headers must not become an unhandled stream error.
    stream.emit('error', new Error('stream closed after probe'));
  } finally {
    stream.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
