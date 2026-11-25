import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyTarget,
  ExternalCallObserver,
  withExternalCause,
  type ExternalObservation,
} from './external-calls.js';

let server: Server;
let base: string;
let observed: ExternalObservation[];
let observer: ExternalCallObserver;

beforeEach(async () => {
  server = createServer((request, response) => {
    if (request.url === '/search') {
      response.setHeader('x-ratelimit-resource', 'search');
      response.setHeader('x-ratelimit-remaining', '29');
      response.setHeader('x-ratelimit-limit', '30');
    }
    if (request.url === '/limited') {
      response.setHeader('x-ratelimit-remaining', '4812');
      response.setHeader('x-ratelimit-limit', '5000');
    }
    response.statusCode = request.url === '/missing' ? 404 : 200;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  observed = [];
  observer = new ExternalCallObserver((call) => observed.push(call));
  observer.setActive(true);
});

afterEach(async () => {
  observer.setActive(false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('classifyTarget', () => {
  it('maps known services and never names an unknown public host', () => {
    expect(classifyTarget('api.github.com')).toBe('github');
    expect(classifyTarget('objects.githubusercontent.com')).toBe('github');
    expect(classifyTarget('ghcr.io')).toBe('registry');
    expect(classifyTarget('api.anthropic.com')).toBe('anthropic');
    expect(classifyTarget('chatgpt.com')).toBe('openai');
    expect(classifyTarget('api.doppler.com')).toBe('doppler');
    expect(classifyTarget('oauth2.googleapis.com')).toBe('google');
    expect(classifyTarget('customer-api.example.com')).toBe('other');
    // A look-alike suffix is not the service.
    expect(classifyTarget('evilgithub.com')).toBe('other');
  });

  it('treats loopback, private and single-label hosts as internal', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.4', '192.168.1.2', '::1', 'postgres'])
      expect(classifyTarget(host)).toBe('internal');
    expect(classifyTarget('8.8.8.8')).toBe('other');
  });
});

describe('ExternalCallObserver', () => {
  it('counts fetch calls with their cause, status and rate limit', async () => {
    await withExternalCause('github:session-status', async () => {
      await (await fetch(`${base}/limited`)).text();
    });
    await (await fetch(`${base}/missing`)).text();
    expect(observed).toEqual([
      expect.objectContaining({
        target: 'internal',
        cause: 'github:session-status',
        method: 'GET',
        status: 200,
        rateLimit: { remaining: 4812, limit: 5000 },
      }),
      expect.objectContaining({ cause: 'background', status: 404, rateLimit: null }),
    ]);
  });

  // GitHub's search bucket holds 30 a minute; reported as the GitHub quota it
  // would claim the shared REST budget is nearly spent.
  it('takes the rate limit only from the shared core bucket', async () => {
    await (await fetch(`${base}/search`)).text();
    expect(observed[0]?.rateLimit).toBeNull();
  });

  it('counts node:http requests too', async () => {
    await new Promise<void>((resolve) =>
      get(`${base}/plain`, (response) => {
        response.resume();
        response.on('end', resolve);
      }),
    );
    expect(observed).toEqual([expect.objectContaining({ method: 'GET', status: 200 })]);
  });

  // A caller that reads the same resource again right away wastes quota; that
  // is what the duplicate count is meant to expose.
  it('marks the same read repeated within moments as a duplicate', async () => {
    for (let index = 0; index < 3; index += 1) await (await fetch(`${base}/same`)).text();
    await (await fetch(`${base}/other`)).text();
    await (await fetch(`${base}/same`, { method: 'POST' })).text();
    expect(observed.map((call) => call.duplicate)).toEqual([false, true, true, false, false]);
  });

  it('counts nothing while inactive', async () => {
    observer.setActive(false);
    await (await fetch(`${base}/limited`)).text();
    expect(observed).toEqual([]);
  });
});
