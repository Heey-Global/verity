import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

/** Read-only static server used only inside the hardened preview connector.
 * Every path is resolved beneath a canonical root and symlinks are rejected,
 * preventing a workspace symlink from exposing files outside the selected dir. */
export async function startStaticPreviewServer(
  workspaceInput: string,
  selectedPath: string,
): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const workspace = await realpath(workspaceInput);
  assertPublicPath(selectedPath);
  const selected = resolve(workspace, selectedPath);
  if (!inside(workspace, selected)) throw new Error('static preview path escapes workspace');
  await rejectSymlinks(workspace, selected);
  const root = await realpath(selected);
  // The selected directory may have been replaced after the component walk.
  // Canonicalize and re-check before retaining it as the server's trust root.
  if (!inside(workspace, root)) throw new Error('static preview root escaped workspace');
  if (!(await stat(root)).isDirectory()) throw new Error('static preview root is not a directory');
  const server = createServer((request, response) => {
    void serve(root, request.method ?? 'GET', request.url ?? '/', response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('static preview server did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function serve(
  root: string,
  method: string,
  requestUrl: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://preview.invalid').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname.includes('\0') || pathname.split('/').includes('..')) {
    response.writeHead(403).end();
    return;
  }
  if (pathname.split('/').some((part) => part.startsWith('.') && part.length > 1)) {
    response.writeHead(404).end();
    return;
  }
  let candidate = resolve(root, `.${pathname}`);
  if (!inside(root, candidate)) {
    response.writeHead(403).end();
    return;
  }
  try {
    await rejectSymlinks(root, candidate);
    let opened = await openPinnedInside(root, candidate);
    if (opened.info.isDirectory()) {
      await opened.handle.close();
      candidate = join(candidate, 'index.html');
      await rejectSymlinks(root, candidate);
      opened = await openPinnedInside(root, candidate);
    }
    if (!opened.info.isFile()) {
      await opened.handle.close();
      throw new Error('not a file');
    }
    response.writeHead(200, {
      'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(opened.info.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD') {
      await opened.handle.close();
      response.end();
    } else {
      // The descriptor pins the inode that was validated through /proc/self/fd;
      // a concurrent rename/symlink replacement cannot redirect this read.
      const stream = opened.handle.createReadStream({ autoClose: true });
      stream.once('error', () => response.destroy());
      stream.pipe(response);
    }
  } catch {
    response.writeHead(404).end();
  }
}

function assertPublicPath(value: string): void {
  const normalized = value.trim().replaceAll('\\', '/');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part.startsWith('.'))
  ) {
    throw new Error('static preview requires an explicit non-hidden publish directory');
  }
}

async function openPinnedInside(root: string, candidate: string) {
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [actual, info] = await Promise.all([
      realpath(`/proc/self/fd/${String(handle.fd)}`),
      handle.stat(),
    ]);
    if (!inside(root, actual)) throw new Error('opened file escaped static root');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function rejectSymlinks(root: string, candidate: string): Promise<void> {
  const rel = relative(root, candidate);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('symlinks are forbidden');
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
