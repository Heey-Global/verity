import { createServer, type Server } from 'node:http';
import { lstat, chmod } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { ProjectEgressHost } from './project-egress-host.js';

/** Bind only below a pre-created, root-owned runtime directory. There is no TCP
 * listener and no endpoint accepting raw commands. The bearer key is projected
 * only to the trusted Server; Unix permissions are an additional boundary.
 */
export async function listenProjectEgressHost(options: {
  directory: string;
  token: string;
  controller: ProjectEgressHost;
}): Promise<Server> {
  if (!/^[a-f0-9]{64}$/u.test(options.token)) throw new Error('Invalid host control key');
  const directory = await lstat(options.directory);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o027) !== 0
  )
    throw new Error('Untrusted host control directory');
  const path = join(options.directory, 'control.sock');
  // Do not unlink an existing socket: a second process must never steal ownership.
  const expected = Buffer.from(`Bearer ${options.token}`);
  let pending = 0;
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 },
    (request, response) => {
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        response.writeHead(401).end();
        request.resume();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/command') {
        response.writeHead(404).end();
        request.resume();
        return;
      }
      if (pending >= 16) {
        response.writeHead(503).end();
        request.resume();
        return;
      }
      pending++;
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += buffer.length;
          if (size > 8192) {
            response.writeHead(413).end();
            request.destroy();
            return;
          }
          chunks.push(buffer);
        }
        const result = await options.controller.execute(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      })()
        .catch(() => {
          // Do not disclose commands, paths or daemon inspection data to the client.
          if (!response.headersSent) response.writeHead(409);
          response.end('{"error":"host operation refused"}');
        })
        .finally(() => {
          pending--;
        });
    },
  );
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o660);
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}
