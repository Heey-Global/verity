import { describe, expect, it } from 'vitest';
import { earliestMigrationKey, latestMigrationKey, schemaCompatibilityWindow } from '@verity/store';
import {
  SERVER_COMPAT,
  compareSchemaGenerations,
  isCompatible,
  isCompatibleWith,
  parseServerCompat,
  type ServerCompat,
} from './compat.js';

// A baseline build that is compatible with itself. Tests clone + mutate one
// dimension at a time so each assertion isolates a single failure cause.
function baseCompat(overrides: Partial<ServerCompat> = {}): ServerCompat {
  return {
    serverVersion: '1.0.0',
    schema: { min: '0040_a', current: '0045_a', max: '0047_a' },
    runner: { min: 1, current: 2 },
    eventLog: { min: 1, current: 2 },
    gateway: { min: 1, current: 1 },
    updater: { min: 1, current: 1 },
    ...overrides,
  };
}

describe('compareSchemaGenerations', () => {
  it('orders zero-padded migration keys numerically', () => {
    expect(compareSchemaGenerations('0009_x', '0010_x')).toBeLessThan(0);
    expect(compareSchemaGenerations('0047_x', '0046_x')).toBeGreaterThan(0);
    expect(compareSchemaGenerations('0047_x', '0047_x')).toBe(0);
  });
});

describe('isCompatible', () => {
  it('a build is compatible with itself (no reasons)', () => {
    const result = isCompatible(baseCompat(), baseCompat());
    expect(result).toEqual({ compatible: true, reasons: [] });
  });

  it('accepts an N / N-1 protocol pair on every protocol dimension', () => {
    const n = baseCompat({
      serverVersion: '2.0.0',
      runner: { min: 1, current: 2 },
      eventLog: { min: 1, current: 2 },
      gateway: { min: 1, current: 2 },
      updater: { min: 1, current: 2 },
    });
    const nMinus1 = baseCompat({
      serverVersion: '1.0.0',
      runner: { min: 1, current: 1 },
      eventLog: { min: 1, current: 1 },
      gateway: { min: 1, current: 1 },
      updater: { min: 1, current: 1 },
    });
    expect(isCompatible(n, nMinus1).compatible).toBe(true);
    // order-independent
    expect(isCompatible(nMinus1, n).compatible).toBe(true);
  });

  it('rejects a two-version runner gap and names the runner dimension', () => {
    const a = baseCompat({ serverVersion: '3.0.0', runner: { min: 3, current: 3 } });
    const b = baseCompat({ serverVersion: '1.0.0', runner: { min: 1, current: 1 } });
    const result = isCompatible(a, b);
    expect(result.compatible).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/runner protocol mismatch/);
  });

  it('reports each mismatching protocol dimension independently', () => {
    const a = baseCompat({
      serverVersion: 'a',
      runner: { min: 5, current: 5 },
      eventLog: { min: 5, current: 5 },
      gateway: { min: 5, current: 5 },
      updater: { min: 5, current: 5 },
    });
    const b = baseCompat({
      serverVersion: 'b',
      runner: { min: 1, current: 1 },
      eventLog: { min: 1, current: 1 },
      gateway: { min: 1, current: 1 },
      updater: { min: 1, current: 1 },
    });
    const result = isCompatible(a, b);
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /runner protocol mismatch/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /event log protocol mismatch/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /gateway protocol mismatch/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /updater protocol mismatch/.test(r))).toBe(true);
  });

  it('accepts an additive schema move within both build windows', () => {
    // N adds generation 0046; N-1 declares it can still read up to 0046.
    const n = baseCompat({
      serverVersion: '2.0.0',
      schema: { min: '0044_a', current: '0046_a', max: '0046_a' },
    });
    const nMinus1 = baseCompat({
      serverVersion: '1.0.0',
      schema: { min: '0044_a', current: '0045_a', max: '0046_a' },
    });
    expect(isCompatible(n, nMinus1).compatible).toBe(true);
  });

  it('rejects a destructive schema change the rollback build cannot read', () => {
    // Target advances to 0048 but the rollback build tops out at 0046.
    const target = baseCompat({
      serverVersion: '2.0.0',
      schema: { min: '0044_a', current: '0048_a', max: '0048_a' },
    });
    const rollback = baseCompat({
      serverVersion: '1.0.0',
      schema: { min: '0044_a', current: '0046_a', max: '0046_a' },
    });
    const result = isCompatible(target, rollback);
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /destructive schema change/.test(r))).toBe(true);
  });

  it('rejects a schema generation older than a build minimum (dropped support)', () => {
    const modern = baseCompat({
      serverVersion: '2.0.0',
      schema: { min: '0045_a', current: '0047_a', max: '0047_a' },
    });
    const ancient = baseCompat({
      serverVersion: '0.9.0',
      schema: { min: '0040_a', current: '0041_a', max: '0047_a' },
    });
    const result = isCompatible(modern, ancient);
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /older than/.test(r))).toBe(true);
  });

  it('does not emit duplicate reason strings for a symmetric schema failure', () => {
    // Both sides identical and above their own max → the window is probed from
    // both sides against both currents, which would repeat the same sentence.
    const build = baseCompat({
      serverVersion: 'x',
      schema: { min: '0044_a', current: '0048_a', max: '0046_a' },
    });
    const result = isCompatible(build, build);
    expect(result.compatible).toBe(false);
    expect(new Set(result.reasons).size).toBe(result.reasons.length);
  });

  it('aggregates schema AND protocol failures together', () => {
    const a = baseCompat({
      serverVersion: 'a',
      schema: { min: '0046_a', current: '0048_a', max: '0048_a' },
      runner: { min: 4, current: 4 },
    });
    const b = baseCompat({
      serverVersion: 'b',
      schema: { min: '0040_a', current: '0044_a', max: '0045_a' },
      runner: { min: 1, current: 1 },
    });
    const result = isCompatible(a, b);
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /schema/.test(r))).toBe(true);
    expect(result.reasons.some((r) => /runner protocol mismatch/.test(r))).toBe(true);
  });
});

describe('SERVER_COMPAT (baked)', () => {
  it('targets the latest in-code migration key as its current schema generation', () => {
    expect(SERVER_COMPAT.schema.current).toBe(latestMigrationKey());
  });

  it('declares the real store-sourced schema window (earliest..latest), not a degenerate point', () => {
    expect(SERVER_COMPAT.schema).toEqual(schemaCompatibilityWindow());
    expect(SERVER_COMPAT.schema.min).toBe(earliestMigrationKey());
    // A non-degenerate window is what makes an N/N-1 comparison meaningful: the
    // floor is strictly below the current generation once more than one
    // migration exists.
    expect(
      compareSchemaGenerations(SERVER_COMPAT.schema.min, SERVER_COMPAT.schema.current),
    ).toBeLessThan(0);
  });

  it('has coherent windows (min <= current <= max on every dimension)', () => {
    expect(
      compareSchemaGenerations(SERVER_COMPAT.schema.min, SERVER_COMPAT.schema.current),
    ).toBeLessThanOrEqual(0);
    expect(
      compareSchemaGenerations(SERVER_COMPAT.schema.current, SERVER_COMPAT.schema.max),
    ).toBeLessThanOrEqual(0);
    for (const range of [
      SERVER_COMPAT.runner,
      SERVER_COMPAT.eventLog,
      SERVER_COMPAT.gateway,
      SERVER_COMPAT.updater,
    ]) {
      expect(range.min).toBeLessThanOrEqual(range.current);
    }
  });

  it('is compatible with itself', () => {
    expect(isCompatible(SERVER_COMPAT, SERVER_COMPAT).compatible).toBe(true);
  });
});

describe('schema window boundaries', () => {
  // A build with a wide, fixed window; peers move a single generation across each
  // edge so every assertion isolates one boundary. The peer's [min, max] always
  // contains BOTH currents so only the build-under-test's window is exercised.
  const build = baseCompat({
    serverVersion: 'build',
    schema: { min: '0044_a', current: '0046_a', max: '0048_a' },
  });
  const peerAt = (current: string): ServerCompat =>
    baseCompat({ serverVersion: 'peer', schema: { min: '0040_a', current, max: '0099_a' } });

  it('accepts a peer exactly at the window minimum', () => {
    expect(isCompatible(build, peerAt('0044_a')).compatible).toBe(true);
  });

  it('accepts a peer exactly at the window maximum', () => {
    expect(isCompatible(build, peerAt('0048_a')).compatible).toBe(true);
  });

  it('rejects a peer one generation below the window minimum (dropped support)', () => {
    const result = isCompatible(build, peerAt('0043_a'));
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /older than/.test(r))).toBe(true);
  });

  it('rejects a peer one generation above the window maximum (destructive)', () => {
    const result = isCompatible(build, peerAt('0049_a'));
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /destructive schema change/.test(r))).toBe(true);
  });
});

describe('isCompatibleWith', () => {
  it('compares a peer against the baked SERVER_COMPAT and matches isCompatible order-independently', () => {
    const peer = baseCompat({
      serverVersion: 'peer',
      schema: {
        min: earliestMigrationKey(),
        current: SERVER_COMPAT.schema.current,
        max: SERVER_COMPAT.schema.max,
      },
      runner: SERVER_COMPAT.runner,
      eventLog: SERVER_COMPAT.eventLog,
      gateway: SERVER_COMPAT.gateway,
      updater: SERVER_COMPAT.updater,
    });
    expect(isCompatibleWith(peer)).toEqual(isCompatible(SERVER_COMPAT, peer));
    expect(isCompatibleWith(peer).compatible).toBe(true);
  });

  it('reports an incompatible peer (a two-version runner gap)', () => {
    const peer = baseCompat({
      serverVersion: 'peer',
      schema: SERVER_COMPAT.schema,
      runner: { min: SERVER_COMPAT.runner.current + 2, current: SERVER_COMPAT.runner.current + 2 },
    });
    const result = isCompatibleWith(peer);
    expect(result.compatible).toBe(false);
    expect(result.reasons.some((r) => /runner protocol mismatch/.test(r))).toBe(true);
  });
});

describe('parseServerCompat', () => {
  it('round-trips the baked SERVER_COMPAT through JSON', () => {
    const decoded: unknown = JSON.parse(JSON.stringify(SERVER_COMPAT));
    expect(parseServerCompat(decoded)).toEqual(SERVER_COMPAT);
  });

  it('rejects non-objects and null', () => {
    expect(parseServerCompat(null)).toBeNull();
    expect(parseServerCompat('nope')).toBeNull();
    expect(parseServerCompat(42)).toBeNull();
  });

  it('rejects a payload with a malformed schema range', () => {
    const bad = {
      ...JSON.parse(JSON.stringify(SERVER_COMPAT)),
      schema: { min: 1, current: 2, max: 3 },
    };
    expect(parseServerCompat(bad)).toBeNull();
  });

  it('rejects a payload with a non-integer protocol version', () => {
    const bad = {
      ...JSON.parse(JSON.stringify(SERVER_COMPAT)),
      runner: { min: 1, current: 1.5 },
    };
    expect(parseServerCompat(bad)).toBeNull();
  });

  it('rejects a payload missing a required dimension', () => {
    const bad = JSON.parse(JSON.stringify(SERVER_COMPAT));
    delete bad.updater;
    expect(parseServerCompat(bad)).toBeNull();
  });

  it('feeds a parsed peer straight into isCompatibleWith', () => {
    // The intended flow: fetch /server/compat as JSON, validate, then compare.
    const peer = parseServerCompat(JSON.parse(JSON.stringify(SERVER_COMPAT)));
    expect(peer).not.toBeNull();
    expect(isCompatibleWith(peer as ServerCompat).compatible).toBe(true);
  });
});
