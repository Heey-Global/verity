import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';
import { discoverMcpOAuth, oauthHttpRequest } from './http-mcp-oauth-discovery.js';
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
  const rejected = expect(response).rejects.toThrow(/too large/u);
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
it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '::ffff:127.0.0.1', '::1'])(
  'rejects actual DNS resolution to %s',
  async (address) => {
    const response = oauthHttpRequest('https://metadata.example/');
    mocks.lookup.mockImplementation(
      (
        _host: string,
        _options: unknown,
        callback: (error: Error | null, addresses: { address: string; family: number }[]) => void,
      ) => callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]),
    );
    const callback = vi.fn();
    const lookup = options.lookup as (
      host: string,
      options: { all: boolean },
      callback: (error: Error | null, addresses: unknown[]) => void,
    ) => void;
    lookup('metadata.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'MCP OAuth endpoint resolution rejected' }),
      [],
    );
    incoming.end('{}');
    await response;
  },
);
it('bounds the total request lifetime even if the peer keeps sending data', async () => {
  vi.useFakeTimers();
  try {
    const response = oauthHttpRequest('https://metadata.example/');
    const rejected = expect(response).rejects.toThrow(/timed out/u);
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
