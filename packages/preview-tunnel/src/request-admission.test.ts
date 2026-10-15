import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  generatePreviewSecret,
  hashPreviewPin,
  hashPreviewSecret,
  PreviewConnector,
  PreviewEdge,
  type PreviewConnectorOptions,
  type PreviewEdgeOptions,
} from './index.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function pair(
  handler: RequestListener,
  edgeOptions: Partial<PreviewEdgeOptions> = {},
  connectorOptions: Partial<PreviewConnectorOptions> = {},
) {
  const target = createServer(handler);
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetPort = (target.address() as { port: number }).port;
  cleanups.push(async () => {
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  const secret = generatePreviewSecret();
  const edge = new PreviewEdge({
    shareId: 'admission-test',
    accessMode: 'local-open',
    pinHash: hashPreviewPin('123456'),
    connectorTokenHash: hashPreviewSecret(secret),
    sessionSecretHash: hashPreviewSecret(generatePreviewSecret()),
    publicOrigin: 'http://127.0.0.1',
    ...edgeOptions,
  });
  const port = await edge.listen();
  let closed = false;
  const closeEdge = async () => {
    if (closed) return;
    closed = true;
    await edge.close();
  };
  cleanups.push(closeEdge);
  const connector = new PreviewConnector({
    accessMode: 'local-open',
    edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
    connectorToken: secret,
    targetOrigin: `http://127.0.0.1:${targetPort}`,
    ...connectorOptions,
  });
  await connector.connect();
  cleanups.push(() => connector.close());
  const replaceConnector = async () => {
    const replacement = new PreviewConnector({
      accessMode: 'local-open',
      edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
      connectorToken: secret,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      ...connectorOptions,
    });
    await replacement.connect();
    cleanups.push(() => replacement.close());
  };
  return { origin: `http://127.0.0.1:${port}`, connector, closeEdge, replaceConnector };
}

it('loads a default-sized asset burst with eight active requests and no 503s', async () => {
  let active = 0;
  let peak = 0;
  let gateOpen = false;
  const held: ServerResponse[] = [];
  const { origin } = await pair((_request, response) => {
    active++;
    peak = Math.max(peak, active);
    response.once('finish', () => active--);
    if (!gateOpen) held.push(response);
    else setTimeout(() => response.end('asset'), 25);
  });
  const burst = Promise.all(
    Array.from({ length: 40 }, async (_, i) => {
      const response = await fetch(`${origin}/asset-${i}.js`);
      return { status: response.status, body: await response.text() };
    }),
  );
  try {
    await vi.waitFor(() => expect(peak).toBe(8));
  } finally {
    gateOpen = true;
    for (const response of held) response.end('asset');
  }
  const assets = await burst;
  expect(assets.map((asset) => asset.status)).toEqual(Array.from({ length: 40 }, () => 200));
  expect(assets.every((asset) => asset.body === 'asset')).toBe(true);
  expect(peak).toBe(8);
});

it.each(['edge', 'connector'] as const)(
  'queues bursts at the %s and refuses only when its waiting reserve is full',
  async (side) => {
    let held: ServerResponse | undefined;
    let count = 0;
    const { origin } = await pair(
      (_request, response) => {
        if (++count === 1) held = response;
        else response.end('ok');
      },
      { maxConcurrentRequests: side === 'edge' ? 1 : 8, maxQueuedRequests: 2 },
      { maxConcurrentRequests: side === 'connector' ? 1 : 8, maxQueuedRequests: 2 },
    );
    const first = fetch(`${origin}/hold`);
    await vi.waitFor(() => expect(held).toBeDefined());
    const burst = Array.from({ length: 3 }, (_, i) => fetch(`${origin}/asset-${i}`));
    // The refusal proves the reserve has filled before the held request is released.
    const refused = await Promise.race(burst);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    held!.end('ok');
    const responses = await Promise.all([first, ...burst]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 503]);
    await Promise.all(responses.map((r) => r.text()));
    expect(count).toBe(3);
    const next = await fetch(`${origin}/next`);
    expect(next.status).toBe(200);
    await next.text();
  },
);

it.each(['edge', 'connector'] as const)('bounds waiting time at the %s', async (side) => {
  let held: ServerResponse | undefined;
  const reached: string[] = [];
  const { origin } = await pair(
    (request, response) => {
      reached.push(request.url!);
      if (request.url === '/hold') held = response;
      else response.end('ok');
    },
    { maxConcurrentRequests: side === 'edge' ? 1 : 8, queueTimeoutMs: 75 },
    { maxConcurrentRequests: side === 'connector' ? 1 : 8, queueTimeoutMs: 75 },
  );
  const first = fetch(`${origin}/hold`);
  await vi.waitFor(() => expect(held).toBeDefined());
  const expired = await fetch(`${origin}/expired`, { method: 'POST', body: 'do not replay' });
  expect(expired.status).toBe(503);
  expect(await expired.text()).toContain('wait expired');
  held!.end('ok');
  await (await first).text();
  await (await fetch(`${origin}/next`)).text();
  expect(reached).toEqual(['/hold', '/next']);
});

it.each(['edge', 'connector'] as const)(
  'removes a queued browser abort at the %s',
  async (side) => {
    let held: ServerResponse | undefined;
    const reached: string[] = [];
    const { origin } = await pair(
      (request, response) => {
        reached.push(request.url!);
        if (request.url === '/hold') held = response;
        else response.end('ok');
      },
      { maxConcurrentRequests: side === 'edge' ? 1 : 8 },
      { maxConcurrentRequests: side === 'connector' ? 1 : 8 },
    );
    const first = fetch(`${origin}/hold`);
    await vi.waitFor(() => expect(held).toBeDefined());
    const controller = new AbortController();
    const cancelled = fetch(`${origin}/cancelled`, { signal: controller.signal }).catch(() => null);
    // Let the HTTP request reach the edge while the first request owns the slot.
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await cancelled;
    // Fetch rejects locally before the close/reset has traversed both hops.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = fetch(`${origin}/next`);
    held!.end('ok');
    await (await first).text();
    const nextResponse = await next;
    expect(nextResponse.status).toBe(200);
    await nextResponse.text();
    expect(reached).toEqual(['/hold', '/next']);
  },
);

async function rawEdge(options: Partial<PreviewConnectorOptions> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const accepted = once(server, 'connection');
  const connector = new PreviewConnector({
    edgeUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    connectorToken: generatePreviewSecret(),
    targetOrigin: 'http://127.0.0.1:1',
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    ...options,
  });
  await connector.connect();
  cleanups.push(() => connector.close());
  const [socket] = (await accepted) as [WebSocket];
  const replies: Array<{ streamId: string; meta?: { status?: number } }> = [];
  socket.on('message', (data: WebSocket.RawData) => {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : data;
    replies.push(JSON.parse(bytes.toString('utf8')) as (typeof replies)[number]);
  });
  const open = (streamId: string) =>
    socket.send(
      JSON.stringify({
        kind: 'stream.open',
        streamId,
        channel: 'http',
        meta: { method: 'POST', path: '/', headers: {} },
      }),
    );
  const data = (streamId: string, bytes: number) =>
    socket.send(
      JSON.stringify({
        kind: 'stream.data',
        streamId,
        seq: 0,
        payload: Buffer.alloc(bytes).toString('base64'),
      }),
    );
  return { socket, replies, open, data };
}

it('bounds queued request bytes and releases their reservation on refusal', async () => {
  const { socket, replies, open, data } = await rawEdge();
  open('active');
  open('too-large');
  data('too-large', 1024 * 1024 + 1);
  await vi.waitFor(() =>
    expect(replies).toContainEqual(
      expect.objectContaining({
        streamId: 'too-large',
        meta: expect.objectContaining({ status: 503 }),
      }),
    ),
  );
  open('replacement');
  data('replacement', 100);
  socket.send(JSON.stringify({ kind: 'stream.reset', streamId: 'active', code: 'client_gone' }));
  socket.send(JSON.stringify({ kind: 'stream.end', streamId: 'replacement' }));
  await vi.waitFor(() =>
    expect(replies).toContainEqual(
      expect.objectContaining({
        streamId: 'replacement',
        meta: expect.objectContaining({ status: 502 }),
      }),
    ),
  );
});

it('bounds aggregate body buffers even for admitted requests', async () => {
  const { replies, open, data } = await rawEdge({ maxConcurrentRequests: 2, maxBodyBytes: 1024 });
  open('one');
  data('one', 800);
  open('two');
  data('two', 800);
  await vi.waitFor(() =>
    expect(replies).toContainEqual(
      expect.objectContaining({
        streamId: 'two',
        meta: expect.objectContaining({ status: 503 }),
      }),
    ),
  );
});

it.each(
  (['edge', 'connector'] as const).flatMap((side) =>
    (['shutdown', 'disconnect', 'replacement', 'expiry'] as const).map((event) => ({
      side,
      event,
    })),
  ),
)(
  'clears queued work at the $side on $event without forwarding it later',
  async ({ side, event }) => {
    const reached: string[] = [];
    const { origin, connector, closeEdge, replaceConnector } = await pair(
      (request, response) => {
        reached.push(request.url!);
        if (request.url !== '/hold') response.end('ok');
      },
      {
        maxConcurrentRequests: side === 'edge' ? 1 : 8,
        ...(event === 'expiry' ? { expiresAt: new Date(Date.now() + 400).toISOString() } : {}),
      },
      { maxConcurrentRequests: side === 'connector' ? 1 : 8 },
    );
    const first = fetch(`${origin}/hold`);
    await vi.waitFor(() => expect(reached).toEqual(['/hold']));
    const queued = fetch(`${origin}/queued`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (event === 'shutdown') await closeEdge();
    if (event === 'disconnect') connector.close();
    if (event === 'replacement') await replaceConnector();
    const responses = await Promise.all([first, queued]);
    for (const response of responses) {
      expect(response.status).toBe(event === 'expiry' ? 410 : 502);
      await response.text();
    }
    expect(reached).toEqual(['/hold']);
    if (event === 'replacement') {
      const next = await fetch(`${origin}/next`);
      expect(next.status).toBe(200);
      await next.text();
    }
  },
);

it('forwards a queued POST body exactly once after admission', async () => {
  let held: ServerResponse | undefined;
  const bodies: string[] = [];
  const { origin } = await pair(
    (request, response) => {
      if (request.url === '/hold') {
        held = response;
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        response.end('saved');
      });
    },
    { maxConcurrentRequests: 8 },
    { maxConcurrentRequests: 1 },
  );
  const first = fetch(`${origin}/hold`);
  await vi.waitFor(() => expect(held).toBeDefined());
  const post = fetch(`${origin}/save`, { method: 'POST', body: 'payload to preserve' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(bodies).toEqual([]);
  held!.end('ok');
  await (await first).text();
  const response = await post;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('saved');
  expect(bodies).toEqual(['payload to preserve']);
});

it('wakes queued requests when a long-lived response leaves the request pool', async () => {
  const { origin } = await pair(
    (request, response) => {
      if (request.url === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ready\n\n');
      } else response.end('asset');
    },
    { maxConcurrentRequests: 1, requestTimeoutMs: 100 },
    { maxConcurrentRequests: 1, requestTimeoutMs: 100 },
  );
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const stream = await fetch(`${origin}/events`, { signal: abort.signal });
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
  const response = await fetch(`${origin}/asset`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('asset');
  abort.abort();
});

it('drops a connector waiter reset before a slot is released', async () => {
  const { socket, replies, open, data } = await rawEdge();
  open('active');
  open('cancelled');
  data('cancelled', 100);
  socket.send(JSON.stringify({ kind: 'stream.end', streamId: 'cancelled' }));
  socket.send(JSON.stringify({ kind: 'stream.reset', streamId: 'cancelled', code: 'client_gone' }));
  open('next');
  socket.send(JSON.stringify({ kind: 'stream.end', streamId: 'next' }));
  socket.send(JSON.stringify({ kind: 'stream.reset', streamId: 'active', code: 'client_gone' }));
  await vi.waitFor(() =>
    expect(replies).toContainEqual(
      expect.objectContaining({
        streamId: 'next',
        meta: expect.objectContaining({ status: 502 }),
      }),
    ),
  );
  expect(replies.some((reply) => reply.streamId === 'cancelled')).toBe(false);
});

it('expires a queued upload without waiting to read its body', async () => {
  let held: ServerResponse | undefined;
  const reached: string[] = [];
  const { origin } = await pair(
    (request, response) => {
      reached.push(request.url!);
      held = response;
    },
    { maxConcurrentRequests: 1, queueTimeoutMs: 75, requestTimeoutMs: 2000 },
  );
  const first = fetch(`${origin}/hold`);
  await vi.waitFor(() => expect(held).toBeDefined());
  const upload = httpRequest(`${origin}/upload`, {
    method: 'POST',
    headers: { 'content-length': '100' },
  });
  cleanups.push(() => {
    upload.destroy();
  });
  const answer = once(upload, 'response');
  upload.write('x');
  const [response] = (await answer) as [IncomingMessage];
  expect(response.statusCode).toBe(503);
  response.resume();
  await once(response, 'end');
  upload.destroy();
  held!.end('ok');
  await (await first).text();
  expect(reached).toEqual(['/hold']);
});

it('shares the queued body byte budget across waiting requests', async () => {
  const { replies, open, data } = await rawEdge({ maxQueuedRequests: 2 });
  open('active');
  open('wait-one');
  data('wait-one', 600 * 1024);
  open('wait-two');
  data('wait-two', 600 * 1024);
  await vi.waitFor(() =>
    expect(replies).toContainEqual(
      expect.objectContaining({
        streamId: 'wait-two',
        meta: expect.objectContaining({ status: 503 }),
      }),
    ),
  );
});

it('allows a full upstream deadline after waiting in the connector queue', async () => {
  let held: ServerResponse | undefined;
  const { origin } = await pair(
    (request, response) => {
      if (request.url === '/hold') held = response;
      else setTimeout(() => response.end('finished upstream'), 700);
    },
    { maxConcurrentRequests: 8, requestTimeoutMs: 1000, queueTimeoutMs: 1200 },
    { maxConcurrentRequests: 1, requestTimeoutMs: 1000, queueTimeoutMs: 1200 },
  );
  const first = fetch(`${origin}/hold`);
  await vi.waitFor(() => expect(held).toBeDefined());
  const queued = fetch(`${origin}/slow`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  held!.end('released');
  await (await first).text();
  const response = await queued;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('finished upstream');
});

it('still bounds upstream time after connector admission', async () => {
  const { origin } = await pair(
    () => {},
    { requestTimeoutMs: 100, queueTimeoutMs: 500 },
    { requestTimeoutMs: 100, queueTimeoutMs: 500 },
  );
  const response = await fetch(`${origin}/silent-target`);
  expect(response.status).toBe(504);
  expect(await response.text()).toContain('timed out');
});

it('does not restart stream classification after slow upstream headers', async () => {
  const { origin } = await pair(
    (request, response) => {
      if (request.url === '/events') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: ready\n\n');
        }, 300);
      } else response.end('asset');
    },
    { maxConcurrentRequests: 1, requestTimeoutMs: 400, queueTimeoutMs: 200 },
    { maxConcurrentRequests: 1, requestTimeoutMs: 400, queueTimeoutMs: 200 },
  );
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const stream = await fetch(`${origin}/events`, { signal: abort.signal });
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.body!.getReader();
  await reader.read();
  const response = await fetch(`${origin}/asset`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('asset');
  abort.abort();
});

it('retains an edge watchdog when a connector does not enforce the upstream deadline', async () => {
  const { origin } = await pair(
    () => {},
    { requestTimeoutMs: 100, queueTimeoutMs: 100 },
    { requestTimeoutMs: 5000 },
  );
  const response = await fetch(`${origin}/silent-target`);
  expect(response.status).toBe(504);
  expect(await response.text()).toContain('timed out');
});
