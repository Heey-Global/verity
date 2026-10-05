import { createServer } from 'node:http';

/** A connector can serve this page without contacting or waking the sandbox. */
export async function startOfflinePreviewServer(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '5',
    });
    response.end(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Currently offline</title><h1>Currently offline</h1><p>This dev server is stopped or starting. Try again later.</p></html>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('offline preview listener is unavailable');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
