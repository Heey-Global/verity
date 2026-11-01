import { describe, expect, it } from 'vitest';
import { resolveSandboxMemory, parseOomScoreAdj } from './sandbox-memory-policy.js';
const GIB = 1024 ** 3;
describe('elastic sandbox memory', () => {
  it.each([8, 16, 32])('derives the hard ceiling from a %i GiB Docker host', (size) => {
    expect(resolveSandboxMemory({ hostMemoryBytes: size * GIB })).toEqual({
      memoryBytes: (size - 4) * GIB,
      memoryReservationBytes: 4 * GIB,
    });
  });
  it('uses a bounded fallback when Docker capacity is unavailable', () => {
    expect(resolveSandboxMemory({})).toEqual({
      memoryBytes: 6 * GIB,
      memoryReservationBytes: 4 * GIB,
    });
  });
  it('supports explicit ceilings and configurable host reserve and reservation', () => {
    expect(
      resolveSandboxMemory({
        hostMemoryBytes: 16 * GIB,
        hostReserveBytes: 6 * GIB,
        reservationBytes: 3 * GIB,
      }),
    ).toEqual({ memoryBytes: 10 * GIB, memoryReservationBytes: 3 * GIB });
    expect(resolveSandboxMemory({ hostMemoryBytes: 16 * GIB, memoryBytes: 7 * GIB })).toEqual({
      memoryBytes: 7 * GIB,
      memoryReservationBytes: 4 * GIB,
    });
  });
  it('clamps only the default reservation on small hosts', () => {
    expect(resolveSandboxMemory({ hostMemoryBytes: 6 * GIB }).memoryReservationBytes).toBe(2 * GIB);
    expect(() => resolveSandboxMemory({ hostMemoryBytes: 4 * GIB })).toThrow(/must fit/);
    expect(() => resolveSandboxMemory({ memoryBytes: 2 * GIB, reservationBytes: 4 * GIB })).toThrow(
      /must not exceed/,
    );
    expect(() => resolveSandboxMemory({ hostMemoryBytes: 8 * GIB, memoryBytes: 9 * GIB })).toThrow(
      /must fit/,
    );
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid byte values: %s', (value) => {
    for (const name of ['hostMemoryBytes', 'memoryBytes', 'reservationBytes', 'hostReserveBytes'])
      expect(() => resolveSandboxMemory({ [name]: value })).toThrow();
  });
  it('validates OOM preferences including explicit zero', () => {
    expect(parseOomScoreAdj('0')).toBe(0);
    expect(parseOomScoreAdj('-250')).toBe(-250);
    expect(parseOomScoreAdj(undefined)).toBeUndefined();
    for (const value of ['1001', '-1001', '1.5', 'bad'])
      expect(() => parseOomScoreAdj(value)).toThrow();
  });
});
