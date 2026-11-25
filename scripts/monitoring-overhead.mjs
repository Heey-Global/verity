#!/usr/bin/env node
// Measures what server monitoring (docs/adr/0032-server-metrics-and-diagnostics.md)
// costs: per-request latency over a real socket with measurement off, on and in
// detail mode, and the memory of fully populated counters.
//
//   npx tsc -b packages/server && node --expose-gc scripts/monitoring-overhead.mjs
//
// Results vary with the machine; compare the modes within one run, not across runs.
import Fastify from 'fastify';
import { request } from 'node:http';
import { Agent } from 'node:http';

import {
  createServerMonitor,
  installServerMonitoring,
} from '../packages/server/dist/metrics/server-monitor.js';
import { MAX_HTTP_SERIES, MAX_SESSIONS } from '../packages/server/dist/metrics/server-metrics.js';

const ROUNDS = Number(process.env.ROUNDS ?? 6);
const PER_ROUND = Number(process.env.PER_ROUND ?? 3000);
const BODY = JSON.stringify({ items: 'x'.repeat(2_000) });

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function latency() {
  const monitor = createServerMonitor({ store: undefined, version: 'bench' });
  const app = Fastify({ logger: false });
  installServerMonitoring(app, monitor);
  app.get('/sessions/:id/events', async () => BODY);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
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
  const modes = {
    off: async () => monitor.control.setMeasurementEnabled(false),
    on: async () => {
      await monitor.control.setMeasurementEnabled(true);
      await monitor.control.stopDetailMode();
    },
    detail: async () => {
      await monitor.control.setMeasurementEnabled(true);
      await monitor.control.startDetailMode(15, 'app');
    },
  };
  const samples = { off: [], on: [], detail: [] };
  for (let i = 0; i < 2_000; i++) await once(); // warm-up
  // Interleaved rounds, so drift of the machine affects every mode alike.
  for (let round = 0; round < ROUNDS; round++) {
    for (const [mode, enter] of Object.entries(modes)) {
      await enter();
      for (let i = 0; i < PER_ROUND; i++) samples[mode].push(await once());
    }
  }
  agent.destroy();
  await app.close();
  const result = {};
  for (const [mode, values] of Object.entries(samples)) {
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
