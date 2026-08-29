import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startStaticPreviewServer } from './static-server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

/**
 * `fetch` normalizes `%2e%2e` and friends out of a path before the request leaves
 * the process, so the refusals this server exists for would never reach it. Write
 * the request line by hand instead.
 */
function rawRequest(
  origin: string,
  path: string,
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: target.hostname, port: target.port, method, path },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function publishedWorkspace(): Promise<{ workspace: string; origin: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
  await mkdir(join(workspace, 'dist'));
  await writeFile(join(workspace, 'dist', 'index.html'), '<h1>preview</h1>');
  await writeFile(join(workspace, 'secret.txt'), 'not public');
  const server = await startStaticPreviewServer(workspace, 'dist');
  cleanups.push(() => server.close());
  return { workspace, origin: server.origin };
}

describe('static preview server', () => {
  it('serves the selected directory and refuses symlink escapes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    await mkdir(join(workspace, 'dist'));
    await writeFile(join(workspace, 'dist', 'index.html'), '<h1>preview</h1>');
    await writeFile(join(workspace, 'secret.txt'), 'not public');
    await symlink('../secret.txt', join(workspace, 'dist', 'escape.txt'));
    const server = await startStaticPreviewServer(workspace, 'dist');
    cleanups.push(() => server.close());

    await expect(fetch(`${server.origin}/`)).resolves.toMatchObject({ status: 200 });
    const escape = await fetch(`${server.origin}/escape.txt`);
    expect(escape.status).toBe(404);
    const traversal = await fetch(`${server.origin}/%2e%2e/secret.txt`);
    expect(traversal.status).not.toBe(200);
  });

  it('rejects a selected directory that escapes the read-only workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    await expect(startStaticPreviewServer(workspace, '..')).rejects.toThrow(
      /explicit non-hidden publish directory/,
    );
  });

  it('requires a non-root publish directory and never serves hidden files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    await mkdir(join(workspace, 'public'));
    await writeFile(join(workspace, 'public', '.env'), 'secret');
    await expect(startStaticPreviewServer(workspace, '.')).rejects.toThrow(
      /explicit non-hidden publish directory/,
    );
    const server = await startStaticPreviewServer(workspace, 'public');
    cleanups.push(() => server.close());
    await expect(fetch(`${server.origin}/.env`)).resolves.toMatchObject({ status: 404 });
  });

  // The server is read-only by contract. A write verb must be refused before any
  // path resolution happens, and the refusal has to name what the route does take.
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('refuses %s with 405', async (method) => {
    const { origin } = await publishedWorkspace();
    const response = await rawRequest(origin, '/index.html', method);
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
  });

  it('refuses a percent escape it cannot decode with 400 rather than guessing', async () => {
    const { origin } = await publishedWorkspace();
    // `%A` is a truncated escape: decodeURIComponent throws on it.
    expect(await rawRequest(origin, '/%E0%A4%A')).toMatchObject({ status: 400 });
  });

  // `%2e%2e%2f` survives WHATWG path normalization (it is not a double-dot
  // *segment*) and only becomes `../` once the server decodes it. This is the
  // traversal the decode-then-check order exists to catch.
  it('refuses an encoded parent-directory traversal with 403', async () => {
    const { origin } = await publishedWorkspace();
    const response = await rawRequest(origin, '/%2e%2e%2fsecret.txt');
    expect(response.status).toBe(403);
    expect(response.body).not.toContain('not public');
  });

  it('refuses an encoded NUL byte with 403', async () => {
    const { origin } = await publishedWorkspace();
    expect(await rawRequest(origin, '/%00')).toMatchObject({ status: 403 });
  });

  it('never serves a file nested under a hidden directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    await mkdir(join(workspace, 'dist', '.git'), { recursive: true });
    await writeFile(join(workspace, 'dist', '.git', 'config'), 'url = git@github.com:org/repo');
    const server = await startStaticPreviewServer(workspace, 'dist');
    cleanups.push(() => server.close());

    const response = await rawRequest(server.origin, '/.git/config');
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('github.com');
  });

  it('refuses to publish a regular file as the preview root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    await mkdir(join(workspace, 'dist'));
    await writeFile(join(workspace, 'dist', 'index.html'), '<h1>preview</h1>');
    await expect(startStaticPreviewServer(workspace, 'dist/index.html')).rejects.toThrow(
      'static preview root is not a directory',
    );
  });

  // A workspace symlink is exactly how a publish directory would be pointed at
  // someone else's files, so the walk has to refuse it before the server binds.
  it('refuses a symlinked publish directory before binding a port', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
    const outside = await mkdtemp(join(tmpdir(), 'verity-static-outside-'));
    await writeFile(join(outside, 'index.html'), 'not yours');
    await symlink(outside, join(workspace, 'dist'));
    await expect(startStaticPreviewServer(workspace, 'dist')).rejects.toThrow(
      'symlinks are forbidden',
    );
  });

  it.each(['', '   ', '/etc', 'dist/../..', '.hidden/build'])(
    'refuses %j as a publish directory',
    async (selected) => {
      const workspace = await mkdtemp(join(tmpdir(), 'verity-static-preview-'));
      await expect(startStaticPreviewServer(workspace, selected)).rejects.toThrow(
        'static preview requires an explicit non-hidden publish directory',
      );
    },
  );
});
