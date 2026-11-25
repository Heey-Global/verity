import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerTrafficLedger, TrafficLedger } from './traffic-ledger.js';

describe('TrafficLedger', () => {
  it('totals responses per route pattern without recording raw URLs', async () => {
    const reports: object[] = [];
    const ledger = new TrafficLedger((summary) => reports.push(summary), 60_000);
    const app = Fastify();
    registerTrafficLedger(app, ledger);
    app.get('/sessions/:id/branches', async () => ({ branches: ['main'] }));
    // Like conditionalJsonOnSend: a route-level hook empties a serialized body.
    app.get(
      '/cached',
      {
        onSend: (_request, reply, _payload, done) => {
          reply.code(304);
          done(null, '');
        },
      },
      async () => ({ large: 'x'.repeat(1_000) }),
    );
    await app.ready();
    await app.inject({ method: 'GET', url: '/sessions/secret-id/branches' });
    await app.inject({ method: 'GET', url: '/sessions/other/branches' });
    await app.inject({ method: 'GET', url: '/cached' });

    const entries = ledger.drain();
    const branches = entries.find((entry) => entry.key === 'GET /sessions/:id/branches');
    expect(branches?.tally).toMatchObject({
      count: 2,
      bodyBytes: 2 * Buffer.byteLength('{"branches":["main"]}'),
      notModified: 0,
    });
    expect(entries.find((entry) => entry.key === 'GET /cached')?.tally).toMatchObject({
      notModified: 1,
      bodyBytes: 0,
    });
    expect(JSON.stringify(entries)).not.toContain('secret-id');
    // Draining starts a new window.
    expect(ledger.drain()).toEqual([]);
    await app.close();
  });

  it('reports the largest totals and stays quiet for an empty window', () => {
    const reports: { top: { key: string }[] }[] = [];
    const ledger = new TrafficLedger(
      (summary) => reports.push(summary as { top: { key: string }[] }),
      60_000,
    );
    ledger.report();
    expect(reports).toHaveLength(0);
    ledger.record('WS live event', { bodyBytes: 10 });
    ledger.record('GET /sessions', { bodyBytes: 5_000 });
    ledger.report();
    expect(reports[0]?.top.map((entry) => entry.key)).toEqual(['GET /sessions', 'WS live event']);
  });
});
