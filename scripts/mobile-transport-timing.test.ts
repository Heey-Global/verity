import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) =>
  readFileSync(new URL(`../apps/mobile/native/${name}.swift`, import.meta.url), 'utf8');
const pool = source('PinnedHTTPSessionPool');
const transport = source('VerityPinnedTransport');
const delegate = source('CertificatePinDelegate');

describe('native switch transport diagnostic contract', () => {
  it('only retains validated opaque request correlations', () => {
    // A missed gate silently retains diagnostic records for every native request.
    const gate = pool.match(/init\?\(headers:[\s\S]*?fields =/u)?.[0];
    expect(gate).toBeDefined();
    expect(gate).toContain('x-verity-switch-request');
    expect(gate).toContain('^[a-z0-9-]{1,80}$');
    expect(gate).toContain('else { return nil }');
    expect(transport).toContain('if let timing { transportTimings.retain(timing) }');
  });

  it('bounds retries and metrics without collapsing requests with the same correlation', () => {
    const registry = pool.slice(pool.indexOf('final class PinnedTransportTimingRegistry'));
    const cap = Number(registry.match(/records.count > (\d+)/u)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(32);
    expect(registry).toContain('records.append(record)');
    expect(registry).toContain('omitted += excess');
    expect(registry).toContain('records.removeFirst(excess)');
    expect(registry).toContain('"omitted": dropped');
    const transactionCap = Number(pool.match(/transactionMetrics.suffix\((\d+)\)/u)?.[1]);
    expect(transactionCap).toBeGreaterThan(0);
    expect(transactionCap).toBeLessThanOrEqual(4);
    expect(pool).toContain('"transactionsTruncated"');
  });

  it('captures native completion before continuation and metrics independently', () => {
    const complete = transport.indexOf('timing?.completed(error: error)');
    const continuation = transport.indexOf('continuation.resume(throwing: error)');
    expect(complete).toBeGreaterThan(0);
    expect(complete).toBeLessThan(continuation);
    expect(delegate).toContain('transportTiming?.collected(metrics)');
    expect(pool).toContain('"metricsAvailable": false');
    expect(pool).toContain('fields["metricsAvailable"] = true');
    expect(transport).toContain('Function("exportTransportTimings")');
    expect(transport.indexOf('timing.responseReady()')).toBeGreaterThan(
      transport.indexOf('var result = pinnedHTTPResponse'),
    );
  });
});
