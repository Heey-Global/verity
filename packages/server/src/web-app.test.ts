import Fastify from 'fastify';
import compress from '@fastify/compress';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerWebAppRoutes, isWebAppRequest } from './web-app.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verity-web-test-'));
  roots.push(root);
  const build = join(root, 'export');
  await mkdir(build);
  await writeFile(join(build, 'index.html'), '<html>shared Expo app</html>');
  await writeFile(join(build, 'bundle.js'), 'console.log("app")');
  await writeFile(join(build, '.env'), 'private deployment state');
  await writeFile(join(root, 'secret.txt'), 'private');
  await symlink(join(root, 'secret.txt'), join(build, 'leak.txt'));
  await writeFile(
    join(build, 'entry-0123456789abcdef0123456789abcdef.js'),
    'console.log("app");'.repeat(1000),
  );
  const app = Fastify();
  await app.register(compress, {
    global: false,
    globalDecompression: false,
    encodings: ['gzip', 'deflate'],
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!isWebAppRequest(request)) return reply.code(401).send({ error: 'unauthorized' });
  });
  registerWebAppRoutes(app, build);
  app.post('/app/change', async () => 'private');
  app.get('/sessions', async () => 'private');
  return app;
}

describe('web app assets', () => {
  it('serves the export and SPA links before authentication with restrictive headers', async () => {
    const app = await fixture();
    for (const path of ['/app/', '/app/session/sess_1']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('shared Expo app');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
    expect((await app.inject('/app/bundle.js')).headers['content-type']).toContain('javascript');
    expect((await app.inject({ method: 'HEAD', url: '/app/bundle.js' })).body).toBe('');
    expect((await app.inject('/app')).headers.location).toBe('/app/');
    await app.close();
  });

  it('compresses hashed bundles and caches only immutable exports', async () => {
    const app = await fixture();
    const url = '/app/entry-0123456789abcdef0123456789abcdef.js';
    const plain = await app.inject(url);
    const compressed = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.headers.vary).toContain('accept-encoding');
    expect(gunzipSync(compressed.rawPayload).toString()).toBe(plain.body);
    expect(compressed.rawPayload.length).toBeLessThan(plain.rawPayload.length);
    expect(compressed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const path of [
      '/app/',
      '/app/session/example',
      '/app/bundle.js',
      '/app/missing-0123456789abcdef0123456789abcdef',
    ]) {
      expect((await app.inject(path)).headers['cache-control']).toBe('no-cache');
    }
    expect((await app.inject('/app/missing-0123456789abcdef0123456789abcdef.js')).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it('does not expose files outside the export or exempt sibling API methods', async () => {
    const app = await fixture();
    expect([401, 404]).toContain((await app.inject('/app/%2e%2e/secret.txt')).statusCode);
    for (const path of ['/app/leak.txt', '/app/missing.js', '/app/.env']) {
      expect((await app.inject(path)).statusCode).toBe(404);
    }
    expect((await app.inject('/sessions')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/app/change' })).statusCode).toBe(401);
    await app.close();
  });

  it('does not register routes without a configured export', async () => {
    const app = Fastify();
    registerWebAppRoutes(app);
    expect((await app.inject('/app/')).statusCode).toBe(404);
    await app.close();
  });
});
