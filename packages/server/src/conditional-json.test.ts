import compressPlugin from '@fastify/compress';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { conditionalJsonRoute } from './conditional-json.js';

async function appWith(body: () => unknown) {
  const app = Fastify();
  // Registered like createServerApp: compression is opt-in per route.
  await app.register(compressPlugin, { global: false, encodings: ['gzip', 'deflate'] });
  app.get('/overview', conditionalJsonRoute, async () => body());
  app.get('/missing', conditionalJsonRoute, async (_request, reply) => {
    reply.code(404);
    return { error: 'not found' };
  });
  await app.ready();
  return app;
}

describe('conditionalJsonRoute', () => {
  it('answers an unchanged read with a bodyless 304', async () => {
    let sessions = ['a'];
    const app = await appWith(() => ({ sessions }));
    const first = await app.inject({ method: 'GET', url: '/overview' });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/u);
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const unchanged = await app.inject({
      method: 'GET',
      url: '/overview',
      headers: { 'if-none-match': etag },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');

    sessions = ['a', 'b'];
    const changed = await app.inject({
      method: 'GET',
      url: '/overview',
      headers: { 'if-none-match': etag },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ sessions: ['a', 'b'] });
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('compresses large reads and tags the JSON, not the compressed bytes', async () => {
    const sessions = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, status: 'idle' }));
    const app = await appWith(() => ({ sessions }));
    const plain = await app.inject({ method: 'GET', url: '/overview' });
    const zipped = await app.inject({
      method: 'GET',
      url: '/overview',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 4);
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString())).toEqual({ sessions });
    expect(zipped.headers.etag).toBe(plain.headers.etag);
  });

  it('leaves error answers untagged', async () => {
    const app = await appWith(() => ({}));
    const missing = await app.inject({ method: 'GET', url: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
  });

  it('is attached to every overview read the app revalidates', () => {
    // The app sends If-None-Match for these reads (packages/mobile
    // conditionalReads.ts); a route that lost the option would silently answer
    // every revalidation in full again.
    for (const [file, route] of [
      ['session-list-route.ts', "'/sessions'"],
      ['project-collection-routes.ts', "'/projects'"],
      ['project-detail-routes.ts', "'/projects/:id'"],
    ] as const) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const registration = new RegExp(`app\\.get\\(\\s*${route},\\s*conditionalJsonRoute,`, 'u');
      expect(source, file).toMatch(registration);
    }
  });
});
