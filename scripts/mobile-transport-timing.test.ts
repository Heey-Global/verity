import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
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

// The tunnel typecheck must include the actual provider of the delegate's timing type.
it('includes the delegate timing dependency in all native probe compilation units', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/mobile-native-verify.yml', import.meta.url), 'utf8'),
  ) as {
    jobs: Record<string, { steps?: { run?: string }[] }>;
  };
  const command = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find(
      (step) =>
        step.run?.includes('swiftc -typecheck') &&
        step.run.includes('CertificatePinDelegate.swift'),
    )?.run;
  expect(command).toBeDefined();
  const dependency = delegate.match(/var transportTiming: (\w+)/u)?.[1];
  expect(dependency).toBeDefined();
  const native = new URL('../apps/mobile/native/', import.meta.url);
  const provider = readdirSync(native)
    .filter((file) => file.endsWith('.swift'))
    .find((file) =>
      new RegExp(`(?:class|struct|enum) ${dependency}\\b`, 'u').test(
        readFileSync(new URL(file, native), 'utf8'),
      ),
    );
  expect(provider).toBeDefined();
  expect(command?.split('xcrun swiftc -parse-as-library')[0]).toContain(
    `apps/mobile/native/${provider}`,
  );
  const scriptRoot = new URL('../scripts/', import.meta.url);
  for (const file of readdirSync(scriptRoot, { recursive: true })) {
    if (typeof file !== 'string' || !file.endsWith('.sh')) continue;
    const text = readFileSync(new URL(file, scriptRoot), 'utf8');
    // Source arrays feed both simulator and macOS compilers; inspect each unit.
    const units = [...text.matchAll(/(?:swiftc|sources=\()[\s\S]*?(?=\n[^ \t]|$)/gu)];
    for (const [unit] of units) {
      if (unit.includes('apps/mobile/native/CertificatePinDelegate.swift'))
        expect(unit, file).toContain(`apps/mobile/native/${provider}`);
    }
  }
});
