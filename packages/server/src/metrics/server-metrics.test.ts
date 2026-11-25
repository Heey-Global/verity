import { describe, expect, it } from 'vitest';
import { LatencyHistogram } from './latency-histogram.js';
import {
  MAX_HTTP_SERIES,
  MAX_LIVE_CLIENTS,
  MAX_SESSIONS,
  MAX_SLOW_REQUESTS,
  OVERFLOW_ROUTE,
  ServerMetrics,
  type HttpObservation,
} from './server-metrics.js';

const request = (overrides: Partial<HttpObservation> = {}): HttpObservation => ({
  method: 'GET',
  route: '/sessions',
  client: 'ios/1.0',
  status: 200,
  durationMs: 12,
  bytesIn: 0,
  bytesOut: 1_000,
  sessionId: null,
  requestId: 'req-1',
  ...overrides,
});

describe('LatencyHistogram', () => {
  it('estimates quantiles inside the bucket that holds them', () => {
    const histogram = new LatencyHistogram();
    for (let index = 0; index < 90; index += 1) histogram.observe(20);
    for (let index = 0; index < 10; index += 1) histogram.observe(800);
    expect(histogram.quantile(0.5)).toBeLessThanOrEqual(25);
    expect(histogram.quantile(0.5)).toBeGreaterThan(10);
    expect(histogram.quantile(0.99)).toBeGreaterThan(500);
    expect(histogram.quantile(0.99)).toBeLessThanOrEqual(800);
  });

  it('has no quantile without samples', () => {
    expect(new LatencyHistogram().quantile(0.95)).toBeNull();
  });
});

describe('ServerMetrics', () => {
  it('adds requests of one route, client and status class into one series', () => {
    const metrics = new ServerMetrics();
    metrics.recordHttp(request(), false);
    metrics.recordHttp(request({ status: 204, bytesOut: 0 }), false);
    metrics.recordHttp(request({ status: 503 }), false);
    const series = [...metrics.http.values()];
    expect(series).toHaveLength(2);
    expect(series.find((entry) => entry.statusClass === '2xx')).toMatchObject({
      requests: 2,
      bytesOut: 1_000,
    });
  });

  // Without the cap, every distinct label combination is another series held
  // for the life of the process.
  it('folds series past the cap into one overflow route', () => {
    const metrics = new ServerMetrics();
    for (let index = 0; index < MAX_HTTP_SERIES + 10; index += 1)
      metrics.recordHttp(request({ route: `/r${index}` }), false);
    expect(metrics.http.size).toBe(MAX_HTTP_SERIES + 1);
    expect(
      [...metrics.http.values()].find((entry) => entry.route === OVERFLOW_ROUTE)?.requests,
    ).toBe(10);
  });

  // A client chooses its own version label; folding only the route would still
  // let it mint one overflow series per invented version and grow the heap.
  it('keeps one overflow series however the labels vary past the cap', () => {
    const metrics = new ServerMetrics();
    for (let index = 0; index < MAX_HTTP_SERIES; index += 1)
      metrics.recordHttp(request({ route: `/r${index}` }), false);
    for (let index = 0; index < 500; index += 1)
      metrics.recordHttp(
        request({ route: `/x${index}`, client: `ios/1.${index}`, status: 200 + (index % 400) }),
        false,
      );
    expect(metrics.http.size).toBe(MAX_HTTP_SERIES + 1);
  });

  it('caps live connections per client label', () => {
    const metrics = new ServerMetrics();
    for (let index = 0; index < MAX_LIVE_CLIENTS + 30; index += 1)
      metrics.liveOpened(`ios/2.${index}`);
    expect(metrics.live.size).toBe(MAX_LIVE_CLIENTS + 1);
  });

  it('tracks a bounded number of sessions and counts the ones it leaves out', () => {
    const metrics = new ServerMetrics();
    for (let index = 0; index < MAX_SESSIONS + 3; index += 1)
      metrics.recordHttp(request({ sessionId: `s${index}` }), false);
    expect(metrics.sessions.size).toBe(MAX_SESSIONS);
    expect(metrics.droppedSessions).toBe(3);
  });

  it('keeps the slowest requests only in detail mode', () => {
    const metrics = new ServerMetrics();
    metrics.recordHttp(request({ durationMs: 9_000 }), false);
    expect(metrics.slowRequests).toEqual([]);
    for (let index = 0; index < MAX_SLOW_REQUESTS + 5; index += 1)
      metrics.recordHttp(request({ durationMs: index, requestId: `r${index}` }), true);
    expect(metrics.slowRequests).toHaveLength(MAX_SLOW_REQUESTS);
    expect(metrics.slowRequests[0]?.requestId).toBe(`r${MAX_SLOW_REQUESTS + 4}`);
  });

  it('counts live connections, reconnects and frames per client', () => {
    const metrics = new ServerMetrics();
    metrics.liveOpened('ios');
    metrics.liveFrame('ios', 'out', 300);
    metrics.liveClosed('ios', 1_000);
    metrics.liveOpened('ios');
    expect(metrics.live.get('ios')).toMatchObject({
      opened: 2,
      active: 1,
      framesOut: 1,
      bytesOut: 300,
      longestMs: 1_000,
    });
  });

  it('starts over on reset', () => {
    const metrics = new ServerMetrics();
    metrics.recordHttp(request({ sessionId: 's' }), true);
    metrics.reset();
    expect([metrics.http.size, metrics.sessions.size, metrics.slowRequests.length]).toEqual([
      0, 0, 0,
    ]);
  });
});
