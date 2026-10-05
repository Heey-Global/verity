import { realpath, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Only the dedicated static handlers may bypass paired-device authentication. */
export function isWebAppRequest(request: FastifyRequest): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    (request.routeOptions.url === '/app' || request.routeOptions.url === '/app/*') &&
    (request.url.split('?', 1)[0] === '/app' || request.url.startsWith('/app/'))
  );
}

export function registerWebAppRoutes(app: FastifyInstance, buildDir?: string): void {
  if (!buildDir) return;
  app.get('/app', async (_request, reply) => reply.redirect('/app/'));
  app.get('/app/*', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    reply.header('Cache-Control', 'no-cache');
    const notFound = () => reply.code(404).send({ error: 'not found' });
    try {
      const root = await realpath(buildDir);
      const suffix = decodeURIComponent(request.url.split('?', 1)[0]!.slice('/app/'.length));
      // Reject before resolving: encoded separators and dot segments must never
      // turn a public asset request into a read outside the export directory.
      if (
        suffix.includes('\\') ||
        suffix.includes('\0') ||
        suffix.split('/').some((segment) => segment.startsWith('.'))
      )
        return notFound();
      let file = resolve(root, suffix || 'index.html');
      if (!file.startsWith(root + sep)) return notFound();
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        // Missing asset URLs must not receive HTML with a successful status.
        if (extname(suffix) !== '') return notFound();
        file = resolve(root, 'index.html');
      }
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + sep)) return notFound();
      reply.type(CONTENT_TYPES[extname(canonical)] ?? 'application/octet-stream');
      return reply.send(await readFile(canonical));
    } catch {
      return notFound();
    }
  });
}
