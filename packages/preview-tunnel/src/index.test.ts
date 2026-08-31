import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  CONNECTOR_MAX_RECONNECT_ATTEMPTS,
  PreviewConnector,
  PreviewEdge,
  generatePreviewSecret,
  hashPreviewPin,
  hashPreviewSecret,
  reconnectDelayMs,
  supervisePreviewConnector,
} from './index.js';

const cleanups: Array<() => Promise<void> | void> = [];
const sessionSecretHash = hashPreviewSecret('independent-edge-session-secret');
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('connector reconnect policy', () => {
  it('resets failure backoff after a successful connection and retries disconnects', async () => {
    let calls = 0;
    let stop = false;
    const delays: number[] = [];
    const connector = {
      connect: async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
      },
      waitForDisconnect: async () => {
        if (calls === 3) stop = true;
      },
    };
    await supervisePreviewConnector(connector, {
      stopping: () => stop,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([2_000, 1_000]);
    expect(calls).toBe(3);
  });

  it('terminates after the bounded number of consecutive failures', async () => {
    let calls = 0;
    await expect(
      supervisePreviewConnector(
        {
          connect: async () => {
            calls += 1;
            throw new Error('offline');
          },
          waitForDisconnect: async () => undefined,
        },
        { stopping: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow('offline');
    expect(calls).toBe(CONNECTOR_MAX_RECONNECT_ATTEMPTS);
  });
  it('backs off exponentially from one second and caps at fifteen', () => {
    // Attempt 0 is the post-disconnect retry (a successful connect resets the
    // counter), so the first wait is deliberately short.
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    // 16s would exceed the cap; from here the loop settles into steady polling.
    expect(reconnectDelayMs(4)).toBe(15_000);
    expect(reconnectDelayMs(CONNECTOR_MAX_RECONNECT_ATTEMPTS)).toBe(15_000);
  });

  it('reaches the cap before the supervisor gives up', () => {
    // A give-up threshold below the cap would mean the backoff never takes
    // effect — the loop would exit while still retrying every few seconds.
    const capReachedAt = Array.from({ length: 32 }, (_, attempt) => attempt).find(
      (attempt) => reconnectDelayMs(attempt) === 15_000,
    );
    expect(capReachedAt).toBeDefined();
    expect(capReachedAt).toBeLessThan(CONNECTOR_MAX_RECONNECT_ATTEMPTS);
  });
});

describe('preview tunnel', () => {
  it('enforces share expiry inside the edge without depending on Verity cleanup', async () => {
    const edge = new PreviewEdge({
      shareId: 'share-expired',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret('connector'),
      sessionSecretHash,
      publicOrigin: 'https://share-expired.preview.example.test',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const response = await fetch(`http://127.0.0.1:${edgePort}/`);
    expect(response.status).toBe(410);
  });

  it('tears an open stream down when the share expires under it', async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: tick\n\n');
      // Never ends, so only the expiry can close this stream.
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-expiry-mid-stream',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-expiry-mid-stream.preview.example.test',
      expiresAt: new Date(Date.now() + 750).toISOString(),
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborted = new AbortController();
    cleanups.push(() => aborted.abort());
    const stream = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
      signal: aborted.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: tick');

    // A stream that outlived its share must break rather than end cleanly: an
    // orderly end would tell an EventSource the feed was complete, and the head
    // is already on the wire, so a 410 can no longer be sent on this exchange.
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    ).rejects.toThrow();
    const afterwards = await fetch(`http://127.0.0.1:${edgePort}/events`, { headers: { cookie } });
    expect(afterwards.status).toBe(410);
  });

  it('rejects malformed upgrade targets without terminating the edge', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-malformed-upgrade',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-malformed-upgrade.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const response = await rawRequest(
      edgePort,
      'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    expect(response).toContain('400 Bad Request');
    const health = await fetch(`http://127.0.0.1:${edgePort}/`, { redirect: 'manual' });
    expect(health.status).toBe(303);
  });

  it('refuses an application WebSocket upgrade without the PIN session', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-websocket-unauthorized',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-websocket-unauthorized.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    // A handshake cannot be answered with the login redirect an ordinary request
    // gets, so the share's PIN gate has to refuse it outright instead.
    const response = await rawRequest(
      edgePort,
      'GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ' +
        'x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    expect(response).toContain('401 Unauthorized');
  });

  it('requires encrypted transport for remote connector edges', () => {
    expect(
      () =>
        new PreviewConnector({
          edgeUrl: 'ws://preview.example.test/__verity/connector',
          connectorToken: 'secret',
          targetOrigin: 'http://127.0.0.1:3000',
        }),
    ).toThrow('must use wss');
  });

  it('requires the PIN and forwards an authenticated HTTP request to the fixed target', async () => {
    const target = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, {
          location: `http://127.0.0.1:${targetPort}/destination`,
        });
        response.end();
        return;
      }
      if (request.url === '/external-redirect') {
        response.writeHead(302, { location: 'https://external.example.test/path' });
        response.end();
        return;
      }
      if (request.url === '/docs/page') {
        response.writeHead(302, { location: 'next' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'unsafe=value' });
      response.end(
        JSON.stringify({
          path: request.url,
          host: request.headers.host,
          forwarded: request.headers.forwarded,
          forwardedHost: request.headers['x-forwarded-host'],
        }),
      );
    });
    const targetPort = await listen(target);
    cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));

    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-one',
      pinHash: hashPreviewPin('246810'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-one.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const anonymous = await fetch(`http://127.0.0.1:${edgePort}/hello?from=external`, {
      redirect: 'manual',
    });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/__verity/login');

    const login = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '246810', next: '/hello?from=external' }),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('__Host-verity-preview=');

    const forwarded = await fetch(`http://127.0.0.1:${edgePort}/hello?from=external`, {
      headers: {
        cookie: cookie!.split(';')[0]!,
        forwarded: 'for=198.51.100.1;proto=https',
        'x-forwarded-host': 'spoofed.example.test',
      },
    });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual({
      path: '/hello?from=external',
      host: `127.0.0.1:${targetPort}`,
    });
    expect(forwarded.headers.get('set-cookie')).toBeNull();

    const redirected = await fetch(`http://127.0.0.1:${edgePort}/redirect`, {
      redirect: 'manual',
      headers: { cookie: cookie!.split(';')[0]! },
    });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe('/destination');

    const externalRedirect = await fetch(`http://127.0.0.1:${edgePort}/external-redirect`, {
      redirect: 'manual',
      headers: { cookie: cookie!.split(';')[0]! },
    });
    expect(externalRedirect.status).toBe(302);
    expect(externalRedirect.headers.get('location')).toBeNull();

    const relativeRedirect = await fetch(`http://127.0.0.1:${edgePort}/docs/page`, {
      redirect: 'manual',
      headers: { cookie: cookie!.split(';')[0]! },
    });
    expect(relativeRedirect.status).toBe(302);
    expect(relativeRedirect.headers.get('location')).toBe('/docs/next');
  });

  it('rejects an incorrect connector capability', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-two',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-two.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: 'wrong-token',
      targetOrigin: 'http://127.0.0.1:3000',
    });
    await expect(connector.connect()).rejects.toThrow();
  });

  it('reports disconnects so the connector process can reconnect', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-reconnect',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-reconnect.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const first = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: 'http://127.0.0.1:3000',
    });
    await first.connect();
    await expect(first.connect()).rejects.toThrow('already connected');
    const disconnected = first.waitForDisconnect();
    const replacement = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: 'http://127.0.0.1:3000',
    });
    await replacement.connect();
    await expect(disconnected).resolves.toBeUndefined();
    cleanups.push(() => replacement.close());
  });

  it('forwards a request body at the configured decoded size limit', async () => {
    const target = createServer((request, response) => {
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
      });
      request.on('end', () => response.end(String(size)));
    });
    const targetPort = await listen(target);
    cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-body-limit',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-body-limit.preview.example.test',
      maxBodyBytes: 1024,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      maxBodyBytes: 1024,
    });
    await connector.connect();
    cleanups.push(() => connector.close());
    const login = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '123456', next: '/' }),
    });
    const response = await fetch(`http://127.0.0.1:${edgePort}/upload`, {
      method: 'POST',
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! },
      body: Buffer.alloc(1024),
    });
    expect(await response.text()).toBe('1024');

    const oversizedRequest = await fetch(`http://127.0.0.1:${edgePort}/upload`, {
      method: 'POST',
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! },
      body: Buffer.alloc(1025),
    });
    expect(oversizedRequest.status).toBe(413);
  });

  it('streams server-sent events incrementally and outlives the request deadline', async () => {
    let releaseSecondEvent = (): void => {};
    const secondEvent = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });
    const target = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      response.write('data: one\n\n');
      void secondEvent.then(() => {
        response.write('data: two\n\n');
        response.end();
      });
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-sse',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-sse.preview.example.test',
      requestTimeoutMs: 150,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      requestTimeoutMs: 150,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    // Headers and the first event arrive while the response is still open, which
    // is the property a buffered body cannot have.
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('data: one');

    // Well past requestTimeoutMs: the deadline bounds time-to-headers, not the stream.
    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseSecondEvent();
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    expect(rest).toContain('data: two');
  });

  it('does not let an open stream consume the ordinary request budget', async () => {
    const target = createServer((request, response) => {
      if (request.url === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: tick\n\n');
        // Well past the request deadline, so reading it proves the migrated
        // stream is still carrying traffic rather than merely still open.
        const later = setTimeout(() => response.write('data: late\n\n'), 250);
        response.on('close', () => clearTimeout(later));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('pong');
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const options = { maxConcurrentRequests: 1, requestTimeoutMs: 150 };
    const edge = new PreviewEdge({
      shareId: 'share-sse-budget',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-sse-budget.preview.example.test',
      ...options,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      ...options,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborted = new AbortController();
    cleanups.push(() => aborted.abort());
    const stream = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
      signal: aborted.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: tick');

    // Past the request deadline, which is where an exchange that is still open
    // stops being a page load and moves to the stream pool. Every response is a
    // stream now, so nothing at the head could have told the two apart.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ordinary = await fetch(`http://127.0.0.1:${edgePort}/ping`, { headers: { cookie } });
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toBe('pong');

    // The migrated stream is still live — it was reclassified, not dropped.
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: late');
  });

  it('caps open streams separately from ordinary requests', async () => {
    const target = createServer((request, response) => {
      if (request.url === '/plain') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('plain');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: tick\n\n');
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const options = {
      maxConcurrentRequests: 4,
      maxConcurrentStreams: 1,
      requestTimeoutMs: 150,
    };
    const edge = new PreviewEdge({
      shareId: 'share-sse-ceiling',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-sse-ceiling.preview.example.test',
      ...options,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      ...options,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborted = new AbortController();
    cleanups.push(() => aborted.abort());
    const first = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
      signal: aborted.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: tick');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The single stream slot is taken, so the second one is dropped at its own
    // deadline rather than being allowed to migrate. Long-lived exchanges have
    // their own ceiling: leaving the request pool cannot turn
    // `maxConcurrentRequests` into a doubled, unstated bound.
    const second = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
    });
    expect(second.status).toBe(200);
    await expect(second.text()).rejects.toThrow();

    // An ordinary request is unaffected — it never needs a stream slot.
    const plain = await fetch(`http://127.0.0.1:${edgePort}/plain`, { headers: { cookie } });
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('plain');
  });

  it('stops reading the target when the stream reader disconnects', async () => {
    let observeTargetClose = (): void => {};
    const targetClosed = new Promise<void>((resolve) => {
      observeTargetClose = resolve;
    });
    const target = createServer((_request, response) => {
      // The response, not the request: an incoming GET completes as soon as it
      // is read, so watching it could pass without any cancel reaching here.
      response.on('close', () => observeTargetClose());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: tick\n\n');
      // Deliberately never ends: only a propagated cancel can close this.
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-sse-cancel',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-sse-cancel.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborted = new AbortController();
    const response = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
      signal: aborted.signal,
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: tick');
    aborted.abort();
    await targetClosed;
  });

  it('stops the target when the reader disconnects before any headers arrive', async () => {
    let observeTargetRequest = (): void => {};
    const targetRequested = new Promise<void>((resolve) => {
      observeTargetRequest = resolve;
    });
    let observeTargetClose = (): void => {};
    const targetClosed = new Promise<void>((resolve) => {
      observeTargetClose = resolve;
    });
    const target = createServer((_request, response) => {
      // Answers nothing at all, so the exchange is orphaned unless a cancel
      // reaches here — a stream's head never arrives to install the guard.
      response.on('close', () => observeTargetClose());
      observeTargetRequest();
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-cancel-early',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-cancel-early.preview.example.test',
      // Far beyond the test's own deadline, so a pass cannot come from the timer.
      requestTimeoutMs: 60_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      requestTimeoutMs: 60_000,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborted = new AbortController();
    const pending = fetch(`http://127.0.0.1:${edgePort}/slow`, {
      headers: { cookie },
      signal: aborted.signal,
    }).catch(() => undefined);
    await targetRequested;
    aborted.abort();
    await targetClosed;
    await pending;
  });

  it('refuses a stream chunk whose base64 body is not a whole quantum', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-chunk-base64',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-chunk-base64.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = await connectRogueConnector(edgePort, token, (streamId) => [
      responseHead(streamId, { 'content-type': 'text/event-stream' }),
      // Decodes silently to a truncated buffer rather than failing, so the
      // length has to be rejected before anything reaches the reader.
      chunk(streamId, 0, 'A'),
    ]);
    const rogueClosed = new Promise<number>((resolve) => rogue.once('close', resolve));
    cleanups.push(() => rogue.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/stream`, { headers: { cookie } });
    expect(await rogueClosed).toBe(1008);
    await expect(response.text()).rejects.toThrow();
  });

  it('does not rate-limit repeated successful PIN logins', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-login-rate',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-login-rate.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ pin: '123456', next: '/' }),
      });
      expect(response.status).toBe(303);
    }
  });

  it('limits slow login bodies before reading them', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-slow-login',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-slow-login.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const first = await openSlowLogin(edgePort);
    const second = await openSlowLogin(edgePort);
    cleanups.push(() => {
      first.destroy();
    });
    cleanups.push(() => {
      second.destroy();
    });

    const rejected = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '123456', next: '/' }),
    });
    expect(rejected.status).toBe(429);
  });

  it('rejects missing trusted forwarding chains instead of sharing the proxy identity', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-forwarded-identity',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-forwarded-identity.preview.example.test',
      trustedProxyHops: 1,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const missing = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '123456', next: '/' }),
    });
    expect(missing.status).toBe(400);

    const forwarded = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.10',
      },
      body: new URLSearchParams({ pin: '123456', next: '/' }),
    });
    expect(forwarded.status).toBe(303);
  });

  it('does not redirect a successful login outside the preview origin', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-safe-next',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-safe-next.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const response = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pin: '123456', next: '/\\evil.example' }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
  });

  it('fails in-flight requests immediately when the connector disconnects', async () => {
    let releaseTarget!: () => void;
    const targetReached = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    let finishTarget!: () => void;
    const target = createServer((_request, response) => {
      releaseTarget();
      finishTarget = () => response.end('late response');
    });
    const targetPort = await listen(target);
    cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-disconnect',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-disconnect.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      requestTimeoutMs: 5_000,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const forwarded = fetch(`http://127.0.0.1:${edgePort}/slow`, {
      headers: { cookie },
    });
    await targetReached;
    connector.close();
    const response = await forwarded;
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('disconnected');
    finishTarget();
  });

  it('keeps the tunnel usable when a reader dies while backpressure is engaged', async () => {
    let stop = false;
    const target = createServer((_request, response) => {
      if (!response.req.url?.startsWith('/stream')) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('plain');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Enough to outrun a reader that never consumes and engage backpressure,
      // but well under maxBodyBytes so the stream is not legitimately dropped:
      // the test must observe head-of-line blocking, not its own backlog rule.
      let sent = 0;
      const pump = (): void => {
        if (stop || response.writableEnded || sent >= 128) return;
        sent += 1;
        response.write(`data: ${'x'.repeat(64 * 1024)}\n\n`);
        setTimeout(pump, 1);
      };
      pump();
    });
    const targetPort = await listen(target);
    cleanups.push(() => {
      stop = true;
      return new Promise<void>((resolve) => target.close(() => resolve()));
    });
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-backpressure',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-backpressure.preview.example.test',
      requestTimeoutMs: 5_000,
      maxBodyBytes: 64 * 1024 * 1024,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const connector = new PreviewConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
      connectorToken: token,
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      requestTimeoutMs: 5_000,
      maxBodyBytes: 64 * 1024 * 1024,
    });
    await connector.connect();
    cleanups.push(() => connector.close());

    const cookie = await login(edgePort, '123456');
    const aborter = new AbortController();
    const streamed = await fetch(`http://127.0.0.1:${edgePort}/stream`, {
      headers: { cookie },
      signal: aborter.signal,
    });
    expect(streamed.status).toBe(200);
    // Deliberately never read the body, so the edge's write buffer to this
    // reader keeps growing while the connector socket stays shared.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The point of the fix: an unrelated request must still get through while
    // the stalled reader is *still connected*, not merely after it gives up.
    const during = await fetch(`http://127.0.0.1:${edgePort}/plain`, { headers: { cookie } });
    expect(during.status).toBe(200);
    expect(await during.text()).toBe('plain');

    // Without this the test would also pass if the stalled stream had already
    // been dropped, which is the very thing that must not be what unblocked it.
    const reader: ReadableStreamDefaultReader<Uint8Array> = streamed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: x');
    await reader.cancel().catch(() => undefined);

    aborter.abort();

    const after = await fetch(`http://127.0.0.1:${edgePort}/plain`, { headers: { cookie } });
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('plain');
    stop = true;
  });

  it('tunnels a WebSocket in both directions, close status included', async () => {
    const seen: Array<{ path: string; message: string; binary: boolean }> = [];
    const targetPort = await wsTarget((socket, request) => {
      socket.on('message', (data: WebSocket.RawData, binary: boolean) => {
        const message = rawText(data);
        seen.push({ path: request.url ?? '', message, binary });
        socket.send(`echo:${message}`);
        socket.send(Buffer.from([1, 2, 3]), { binary: true });
        socket.close(4001, 'done here');
      });
    });

    const { edgePort, cookie } = await bridge('share-ws-echo', targetPort);
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/hmr?token=abc`, {
      headers: { cookie },
    });
    cleanups.push(() => client.terminate());
    const frames: Array<{ data: Buffer; binary: boolean }> = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    client.on('message', (data: WebSocket.RawData, binary: boolean) =>
      frames.push({ data: data as Buffer, binary }),
    );
    await opened(client);
    client.send('hello');

    const outcome = await closed;
    expect(seen).toEqual([{ path: '/hmr?token=abc', message: 'hello', binary: false }]);
    expect(frames[0]?.data.toString()).toBe('echo:hello');
    expect(frames[0]?.binary).toBe(false);
    // The opcode travels with the frame, so a binary message does not arrive as
    // text on the far side after the base64 round trip.
    expect(frames[1]?.binary).toBe(true);
    expect([...(frames[1]?.data ?? [])]).toEqual([1, 2, 3]);
    // The target's own close status reaches the browser rather than a generic one.
    expect(outcome).toEqual({ code: 4001, reason: 'done here' });
  });

  it('forwards a client close to the target instead of leaking the socket', async () => {
    let observeClose: (outcome: { code: number; reason: string }) => void = () => {};
    const targetClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      observeClose = resolve;
    });
    const targetPort = await wsTarget((socket) => {
      socket.once('close', (code: number, reason: Buffer) =>
        observeClose({ code, reason: reason.toString() }),
      );
    });

    const { edgePort, cookie } = await bridge('share-ws-close', targetPort);
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    await opened(client);
    client.close(4002, 'browser left');
    expect(await targetClosed).toEqual({ code: 4002, reason: 'browser left' });
  });

  it('drops an application socket whose browser has stopped reading', async () => {
    const block = 'x'.repeat(4096);
    let observeClose: () => void = () => {};
    const targetClosed = new Promise<void>((resolve) => {
      observeClose = resolve;
    });
    const targetPort = await wsTarget((socket) => {
      socket.once('close', () => observeClose());
      // Fed until the edge gives up rather than for a fixed count: how much has
      // to pile up before a send queue starts growing is the kernel's business,
      // not this test's.
      pump(() => socket, block);
    });

    const { edgePort, cookie } = await bridge('share-ws-deaf-browser', targetPort, {
      maxBodyBytes: block.length,
    });
    // A browser that completes its handshake and then never reads a byte. The
    // frames arriving for it cannot be slowed down — they come off the connector
    // socket, which carries every other stream too — so this one has to be
    // dropped rather than queued, and dropping it takes the target with it.
    await deafClient(edgePort, cookie);

    await within(targetClosed, 'the edge queued for a browser that never read');
  });

  it('drops an application socket whose target has stopped reading', async () => {
    const block = 'x'.repeat(4096);
    const targetPort = await wsTarget((socket) => socket.pause());

    const { edgePort, cookie } = await bridge('share-ws-deaf-target', targetPort, {
      maxBodyBytes: block.length,
    });
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await opened(client);
    pump(() => client, block);

    await within(closed, 'the connector queued for a target that never read');
  });

  it('stops reading a browser that outruns the tunnel it is writing into', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-ws-backpressure',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-ws-backpressure.preview.example.test',
      maxBodyBytes: 4096,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const cookie = await login(edgePort, '123456');

    // A connector that accepts the socket and then stops reading, standing in
    // for a tunnel that has stopped draining. The edge cannot drop this one
    // stream's frames and cannot pause the connector for it either, so the only
    // answer left is to stop reading the browser.
    const peer = new WebSocket(`ws://127.0.0.1:${edgePort}/__verity/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanups.push(() => peer.terminate());
    await opened(peer);
    peer.once('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawText(data)) as { streamId: string };
      peer.send(
        JSON.stringify({ kind: 'stream.open', streamId: frame.streamId, channel: 'ws', meta: {} }),
      );
      peer.pause();
    });

    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    await opened(client);
    // Flooded until a whole pass comes back refused, not for a fixed count.
    //
    // Two things a fixed flood cannot know. First, what a host absorbs before
    // the bound engages at all is the capacity of the socket buffers between
    // here and the connector — a property of the KERNEL, not of the relay — so
    // on a host with roomier buffers a fixed flood lands in full, reports no
    // backlog, and the CORRECT relay is the one that looks broken. Second, the
    // bound is not a latch: the edge resumes as soon as its queue to the
    // connector drains below a frame, and while the connector's receive buffer
    // is still taking bytes it does drain. Early backlogs are therefore real but
    // momentary, and a test that stops at the first one it sees is reading the
    // oscillation rather than the bound.
    //
    // So each pass asks the same question and the loop leaves only on two yeses
    // running: did the edge refuse essentially all of this one? An edge still
    // reading takes the backlog back down; an edge that has stopped keeps every
    // byte of it. Twice, because one pass held could in principle be a stall
    // rather than a refusal — the edge shares this event loop, so a stall that
    // froze it would freeze the polling too, but two megabytes refused across
    // two independently measured passes is not a hiccup either way.
    const block = 'x'.repeat(4096);
    const pass = 256 * block.length;
    // An upper bound on kernel buffering, not a race window — the CI host grants
    // at most 32 MiB of receive and 4 MiB of send buffer per direction, and
    // there are two hops. Never approached when the relay is correct: measured,
    // this settles after ~5 MiB on macOS and ~7-9 MiB on the CI host — and that
    // second figure is the whole story of the flake, because the flood it
    // replaces was 8 MiB.
    const budget = 256 * 1024 * 1024;
    let sent = 0;
    const flood = (): void => {
      for (let index = 0; index < 256; index += 1) {
        client.send(block);
        sent += block.length;
      }
    };
    let backlog = 0;
    let refusedInARow = 0;
    while (sent < budget && refusedInARow < 2) {
      const before = backlog;
      flood();
      backlog = await drained(client);
      // Nine tenths rather than all of it: a socket the edge has stopped reading
      // still lets a few kilobytes through as the far side works off what it had
      // already taken, and that rounding error is not what this is measuring.
      // The two outcomes being told apart are ~0% refused and ~100% refused.
      refusedInARow = backlog - before >= pass * 0.9 ? refusedInARow + 1 : 0;
    }
    expect(
      refusedInARow,
      `the edge kept taking bytes: ${String(sent)} sent, ${String(backlog)} left queued`,
    ).toBe(2);
  });

  it('refuses a handshake offering duplicate or malformed subprotocols', async () => {
    const targetPort = await wsTarget((socket) => socket.send('ready'));
    const { edgePort, cookie } = await bridge('share-ws-bad-protocols', targetPort);

    // A browser will not send this, and a hand-rolled client that does must not
    // reach the connector's dial: `ws` throws out of its constructor on a
    // duplicate or a non-token, inside a frame handler, where the throw takes
    // the whole tunnel down rather than the one stream.
    const accepted = await rawUpgrade(
      edgePort,
      cookie,
      `${handshakeKey()}Sec-WebSocket-Protocol: dup, dup, not a token\r\n`,
    );
    expect(accepted).toContain('400 Bad Request');

    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const greeting = new Promise<string>((resolve) =>
      client.once('message', (data: WebSocket.RawData) => resolve(rawText(data))),
    );
    expect(await greeting).toBe('ready');
  });

  it('truncates a refusal too large for a frame rather than dropping the tunnel', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await closeServer(dead);
    const { edgePort, cookie } = await bridge('share-tiny-frames', deadPort, { maxBodyBytes: 8 });

    // The connector explains a failed dial in prose, and a limit this small
    // makes that sentence an oversized frame — which the edge is obliged to
    // refuse, costing the connector its connection over an error message.
    const refused = await fetch(`http://127.0.0.1:${edgePort}/`, { headers: { cookie } });
    expect(refused.status).toBe(502);
    expect((await refused.text()).length).toBeLessThanOrEqual(8);

    const second = await fetch(`http://127.0.0.1:${edgePort}/again`, { headers: { cookie } });
    expect(second.status).toBe(502);
  });

  it('refuses an acceptance naming a subprotocol the client never offered', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-ws-unoffered',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-ws-unoffered.preview.example.test',
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());
    const cookie = await login(edgePort, '123456');

    // Hand-rolled rather than a `PreviewConnector`: no correct peer produces
    // this frame, because a real dial can only echo back what it was offered.
    // The edge is the hop that owes the browser a coherent handshake, so it has
    // to hold that line against a peer it does not control.
    const peer = new WebSocket(`ws://127.0.0.1:${edgePort}/__verity/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanups.push(() => peer.terminate());
    await opened(peer);
    peer.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(rawText(data)) as { kind: string; streamId: string };
      if (frame.kind !== 'stream.open') return;
      peer.send(
        JSON.stringify({
          kind: 'stream.open',
          streamId: frame.streamId,
          channel: 'ws',
          meta: { protocol: 'never-offered' },
        }),
      );
    });

    const refused = await rawUpgrade(
      edgePort,
      cookie,
      `${handshakeKey()}Sec-WebSocket-Protocol: vite-hmr\r\n`,
    );
    expect(refused).toContain('502 Bad Gateway');
  });

  it('gives back the stream slot when its own handshake turns out malformed', async () => {
    const targetPort = await wsTarget((socket) => socket.send('ready'));
    const { edgePort, cookie } = await bridge('share-ws-bad-handshake', targetPort, {
      maxConcurrentStreams: 1,
    });

    // Node routes any `Upgrade: websocket` to the upgrade handler without
    // looking at the key, so this reaches the target and is only then refused —
    // locally, without the callback that would have registered a client. The
    // slot has to come back on that path or one ceiling's worth of bad
    // handshakes ends the share's ability to open a socket at all.
    const refused = await rawUpgrade(edgePort, cookie, '');
    expect(refused).toContain('400 Bad Request');

    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const greeting = new Promise<string>((resolve) =>
      client.once('message', (data: WebSocket.RawData) => resolve(rawText(data))),
    );
    expect(await greeting).toBe('ready');
  });

  it('refuses an application upgrade once the share has expired', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-ws-expired-upgrade',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-ws-expired-upgrade.preview.example.test',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    // The edge outlives its share until Verity tears it down, so the expiry has
    // to be refused at the door on this path too — a handshake that slipped
    // through would be a socket with no deadline at all.
    const response = await rawRequest(
      edgePort,
      'GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        `${handshakeKey()}Sec-WebSocket-Version: 13\r\n\r\n`,
    );
    expect(response).toContain('410 Gone');
  });

  it('streams a response larger than the body bound when its length is declared', async () => {
    const body = 'x'.repeat(500);
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      });
      response.end(body);
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const { edgePort, cookie } = await bridge('share-large-asset', targetPort, {
      maxBodyBytes: 64,
    });
    const response = await fetch(`http://127.0.0.1:${edgePort}/asset.bin`, { headers: { cookie } });
    expect(response.status).toBe(200);
    // Refusing on the declared length would reject this while the identical
    // bytes sent chunked went through — the bound is on a frame, not on a
    // response, now that responses are relayed rather than collected.
    expect(await response.text()).toBe(body);
  });

  it('gives up on a dial the target never answers', async () => {
    // Accepts the TCP connection and the upgrade, then says nothing — the case
    // a handshake timeout exists for, since the socket itself looks healthy.
    const target = createServer();
    const held: Duplex[] = [];
    target.on('upgrade', (_request, socket) => held.push(socket));
    const targetPort = await listen(target);
    cleanups.push(async () => {
      for (const socket of held) socket.destroy();
      await closeServer(target);
    });

    const { edgePort, cookie } = await bridge('share-ws-silent', targetPort, {
      requestTimeoutMs: 150,
      connectorRequestTimeoutMs: 5_000,
    });
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const rejection = await new Promise<Error>((resolve) => client.once('error', resolve));
    // The browser is still mid-handshake, so the deadline has to be reported as
    // a status on the raw socket; a close frame would mean nothing to it yet.
    expect(rejection.message).toContain('504');
  });

  it('fails the handshake when the target refuses the upgrade', async () => {
    // No WebSocket endpoint at all: the target answers the dial with a plain
    // 404. Because the edge waits for the acceptance before answering its own
    // client, the refusal is a failed connection rather than one that opened
    // and then closed for no stated reason.
    const target = createServer((_request, response) => {
      response.writeHead(404).end('no socket here');
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    const { edgePort, cookie } = await bridge('share-ws-refused', targetPort);
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const rejection = await new Promise<Error>((resolve) => client.once('error', resolve));
    expect(rejection.message).toContain('502');
  });

  it('closes an application socket when the share expires under it', async () => {
    const targetPort = await wsTarget(() => {
      // Deliberately silent: only the expiry may end this socket.
    });
    const { edgePort, cookie } = await bridge('share-ws-expiry', targetPort, {
      expiresAt: new Date(Date.now() + 300).toISOString(),
    });
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    const closed = new Promise<number>((resolve) => client.once('close', resolve));
    await opened(client);

    // A share that ends must take its open sockets with it: an http request is
    // refused at the door, but a WebSocket opened before expiry would otherwise
    // outlive the share entirely.
    expect(await closed).toBe(1011);
  });

  it('takes its target sockets down when the connector loses the edge', async () => {
    let observeClose = (): void => {};
    const targetClosed = new Promise<void>((resolve) => {
      observeClose = resolve;
    });
    const targetPort = await wsTarget((socket) => socket.once('close', () => observeClose()));

    const { edgePort, cookie, connector } = await bridge('share-ws-orphan', targetPort);
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => client.terminate());
    await opened(client);

    // Without this the target socket outlives the connection that justified it:
    // the browser has no path back to it, nothing will ever read from it, and
    // its stream slot stays taken across the reconnect.
    connector.close();
    await targetClosed;
  });

  it('does not apply the request body bound to a long-lived response', async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let index = 0; index < 8; index += 1) response.write(`data: ${index}\n\n`);
      response.end();
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));

    // Eight events are comfortably past the bound; each frame stays under it.
    const { edgePort, cookie } = await bridge('share-stream-unbounded', targetPort, {
      maxBodyBytes: 32,
    });
    const response = await fetch(`http://127.0.0.1:${edgePort}/events`, { headers: { cookie } });
    expect(response.status).toBe(200);
    // A cumulative bound on the response direction would cut this off partway:
    // a response is relayed frame by frame, so its total says nothing about
    // memory, and an event stream has no total at all.
    expect(await response.text()).toBe(
      Array.from({ length: 8 }, (_, index) => `data: ${index}\n\n`).join(''),
    );
  });

  it('negotiates the subprotocol end to end rather than guessing one', async () => {
    let offered: string | undefined;
    const target = createServer();
    const sockets = new WebSocketServer({
      server: target,
      // The target picks the second offer, so an edge that answered with the
      // browser's first would visibly disagree with it.
      handleProtocols: (protocols) => (protocols.has('other') ? 'other' : false),
    });
    sockets.on('connection', (socket, request) => {
      offered = request.headers['sec-websocket-protocol'];
      socket.send(`target:${socket.protocol}`);
    });
    const targetPort = await listen(target);
    cleanups.push(async () => {
      for (const socket of sockets.clients) socket.terminate();
      await closeServer(target);
    });

    const { edgePort, cookie } = await bridge('share-ws-protocol', targetPort);
    const client = new WebSocket(`ws://127.0.0.1:${edgePort}/hmr`, ['vite-hmr', 'other'], {
      headers: { cookie },
    });
    cleanups.push(() => client.terminate());
    const message = new Promise<string>((resolve) =>
      client.once('message', (data: WebSocket.RawData) => resolve(rawText(data))),
    );
    await opened(client);

    expect(offered).toBe('vite-hmr,other');
    expect(await message).toBe('target:other');
    // Both endpoints ended up on the protocol the target chose, which is only
    // possible because the edge waited for the acceptance before answering.
    expect(client.protocol).toBe('other');
  });

  it('caps application sockets with the stream ceiling', async () => {
    const targetPort = await wsTarget(() => {});
    const { edgePort, cookie } = await bridge('share-ws-ceiling', targetPort, {
      maxConcurrentStreams: 1,
    });
    const first = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => first.terminate());
    await opened(first);

    const second = new WebSocket(`ws://127.0.0.1:${edgePort}/socket`, { headers: { cookie } });
    cleanups.push(() => second.terminate());
    const rejection = await new Promise<Error>((resolve) => second.once('error', resolve));
    expect(rejection.message).toContain('503');
  });

  it('ends a failed stream abnormally so a reader cannot mistake it for complete', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-stream-failure',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-stream-failure.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = new WebSocket(`ws://127.0.0.1:${edgePort}/__verity/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanups.push(() => rogue.close());
    await new Promise<void>((resolve, reject) => {
      rogue.once('open', () => resolve());
      rogue.once('error', reject);
    });
    rogue.on('message', (data: WebSocket.RawData) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      const frame = JSON.parse(text) as { kind: string; streamId: string; channel?: string };
      if (frame.kind !== 'stream.open' || frame.channel !== 'http') return;
      rogue.send(
        JSON.stringify(responseHead(frame.streamId, { 'content-type': 'text/event-stream' })),
      );
      rogue.send(
        JSON.stringify(
          chunk(frame.streamId, 0, Buffer.from('data: partial\n\n').toString('base64')),
        ),
      );
      rogue.send(
        JSON.stringify({
          kind: 'stream.reset',
          streamId: frame.streamId,
          code: 'upstream_error',
        }),
      );
    });

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/events`, {
      headers: { accept: 'text/event-stream', cookie },
    });
    expect(response.status).toBe(200);
    // A `stream.end` would resolve the body; a reset must surface as an error so
    // an EventSource reconnects instead of accepting a truncated stream.
    await expect(response.text()).rejects.toThrow();
  });

  it('refuses a stream that ends before it begins instead of answering an empty 200', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-frame-order',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-frame-order.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = await connectRogueConnector(edgePort, token, (streamId) => [
      { kind: 'stream.end', streamId },
    ]);
    const rogueClosed = new Promise<number>((resolve) => rogue.once('close', resolve));
    cleanups.push(() => rogue.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/stream`, { headers: { cookie } });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('protocol_error');
    // Failing the request alone would leave a peer attached that is known to
    // break frame ordering, still holding whatever it opened upstream.
    expect(await rogueClosed).toBe(1008);
  });

  it('refuses a stream chunk that arrives before the head', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-chunk-order',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-chunk-order.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = await connectRogueConnector(edgePort, token, (streamId) => [
      chunk(streamId, 0, Buffer.from('data: early\n\n').toString('base64')),
    ]);
    // The code and not the reason: 1008 is sent with three texts depending on cause
    // (`invalid frame` from the validator, `invalid frame order` here, `duplicate
    // stream id` for a reused id), and the wire protocol document makes the code the
    // contract and the text diagnostic. A test that pinned the wording would enforce
    // exactly what that document tells a peer not to rely on.
    const rogueClosed = new Promise<number>((resolve) => rogue.once('close', resolve));
    cleanups.push(() => rogue.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/stream`, { headers: { cookie } });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('protocol_error');
    expect(await rogueClosed).toBe(1008);
  });

  // The sibling of the `1008` cases above, and the one the wire protocol document
  // published as unpinned: a body that is not parseable JSON is RFC 6455's 1007
  // *Invalid frame payload data*, while a frame that parses but says something the
  // contract declines is 1008 *Policy Violation*. A peer is written against that
  // split, so assert it here rather than leaving it readable only from the source.
  it('closes a connector whose frame is not parseable JSON', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-invalid-json',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-invalid-json.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    // Opened directly rather than through `connectRogueConnector`: that helper answers
    // request frames, and this case has to send its garbage before any request exists.
    const rogue = new WebSocket(`ws://127.0.0.1:${edgePort}/__verity/connector`, {
      headers: { authorization: `Bearer ${token}` },
    });
    cleanups.push(() => rogue.close());
    let onHandshakeError!: (error: Error) => void;
    await new Promise<void>((resolve, reject) => {
      onHandshakeError = reject;
      rogue.once('open', () => resolve());
      rogue.once('error', onHandshakeError);
    });
    // Detached once the handshake is past: left attached it would swallow a post-open
    // error into a settled promise, and the case would time out instead of reporting it.
    rogue.off('error', onHandshakeError);
    const closed = new Promise<number>((resolve, reject) => {
      rogue.once('close', resolve);
      rogue.once('error', reject);
    });
    rogue.send('not json');
    expect(await closed).toBe(1007);
  });

  it('refuses a second head on a stream that has already begun', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-double-begin',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-double-begin.preview.example.test',
      requestTimeoutMs: 5_000,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = await connectRogueConnector(edgePort, token, (streamId) => [
      responseHead(streamId, { 'content-type': 'text/event-stream' }),
      responseHead(streamId, { 'content-type': 'text/event-stream' }),
    ]);
    cleanups.push(() => rogue.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/stream`, { headers: { cookie } });
    // The head is already on the wire, so the only signal left is an abnormal
    // close — a second status could not be delivered even if one were sent.
    await expect(response.text()).rejects.toThrow();
  });

  it('drops a connector whose stream chunk exceeds the advertised body bound', async () => {
    const token = generatePreviewSecret();
    const edge = new PreviewEdge({
      shareId: 'share-chunk-size',
      pinHash: hashPreviewPin('123456'),
      connectorTokenHash: hashPreviewSecret(token),
      sessionSecretHash,
      publicOrigin: 'https://share-chunk-size.preview.example.test',
      requestTimeoutMs: 5_000,
      maxBodyBytes: 1024,
    });
    const edgePort = await edge.listen();
    cleanups.push(() => edge.close());

    const rogue = await connectRogueConnector(edgePort, token, (streamId) => [
      responseHead(streamId, { 'content-type': 'text/event-stream' }),
      chunk(streamId, 0, Buffer.alloc(4096, 0x61).toString('base64')),
    ]);
    const rogueClosed = new Promise<number>((resolve) => rogue.once('close', resolve));
    cleanups.push(() => rogue.close());

    const cookie = await login(edgePort, '123456');
    const response = await fetch(`http://127.0.0.1:${edgePort}/stream`, { headers: { cookie } });
    // An oversized chunk is a frame the connector should never have sent, so the
    // edge rejects it as invalid rather than decoding it and truncating later.
    expect(await rogueClosed).toBe(1008);
    await expect(response.text()).rejects.toThrow();
  });
});

/** A target http server with a WebSocket endpoint, torn down in a way that does
 * not wait on live sockets — `server.close()` alone hangs while one is open. */
async function wsTarget(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<number> {
  const target = createServer();
  const sockets = new WebSocketServer({ server: target });
  sockets.on('connection', onConnection);
  const port = await listen(target);
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await closeServer(target);
  });
  return port;
}

/** An edge with its connector already attached to `targetPort`, plus a logged-in
 * session cookie — the setup every tunnelling test starts from. */
async function bridge(
  shareId: string,
  targetPort: number,
  options: Partial<{
    expiresAt: string;
    maxConcurrentStreams: number;
    requestTimeoutMs: number;
    maxBodyBytes: number;
    /** Overrides `requestTimeoutMs` on the connector only, so a test can decide
     * which of the two hops reaches its deadline first. */
    connectorRequestTimeoutMs: number;
  }> = {},
): Promise<{ edgePort: number; cookie: string; connector: PreviewConnector }> {
  // The connector has no notion of expiry — that bound is the edge's alone.
  const connectorOptions = {
    ...options,
    expiresAt: undefined,
    ...(options.connectorRequestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.connectorRequestTimeoutMs }),
  };
  const token = generatePreviewSecret();
  const edge = new PreviewEdge({
    shareId,
    pinHash: hashPreviewPin('123456'),
    connectorTokenHash: hashPreviewSecret(token),
    sessionSecretHash,
    publicOrigin: `https://${shareId}.preview.example.test`,
    ...options,
  });
  const edgePort = await edge.listen();
  cleanups.push(() => edge.close());
  const connector = new PreviewConnector({
    edgeUrl: `ws://127.0.0.1:${edgePort}/__verity/connector`,
    connectorToken: token,
    targetOrigin: `http://127.0.0.1:${targetPort}`,
    ...connectorOptions,
  });
  await connector.connect();
  cleanups.push(() => connector.close());
  return { edgePort, cookie: await login(edgePort, '123456'), connector };
}

async function login(edgePort: number, pin: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${edgePort}/__verity/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pin, next: '/' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

/**
 * A raw connector, so the edge is judged on the frames it is handed rather than
 * on what our own well-behaved connector happens to send. `reply` is called once
 * per request frame and returns the frames to answer it with.
 */
async function connectRogueConnector(
  edgePort: number,
  token: string,
  reply: (streamId: string) => unknown[],
): Promise<WebSocket> {
  const rogue = new WebSocket(`ws://127.0.0.1:${edgePort}/__verity/connector`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    rogue.once('open', () => resolve());
    rogue.once('error', reject);
  });
  rogue.on('message', (data: WebSocket.RawData) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');
    const frame = JSON.parse(text) as { kind: string; streamId: string; channel?: string };
    // The edge half-closes its own direction right after the request, so replying
    // to anything but the opening frame would answer every request twice.
    if (frame.kind !== 'stream.open' || frame.channel !== 'http') return;
    for (const outgoing of reply(frame.streamId)) rogue.send(JSON.stringify(outgoing));
  });
  return rogue;
}

/** A response head on an existing stream, which is how the connector answers. */
function responseHead(streamId: string, headers: Record<string, string>): unknown {
  return { kind: 'stream.open', streamId, channel: 'http', meta: { status: 200, headers } };
}

function chunk(streamId: string, seq: number, payload: string): unknown {
  return { kind: 'stream.data', streamId, seq, payload };
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

/**
 * Waits for a socket's outbound backlog to settle and answers with what is left:
 * zero if the peer read all of it, otherwise the bytes still queued.
 *
 * Polled to a standstill rather than sampled after a fixed pause, because the
 * time a drain takes is the host's business and the answer must not be. A peer
 * that is still reading takes the backlog to zero however long it needs, so a
 * slow host only costs this a few more polls. Settling is a wait, not a proof —
 * the caller establishes that a non-zero answer is a refusal by sending more and
 * watching all of it survive.
 */
async function drained(socket: WebSocket): Promise<number> {
  let previous = -1;
  let unchanged = 0;
  while (unchanged < 3) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const backlog = socket.bufferedAmount;
    if (backlog === 0) return 0;
    unchanged = backlog === previous ? unchanged + 1 : 0;
    previous = backlog;
  }
  return previous;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('server has no TCP address'));
      resolve(address.port);
    });
  });
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('connect', () => socket.end(request));
  });
}

/**
 * Performs a WebSocket handshake by hand and resolves the response head, so a
 * test can offer what a browser's own client would refuse to send. The socket is
 * kept open — an accepted upgrade never closes on its own — and torn down with
 * the rest of the fixture.
 */
function rawUpgrade(port: number, cookie: string, extraHeaders: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    cleanups.push(() => void socket.destroy());
    socket.once('error', reject);
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    socket.once('connect', () =>
      socket.write(
        'GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          `Cookie: ${cookie}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
      ),
    );
  });
}

/**
 * A browser that completes the handshake and then never reads a byte. Its
 * receive buffer fills, and everything written to it after that piles up in the
 * edge's own send queue — the queue a relay has to bound.
 */
async function deafClient(port: number, cookie: string): Promise<ReturnType<typeof connect>> {
  const socket = connect(port, '127.0.0.1');
  cleanups.push(() => void socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('data', () => resolve());
    socket.once('connect', () =>
      socket.write(
        'GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          `Cookie: ${cookie}\r\nSec-WebSocket-Version: 13\r\n${handshakeKey()}\r\n`,
      ),
    );
  });
  socket.pause();
  return socket;
}

/** Feeds a socket as fast as the loop allows for as long as it stays open. */
function pump(socket: () => WebSocket, block: string): void {
  const timer = setInterval(() => {
    if (socket().readyState !== WebSocket.OPEN) return;
    for (let index = 0; index < 16; index += 1) socket().send(block);
  }, 1);
  cleanups.push(() => clearInterval(timer));
}

/** Fails with a legible complaint rather than the runner's bare timeout. */
async function within(work: Promise<unknown>, complaint: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(complaint)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Generated rather than pasted: a literal handshake key is high-entropy base64
 * and reads to a secret scanner exactly like a credential would. */
function handshakeKey(): string {
  return `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`;
}

function openSlowLogin(port: number): Promise<ReturnType<typeof connect>> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        'POST /__verity/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\np',
      );
      setTimeout(() => resolve(socket), 10);
    });
  });
}
