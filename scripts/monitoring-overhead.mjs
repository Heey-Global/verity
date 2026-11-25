#!/usr/bin/env node
// Measures what server monitoring (docs/adr/0032-server-metrics-and-diagnostics.md)
// costs: per-request latency over a real socket with measurement off, on and in
// detail mode, and the memory of fully populated counters.
//
//   npx tsc -b packages/server && node --expose-gc scripts/monitoring-overhead.mjs
//
// Results vary with the machine; compare the modes within one run, not across runs.
import Fastify from 'fastify';
import { Buffer } from 'node:buffer';
import { Agent, request } from 'node:http';

// The built modules run; CI lints before any package is built, so the script
// declares the part it uses itself (as scripts/inventory-agent-tools.mjs does).
/**
 * @typedef {{ method: string, route: string, client: string, status: number,
 *   durationMs: number, bytesIn: number, bytesOut: number, sessionId: string | null,
 *   requestId: string }} HttpObservation
 * @typedef {{
 *   control: {
 *     setMeasurementEnabled(enabled: boolean): Promise<unknown>,
 *     startDetailMode(minutes: 15 | 60 | 240, startedBy: 'app' | 'control'): Promise<unknown>,
 *     stopDetailMode(): Promise<unknown>,
 *   },
 *   metrics: {
 *     recordHttp(observation: HttpObservation, detail: boolean): void,
 *     http: Map<string, unknown>,
 *     sessions: Map<string, unknown>,
 *   },
 *   report(sessionIds: 'hashed' | 'raw'): unknown,
 * }} ServerMonitor
 */
/**
 * @typedef {{
 *   createServerMonitor: (options: { store: undefined, version: string }) => ServerMonitor,
 *   installServerMonitoring: (app: import('fastify').FastifyInstance, monitor: ServerMonitor) => void,
 * }} MonitorModule
 * @typedef {{ MAX_HTTP_SERIES: number, MAX_SESSIONS: number }} MetricsModule
 */
const monitorPath = '../packages/server/dist/metrics/server-monitor.js';
const metricsPath = '../packages/server/dist/metrics/server-metrics.js';
const monitorModule = /** @type {unknown} */ (await import(monitorPath));
const metricsModule = /** @type {unknown} */ (await import(metricsPath));
const { createServerMonitor, installServerMonitoring } = /** @type {MonitorModule} */ (
  monitorModule
);
const { MAX_HTTP_SERIES, MAX_SESSIONS } = /** @type {MetricsModule} */ (metricsModule);

const ROUNDS = Number(process.env.ROUNDS ?? 6);
const PER_ROUND = Number(process.env.PER_ROUND ?? 3000);
const BODY = JSON.stringify({ items: 'x'.repeat(2_000) });

/** @typedef {'off' | 'on' | 'detail'} Mode */
/** @typedef {{ meanUs: number, p50Us: number, p99Us: number }} Timing */

/** @param {number[]} sorted @param {number} q @returns {number} */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** @returns {Promise<Record<Mode, Timing>>} */
async function latency() {
  const monitor = createServerMonitor({ store: undefined, version: 'bench' });
  const app = Fastify({ logger: false });
  installServerMonitoring(app, monitor);
  app.get('/sessions/:id/events', () => Promise.resolve(BODY));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  /** @returns {Promise<number>} */
  const once = () =>
    new Promise((resolve, reject) => {
      const started = process.hrtime.bigint();
      const req = request(
        {
          port,
          host: '127.0.0.1',
          path: '/sessions/s-1/events',
          agent,
          headers: { 'x-verity-client': 'ios/1.95.4' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(Number(process.hrtime.bigint() - started) / 1e3));
        },
      );
      req.on('error', reject);
      req.end();
    });
  /** @type {Record<Mode, () => Promise<void>>} */
  const modes = {
    off: async () => {
      await monitor.control.setMeasurementEnabled(false);
    },
    on: async () => {
      await monitor.control.setMeasurementEnabled(true);
      await monitor.control.stopDetailMode();
    },
    detail: async () => {
      await monitor.control.setMeasurementEnabled(true);
      await monitor.control.startDetailMode(15, 'app');
    },
  };
  /** @type {Record<Mode, number[]>} */
  const samples = { off: [], on: [], detail: [] };
  /** @type {Mode[]} */
  const order = ['off', 'on', 'detail'];
  for (let i = 0; i < 2_000; i++) await once(); // warm-up
  // Interleaved rounds, so drift of the machine affects every mode alike.
  for (let round = 0; round < ROUNDS; round++) {
    for (const mode of order) {
      await modes[mode]();
      for (let i = 0; i < PER_ROUND; i++) samples[mode].push(await once());
    }
  }
  agent.destroy();
  await app.close();
  /** @type {Record<Mode, Timing>} */
  const result = {
    off: { meanUs: 0, p50Us: 0, p99Us: 0 },
    on: { meanUs: 0, p50Us: 0, p99Us: 0 },
    detail: { meanUs: 0, p50Us: 0, p99Us: 0 },
  };
  for (const mode of order) {
    const values = samples[mode];
    values.sort((a, b) => a - b);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    result[mode] = {
      meanUs: Math.round(mean),
      p50Us: Math.round(quantile(values, 0.5)),
      p99Us: Math.round(quantile(values, 0.99)),
    };
  }
  return result;
}

function heap() {
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}

function memory() {
  const monitor = createServerMonitor({ store: undefined, version: 'bench' });
  const before = heap();
  // Every series the caps allow: distinct routes per client and status class,
  // and the maximum number of tracked sessions.
  for (let i = 0; i < MAX_HTTP_SERIES + 100; i++) {
    monitor.metrics.recordHttp(
      {
        method: 'GET',
        route: `/route-${i}/:id`,
        client: 'ios/1.95.4',
        status: 200,
        durationMs: i % 500,
        bytesIn: 0,
        bytesOut: 2_000,
        sessionId: `session-${i % (MAX_SESSIONS + 50)}`,
        requestId: `req-${i}`,
      },
      true,
    );
  }
  for (let i = 0; i < MAX_SESSIONS + 50; i++)
    monitor.metrics.recordHttp(
      {
        method: 'GET',
        route: '/sessions/:id/events',
        client: 'ios/1.95.4',
        status: 200,
        durationMs: 3,
        bytesIn: 0,
        bytesOut: 2_000,
        sessionId: `other-session-${i}`,
        requestId: `req-s-${i}`,
      },
      true,
    );
  const filled = heap();
  const reportBytes = Buffer.byteLength(JSON.stringify(monitor.report('hashed')));
  return {
    series: monitor.metrics.http.size,
    sessions: monitor.metrics.sessions.size,
    counterHeapMB: Math.round(((filled - before) / 1e6) * 10) / 10,
    reportKB: Math.round(reportBytes / 100) / 10,
    gcExposed: typeof globalThis.gc === 'function',
  };
}

const lat = await latency();
/** @param {Mode} mode */
const overhead = (mode) =>
  `${(((lat[mode].meanUs - lat.off.meanUs) / lat.off.meanUs) * 100).toFixed(1)} %`;
console.log(
  JSON.stringify(
    {
      node: process.version,
      requestsPerMode: ROUNDS * PER_ROUND,
      latency: lat,
      meanOverhead: { on: overhead('on'), detail: overhead('detail') },
      memory: memory(),
    },
    null,
    2,
  ),
);
