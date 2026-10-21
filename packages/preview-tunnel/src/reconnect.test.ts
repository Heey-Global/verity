import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewConnector,
  PreviewEdge,
  hashPreviewPin,
  hashPreviewSecret,
  type PreviewEdgeOptions,
  type PreviewRequestLog,
} from './index.js';
import { ReconnectWait, ReconnectTimeout, ReconnectFull } from './reconnect-wait.js';
import { RequestQueue } from './request-queue.js';
import { requestMethod, requestPathClass } from './request-log.js';

const cleanups: Array<() => Promise<void>> = [];
const pinHash = hashPreviewPin('123456');
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

async function harness(options: Partial<PreviewEdgeOptions> = {}) {
  const reached = vi.fn<(method: string | undefined) => void>();
  const target = createServer((request, response) => {
    reached(request.method);
    response.end('content');
  });
  const targetPort = await listen(target);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        target.closeAllConnections();
        target.close(() => resolve());
      }),
  );
  const edgeLogs: PreviewRequestLog[] = [];
  const connectorLogs: PreviewRequestLog[] = [];
  const edge = new PreviewEdge({
    shareId: 'reconnect-share',
    pinHash,
    connectorTokenHash: hashPreviewSecret('connector-token'),
    sessionSecretHash: hashPreviewSecret('session-secret'),
    publicOrigin: 'https://reconnect-share.example.test',
    reconnectWaitMs: 500,
    onRequest: (entry) => edgeLogs.push(entry),
    ...options,
  });
  const port = await edge.listen();
  cleanups.push(() => edge.close());
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/__verity/login`, {
    method: 'POST',
    body: 'pin=123456&next=%2Fcontent',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(login.status).toBe(303);
  expect(login.headers.get('location')).toBe('/content');
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  await login.text();
  const createConnector = () => {
    const connector = new PreviewConnector({
      shareId: 'reconnect-share',
      edgeUrl: `ws://127.0.0.1:${port}/__verity/connector`,
      connectorToken: 'connector-token',
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      onRequest: (entry) => connectorLogs.push(entry),
    });
    cleanups.push(async () => {
      connector.close();
      await connector.waitForDisconnect();
    });
    return connector;
  };
  const reconnect = (edge as unknown as { reconnect: ReconnectWait<unknown> }).reconnect;
  const waiting = vi.spyOn(reconnect, 'wait');
  return { edge, base, cookie, createConnector, edgeLogs, connectorLogs, reached, waiting, target };
}

describe('public share reconnect admission', () => {
  it.each(['GET', 'HEAD'])(
    'resumes the first post-PIN %s when a tunnel reconnects',
    async (method) => {
      const h = await harness();
      const pending = fetch(`${h.base}/content`, { method, headers: { cookie: h.cookie } });
      await vi.waitFor(() => expect(h.waiting).toHaveBeenCalledOnce());
      expect(h.reached).not.toHaveBeenCalled();
      await h.createConnector().connect();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'content');
      await vi.waitFor(() => expect(h.edgeLogs).toHaveLength(1));
      expect(h.reached.mock.calls).toEqual([[method]]);
      expect(h.edgeLogs[0]).toMatchObject({
        status: 200,
        outcome: 'completed',
        connectionGeneration: 1,
        tunnelUnavailable: false,
      });
      expect(h.connectorLogs).toHaveLength(1);
    },
  );

  it.each(['GET', 'HEAD'])(
    'bounds the wait and serves a no-store reconnect response for %s',
    async (method) => {
      const h = await harness({ reconnectWaitMs: 30 });
      const response = await fetch(`${h.base}/content`, { method, headers: { cookie: h.cookie } });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('retry-after')).toBe('2');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      const page = await response.text();
      if (method === 'GET') {
        expect(page).toContain('Reconnecting…');
        expect(page).toContain('<meta http-equiv="refresh" content="2">');
        expect(page).not.toContain('<script');
      } else expect(page).toBe('');
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.edgeLogs[0]).toMatchObject({
        status: 503,
        tunnelUnavailable: true,
        connectionGeneration: 0,
      });
      await h.createConnector().connect();
      const reloaded = await fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
      expect(await reloaded.text()).toBe('content');
    },
  );

  it('does not reload URLs carrying query credentials or log secrets in paths, headers or bodies', async () => {
    const h = await harness({ reconnectWaitMs: 25 });
    const response = await fetch(`${h.base}/private-token?pin=123456&access_token=secret-query`, {
      headers: { cookie: h.cookie, authorization: 'Bearer secret-header' },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('http-equiv="refresh"');
    const connector = h.createConnector();
    await connector.connect();
    const post = await fetch(`${h.base}/private-token?token=secret-query`, {
      method: 'POST',
      headers: { cookie: h.cookie, authorization: 'Bearer secret-header' },
      body: 'secret-body',
    });
    expect(await post.text()).toBe('content');
    await vi.waitFor(() => expect(h.connectorLogs).toHaveLength(1));
    expect(h.connectorLogs[0]).toMatchObject({
      shareId: 'reconnect-share',
      method: 'POST',
      pathClass: 'content',
      status: 200,
      outcome: 'completed',
      connectionGeneration: 1,
    });
    const logs = JSON.stringify([...h.edgeLogs, ...h.connectorLogs]);
    for (const secret of [
      'private-token',
      'secret-query',
      'secret-header',
      'secret-body',
      '123456',
      h.cookie,
    ])
      expect(logs).not.toContain(secret);
    expect(h.edgeLogs).toHaveLength(2);
  });

  it('does not queue or replay login POSTs, application POSTs, or webhook POSTs', async () => {
    const h = await harness();
    // The harness already authenticated while disconnected. The form POST stayed edge-local.
    expect(h.waiting).not.toHaveBeenCalled();
    expect(h.edgeLogs).toHaveLength(0);
    const response = await fetch(`${h.base}/content`, {
      method: 'POST',
      headers: { cookie: h.cookie },
      body: 'one-shot',
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('http-equiv="refresh"');
    expect(h.waiting).not.toHaveBeenCalled();
    await h.createConnector().connect();
    const next = await fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    await next.text();
    expect(h.reached.mock.calls).toEqual([['GET']]);

    const webhook = new PreviewEdge({
      shareId: 'webhook',
      pinHash,
      connectorTokenHash: hashPreviewSecret('token'),
      sessionSecretHash: hashPreviewSecret('session'),
      publicOrigin: 'https://webhook.example.test',
      webhookPath: '/events',
    });
    const port = await webhook.listen();
    cleanups.push(() => webhook.close());
    const result = await fetch(`http://127.0.0.1:${port}/events?pin=123456`, {
      method: 'POST',
      body: 'one-shot',
    });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('http-equiv="refresh"');
  });

  it('bounds waiting visitors and releases capacity when a reader leaves', async () => {
    const h = await harness({ maxQueuedRequests: 1, reconnectWaitMs: 2_000 });
    const abort = new AbortController();
    const pending = fetch(`${h.base}/content`, {
      headers: { cookie: h.cookie },
      signal: abort.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(h.waiting).toHaveBeenCalledOnce());
    const overflow = await fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    expect(overflow.status).toBe(503);
    await overflow.text();
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(h.edgeLogs).toHaveLength(2));
    expect(h.edgeLogs.find((entry) => entry.outcome === 'aborted')).toBeDefined();
    const replacement = fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    await vi.waitFor(() => expect(h.waiting).toHaveBeenCalledTimes(3));
    await h.createConnector().connect();
    expect(await (await replacement).text()).toBe('content');
    expect(h.reached).toHaveBeenCalledOnce();
  });

  it('follows a replacement generation before dispatch without forwarding twice', async () => {
    const h = await harness();
    const first = h.createConnector();
    await first.connect();
    const next = h.createConnector();
    const requests = (h.edge as unknown as { requests: RequestQueue }).requests;
    const acquire = requests.acquire.bind(requests);
    vi.spyOn(requests, 'acquire').mockImplementationOnce(async (signal) => {
      await next.connect();
      await first.waitForDisconnect();
      return acquire(signal);
    });
    const response = await fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    expect(await response.text()).toBe('content');
    expect(h.reached).toHaveBeenCalledOnce();
    expect(h.edgeLogs[0]?.connectionGeneration).toBe(2);
    expect(h.connectorLogs[0]?.connectionGeneration).toBe(1);
  });

  it('waits through a real disconnect while admission is pending', async () => {
    const h = await harness();
    const first = h.createConnector();
    await first.connect();
    const requests = (h.edge as unknown as { requests: RequestQueue }).requests;
    const acquire = requests.acquire.bind(requests);
    vi.spyOn(requests, 'acquire').mockImplementationOnce(async (signal) => {
      first.close();
      await first.waitForDisconnect();
      return acquire(signal);
    });
    const pending = fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    await vi.waitFor(() => expect(h.waiting).toHaveBeenCalledOnce());
    await h.createConnector().connect();
    expect(await (await pending).text()).toBe('content');
    expect(h.reached).toHaveBeenCalledOnce();
    expect(h.edgeLogs[0]?.connectionGeneration).toBe(2);
  });

  it('does not replay an already dispatched GET after a tunnel drop and logs its abort once', async () => {
    const h = await harness();
    h.target.removeAllListeners('request');
    h.target.on('request', (request) => h.reached(request.method));
    const first = h.createConnector();
    await first.connect();
    const pending = fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    await vi.waitFor(() => expect(h.reached).toHaveBeenCalledOnce());
    first.close();
    await first.waitForDisconnect();
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('http-equiv="refresh"');
    await h.createConnector().connect();
    expect(h.reached).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.connectorLogs).toHaveLength(1));
    expect(h.connectorLogs[0]).toMatchObject({
      status: null,
      outcome: 'aborted',
      tunnelUnavailable: true,
    });
    expect(h.edgeLogs).toHaveLength(1);
    expect(h.edgeLogs[0]).toMatchObject({ status: 502, tunnelUnavailable: true });
  });

  it.each(['expiry', 'shutdown'])('cleans up a waiting visitor on %s', async (reason) => {
    const h = await harness({ reconnectWaitMs: 10_000 });
    const pending = fetch(`${h.base}/content`, { headers: { cookie: h.cookie } });
    await vi.waitFor(() => expect(h.waiting).toHaveBeenCalledOnce());
    if (reason === 'expiry') {
      const state = h.edge as unknown as { expiresAtMs: number; scheduleExpiry(): void };
      state.expiresAtMs = Date.now() - 1;
      state.scheduleExpiry();
    } else {
      const close = h.edge.close();
      // close() also waits for this HTTP response to finish.
      cleanups.splice(cleanups.length - 1, 1);
      await close;
    }
    const response = await pending;
    expect(response.status).toBe(reason === 'expiry' ? 410 : 502);
    await response.text();
    expect(h.reached).not.toHaveBeenCalled();
    expect(h.edgeLogs).toHaveLength(1);
  });
});

it('preserves the immediate non-reloading response for local previews without a tunnel', async () => {
  const edge = new PreviewEdge({
    shareId: 'local',
    accessMode: 'local-open',
    pinHash,
    connectorTokenHash: hashPreviewSecret('token'),
    sessionSecretHash: hashPreviewSecret('secret'),
    publicOrigin: 'http://127.0.0.1',
  });
  const port = await edge.listen();
  cleanups.push(() => edge.close());
  const wait = vi.spyOn(
    (edge as unknown as { reconnect: ReconnectWait<unknown> }).reconnect,
    'wait',
  );
  const response = await fetch(`http://127.0.0.1:${port}/content`);
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain('temporarily unavailable');
  expect(page).not.toContain('http-equiv="refresh"');
  expect(wait).not.toHaveBeenCalled();
});

it('uses fixed path classes and bounded HTTP methods', () => {
  expect(requestPathClass('/')).toBe('root');
  expect(requestPathClass('/__verity/login?pin=123456')).toBe('internal');
  expect(requestPathClass('/private/token?secret=query')).toBe('content');
  expect(requestMethod('GET')).toBe('GET');
  expect(requestMethod('PRIVATE-TOKEN')).toBe('OTHER');
});

it('enforces a shared reconnect deadline even if a late notify runs before its timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const state: { current?: string } = {};
  const wait = new ReconnectWait(() => state.current, 1);
  const pending = wait.wait(30, new AbortController().signal);
  const rejected = expect(pending).rejects.toBeInstanceOf(ReconnectTimeout);
  now.mockReturnValue(31);
  state.current = 'late';
  wait.notify();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  now.mockRestore();
});

it('cleans up waiter timers on abort and rejects overflow without adding a timer', async () => {
  vi.useFakeTimers();
  const wait = new ReconnectWait<string>(() => undefined, 1);
  const abort = new AbortController();
  const pending = wait.wait(performance.now() + 500, abort.signal);
  const rejected = expect(pending).rejects.toThrow('reader gone');
  await expect(
    wait.wait(performance.now() + 500, new AbortController().signal),
  ).rejects.toBeInstanceOf(ReconnectFull);
  abort.abort(new Error('reader gone'));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
