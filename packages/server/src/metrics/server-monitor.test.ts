import compressPlugin from '@fastify/compress';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { pairedRoutePolicy } from '../paired-route-policy.js';
import { hashIdentifier } from './diagnostic-report.js';
import type { MonitoringSettingsStore } from './monitoring-control.js';
import {
  createServerMonitor,
  installServerMonitoring,
  type ServerMonitor,
} from './server-monitor.js';

const BODY = 'x'.repeat(20_000);
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(options: { store?: MonitoringSettingsStore; now?: () => Date } = {}) {
  const instance = Fastify();
  const monitor = createServerMonitor({
    store: options.store,
    version: '9.9.9',
    ...(options.now ? { now: options.now } : {}),
  });
  installServerMonitoring(instance, monitor);
  await instance.register(compressPlugin, { global: false, encodings: ['gzip'] });
  instance.get('/sessions/:id/events', async (request, reply) =>
    (request.params as { id: string }).id.startsWith('unknown')
      ? reply.code(404).send({ error: 'not found' })
      : BODY,
  );
  instance.get('/sessions/:id/history/v1', { compress: {} }, async (_request, reply) =>
    reply.type('text/plain').compress(BODY),
  );
  await instance.ready();
  app = instance;
  return { app: instance, monitor };
}

function report(monitor: ServerMonitor) {
  return monitor.report('hashed');
}

describe('server monitoring', () => {
  it('counts response bytes per route and client and returns the request ID', async () => {
    const { app, monitor } = await serve();
    const response = await app.inject({
      url: '/sessions/s-1/events',
      headers: { 'x-verity-client': 'ios/1.95.4' },
    });
    expect(response.headers['x-request-id']).toBe(String(response.headers['x-request-id']));
    const { traffic, availability } = report(monitor);
    expect(availability.requests).toBe(1);
    expect(traffic.topRoutes[0]).toMatchObject({
      method: 'GET',
      route: '/sessions/:id/events',
      client: 'ios/1.95.4',
      requests: 1,
      bytesOut: BODY.length,
    });
    expect(traffic.byClient).toEqual([
      { client: 'ios/1.95.4', requests: 1, bytesOut: BODY.length, bytesIn: 0 },
    ]);
  });

  // `inject` replaces Node's response object; the counting must hold on a real
  // socket too, where `end` and `write` are Node's own.
  it('counts the same bytes over a real connection', async () => {
    const { app, monitor } = await serve();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const plain = await fetch(`${address}/sessions/s-1/events`);
    expect((await plain.text()).length).toBe(BODY.length);
    const compressed = await fetch(`${address}/sessions/s-1/history/v1`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    await compressed.arrayBuffer();
    const routes = report(monitor).traffic.topRoutes;
    expect(routes.find((route) => route.route === '/sessions/:id/events')?.bytesOut).toBe(
      BODY.length,
    );
    const gzip = routes.find((route) => route.route === '/sessions/:id/history/v1')?.bytesOut;
    expect(gzip).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(BODY.length / 10);
  });

  // The question the counters exist for is "what crossed the network", so a
  // compressed response must count its compressed size, not the body before it.
  it('counts compressed responses as sent', async () => {
    const { app, monitor } = await serve();
    const response = await app.inject({
      url: '/sessions/s-1/history/v1',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    const sent = report(monitor).traffic.topRoutes[0]!.bytesOut;
    expect(sent).toBe(response.rawPayload.byteLength);
    expect(sent).toBeLessThan(BODY.length / 10);
  });

  // A report leaves the server through the share sheet. Session IDs, query
  // strings and paths with parameters filled in must not be in it.
  it('reports route templates and hashed sessions, never IDs or query strings', async () => {
    const { app, monitor } = await serve();
    await app.inject({ url: '/sessions/private-session-42/events?token=leaked-value' });
    await app.inject({ url: '/no/such/route-with-secret' });
    const text = JSON.stringify(report(monitor));
    expect(text).not.toContain('private-session-42');
    expect(text).not.toContain('leaked-value');
    expect(text).not.toContain('route-with-secret');
    expect(text).toContain(hashIdentifier('private-session-42'));
    expect(text).toContain('(unmatched)');
    expect(JSON.stringify(monitor.report('raw'))).toContain('private-session-42');
  });

  it('stops counting and forgets what it counted when measurement is switched off', async () => {
    const { app, monitor } = await serve();
    await app.inject({ url: '/sessions/s-1/events' });
    const off = await app.inject({
      method: 'PATCH',
      url: '/diagnostics/monitoring',
      payload: { measurementEnabled: false },
    });
    expect(off.json()).toMatchObject({ measurementEnabled: false });
    await app.inject({ url: '/sessions/s-1/events' });
    // Switching off discards what was counted, the PATCH included; afterwards nothing is added.
    expect(report(monitor).availability.requests).toBe(0);
    await app.inject({
      method: 'PATCH',
      url: '/diagnostics/monitoring',
      payload: { measurementEnabled: true },
    });
    await app.inject({ url: '/sessions/s-1/events' });
    expect(
      report(monitor).traffic.topRoutes.find((route) => route.route === '/sessions/:id/events')
        ?.requests,
    ).toBe(1);
  });

  it('runs detail mode for the chosen time only, then ends it on its own', async () => {
    let clock = Date.parse('2026-11-25T14:00:00Z');
    const { app, monitor } = await serve({ now: () => new Date(clock) });
    const started = await app.inject({
      method: 'PATCH',
      url: '/diagnostics/monitoring',
      payload: { detailMode: { minutes: 15 } },
    });
    expect(started.json()).toMatchObject({
      detailMode: { active: true, startedBy: 'app', remainingSeconds: 900 },
    });
    await app.inject({ url: '/sessions/s-1/events' });
    // The PATCH that started it already counts; so does the read after it.
    expect(report(monitor).detail?.slowRequests.map((entry) => entry.route)).toContain(
      '/sessions/:id/events',
    );
    clock += 15 * 60_000 + 1;
    expect(report(monitor).monitoring.detailMode.active).toBe(false);
    // Ended, but what it recorded is still in the next report.
    expect(report(monitor).detail).toMatchObject({ active: false });
    expect(report(monitor).detail?.slowRequests.length).toBeGreaterThan(0);
    const kept = report(monitor).detail?.slowRequests.length;
    await app.inject({ url: '/sessions/s-2/events' });
    // After it ended nothing new is recorded.
    expect(report(monitor).detail?.slowRequests).toHaveLength(kept!);
  });

  // Old slow requests in a new period would point the reader at a problem that
  // happened before it; a failed start must not throw the old evidence away.
  it('starts each detail period empty, whoever starts it, once the start is stored', async () => {
    let failWrites = false;
    let stored = { measurementEnabled: true, detailUntil: null, detailStartedBy: null } as never;
    const store: MonitoringSettingsStore = {
      get: async () => stored,
      setMeasurementEnabled: async () => stored,
      setDetailMode: async (until, startedBy) => {
        if (failWrites) throw new Error('database unavailable');
        return (stored = {
          measurementEnabled: true,
          detailUntil: until,
          detailStartedBy: startedBy,
        } as never);
      },
    };
    const { app, monitor } = await serve({ store });
    await monitor.control.startDetailMode(15, 'control');
    await app.inject({ url: '/sessions/s-1/events' });
    const before = monitor.metrics.slowRequests.length;
    expect(before).toBeGreaterThan(0);
    failWrites = true;
    await expect(monitor.control.startDetailMode(60, 'control')).rejects.toThrow();
    expect(monitor.metrics.slowRequests).toHaveLength(before);
    failWrites = false;
    await monitor.control.startDetailMode(60, 'control');
    expect(monitor.metrics.slowRequests).toHaveLength(0);
  });

  // A caller can put any text in the path; only sessions the server actually
  // served belong in the list Control reads with raw IDs.
  it('lists only sessions whose requests succeeded', async () => {
    const { app, monitor } = await serve();
    await app.inject({ url: '/sessions/s-1/events' });
    for (let index = 0; index < 5; index += 1)
      await app.inject({ url: `/sessions/unknown-${index}/events` });
    expect(monitor.report('raw').traffic.topSessions.map((entry) => entry.session)).toEqual([
      's-1',
    ]);
  });

  // Otherwise one caller cycling through invented versions with rejected
  // requests fills the series cap and real traffic lands in the overflow.
  it('labels rejected requests by client kind only', async () => {
    const { app, monitor } = await serve();
    for (let index = 0; index < 20; index += 1)
      await app.inject({
        url: `/sessions/unknown-${index}/events`,
        headers: { 'x-verity-client': `ios/9.${index}` },
      });
    expect(
      [...monitor.metrics.http.values()].filter((series) => series.statusClass === '4xx'),
    ).toEqual([expect.objectContaining({ client: 'ios', requests: 20 })]);
  });

  // Without the request's own context, every outbound call would read as
  // `background` and the route that causes it could not be found.
  it('attributes outbound calls to the route whose request made them', async () => {
    const upstream = Fastify();
    upstream.get('/data', async () => 'ok');
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = upstream.server.address() as { port: number };
      const instance = Fastify();
      const monitor = createServerMonitor({ store: undefined, version: '9.9.9' });
      installServerMonitoring(instance, monitor);
      instance.get('/projects/:id/status', async () => {
        await (await fetch(`http://127.0.0.1:${port}/data`)).text();
        await (await fetch(`http://127.0.0.1:${port}/data`)).text();
        return 'done';
      });
      await instance.ready();
      app = instance;
      await monitor.control.startDetailMode(15, 'app');
      await instance.inject({ url: '/projects/p-1/status' });
      const { externalCalls, detail } = monitor.report('hashed');
      expect(externalCalls.topCauses).toEqual([
        expect.objectContaining({
          target: 'internal',
          cause: 'GET /projects/:id/status',
          calls: 2,
          duplicates: 1,
        }),
      ]);
      expect(detail?.slowRequests).toEqual([
        expect.objectContaining({ route: '/projects/:id/status', externalCalls: 2 }),
      ]);
    } finally {
      await upstream.close();
    }
  });

  it('accepts only the offered detail durations', async () => {
    const { app } = await serve();
    const response = await app.inject({
      method: 'PATCH',
      url: '/diagnostics/monitoring',
      payload: { detailMode: { minutes: 600 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps stored settings: measurement off survives a restart', async () => {
    let stored = { measurementEnabled: false, detailUntil: null, detailStartedBy: null } as const;
    const store: MonitoringSettingsStore = {
      get: async () => stored,
      setMeasurementEnabled: async (enabled) =>
        (stored = { ...stored, measurementEnabled: enabled } as never),
      setDetailMode: async () => stored,
    };
    const { app, monitor } = await serve({ store });
    await app.inject({ url: '/sessions/s-1/events' });
    expect(monitor.control.measuring).toBe(false);
    expect(report(monitor).availability.requests).toBe(0);
  });

  it('serves the monitoring routes to administrators only', () => {
    for (const [method, url] of [
      ['GET', '/diagnostics/monitoring'],
      ['PATCH', '/diagnostics/monitoring'],
      ['GET', '/diagnostics/report'],
    ] as const)
      expect(pairedRoutePolicy(method, url)).toEqual({ kind: 'administrator' });
  });
});
