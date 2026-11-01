import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';
import { oauthHttpRequest } from './http-mcp-oauth-discovery.js';
const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns', () => ({ lookup: mocks.lookup }));
let options: RequestOptions;
let outgoing: EventEmitter;
let incoming: PassThrough;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(
    (_url: URL, config: RequestOptions, callback: (response: PassThrough) => void) => {
      options = config;
      outgoing = Object.assign(new EventEmitter(), {
        end: vi.fn(() => {
          incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
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
  const response = oauthHttpRequest('https://metadata.example/');
  Object.assign(incoming, { statusCode: 302, headers: { location: 'https://127.0.0.1' } });
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
