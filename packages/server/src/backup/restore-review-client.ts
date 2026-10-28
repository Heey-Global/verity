import { request } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';

/** Keep the short-lived recovery session inside this process; output includes only reviewed device IDs. */
export async function reviewRestoreDevices(options: {
  root: string;
  jobId: string;
  masterPassword: string;
  keepIds?: string[];
  signal?: AbortSignal;
}): Promise<unknown> {
  z.string().uuid().parse(options.jobId);
  const socketPath = join(options.root, options.jobId, 'trial/trial.sock');
  const call = (path: string, body?: unknown, token?: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath,
          path,
          method: bytes ? 'POST' : 'GET',
          timeout: 30000,
          headers: {
            ...(bytes
              ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length }
              : {}),
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 8 * 1024 * 1024) req.destroy(new Error('Recovery response exceeds limit'));
            else chunks.push(chunk);
          });
          response.once('error', () => reject(new Error('Recovery review response unavailable')));
          response.once('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('Recovery review request rejected');
              resolve(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
            } catch {
              reject(new Error('Recovery review request rejected'));
            } finally {
              for (const chunk of chunks) chunk.fill(0);
            }
          });
        },
      );
      req.once('error', () => reject(new Error('Recovery review connection unavailable')));
      req.once('timeout', () => req.destroy());
      req.once('close', () => bytes?.fill(0));
      req.end(bytes);
    });
  const authenticated = z
    .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
    .strict()
    .parse(await call('/recovery/authenticate', { password: options.masterPassword }));
  try {
    return options.keepIds === undefined
      ? await call('/recovery/devices', undefined, authenticated.token)
      : await call('/recovery/devices', { keepIds: options.keepIds }, authenticated.token);
  } finally {
    authenticated.token = '';
  }
}
